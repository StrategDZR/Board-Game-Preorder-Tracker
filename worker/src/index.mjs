const CURRENCIES = ['EUR', 'USD', 'RSD', 'GBP'];
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_CATALOG_BYTES = 1_000_000;
const MAX_SOURCE_BYTES = 1_000_000;
const BURST_LIMITS = { import: 12, read: 60, write: 30 };
const bursts = new Map();

// Best-effort protection per isolate. Cloudflare enforces the account-wide Free quotas.
function burstRetryAfter(operation, now = Date.now()) {
  const current = bursts.get(operation);
  if (!current || now >= current.until) {
    bursts.set(operation, { until: now + 60_000, count: 1 });
    return 0;
  }
  if (current.count < BURST_LIMITS[operation]) {
    current.count++;
    return 0;
  }
  return Math.ceil((current.until - now) / 1000);
}

class BodyTooLarge extends Error {}

async function readText(message, limit) {
  const reader = message.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

function campaign(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?projects\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (!match || !SLUG.test(match[1]) || !SLUG.test(match[2])) return null;
  const [, creator, slug] = match;
  if (['gamefound.com', 'www.gamefound.com'].includes(url.hostname)) {
    return { platform: 'Gamefound', creator, slug, url: `https://gamefound.com/en/projects/${creator}/${slug}` };
  }
  if (['kickstarter.com', 'www.kickstarter.com'].includes(url.hostname)) {
    return { platform: 'Kickstarter', url: `https://www.kickstarter.com/projects/${creator}/${slug}` };
  }
  return null;
}

function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : '';
}

function httpsImage(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function upstream(url, accept, timeout = 10_000) {
  return fetch(url, { redirect: 'manual', headers: { accept }, signal: AbortSignal.timeout(timeout) });
}

async function importGamefound(project) {
  const api = new URL('https://gamefound.com/api/public/projects/getCrowdfundingProject');
  api.searchParams.set('urlName', project.slug);
  const response = await upstream(api, 'application/json');
  if (!response.ok) return null;
  const data = JSON.parse(await readText(response, MAX_SOURCE_BYTES));
  if (data.projectUrlName?.toLowerCase() !== project.slug.toLowerCase() ||
      data.creatorUrlName?.toLowerCase() !== project.creator.toLowerCase()) return null;
  return {
    name: clean(data.projectName, 300),
    cover: httpsImage(data.projectImageUrl, project.url),
    description: clean(data.shortDescription, 5000),
    publisher: clean(data.creatorName, 300),
    campaignStart: date(data.campaignStartDate),
    campaignEnd: date(data.campaignEndDate),
    currency: CURRENCIES.includes(data.currencyShortName) ? data.currencyShortName : ''
  };
}

async function importKickstarter(project) {
  let reason = 'виджет не ответил';
  try {
    const response = await upstream(`${project.url}/widget/card.html`, 'text/html', 4_000);
    reason = response.ok ? 'в виджете нет метаданных' : `виджет вернул HTTP ${response.status}`;
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const data = await readKickstarterWidget(response, project);
      if (data?.name) return data;
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Try the public metadata endpoint after a widget failure.
  }

  const api = new URL('https://api.microlink.io/');
  api.searchParams.set('url', project.url);
  const response = await upstream(api, 'application/json');
  if (response.status === 429) {
    return { rateLimited: true };
  }
  if (!response.ok) return null;
  const { status, data } = JSON.parse(await readText(response, MAX_SOURCE_BYTES));
  if (status !== 'success' || campaign(data?.url)?.url !== project.url) return null;
  return {
    name: clean(data.title, 300),
    cover: httpsImage(data.image?.url, project.url),
    description: clean(data.description, 5000),
    publisher: clean(data.author, 300),
    sourceNote: `Источник: Microlink, ${reason}. Поля без подтверждённых данных оставлены пустыми.`
  };
}

async function readKickstarterWidget(response, project) {
  const html = await readText(response, MAX_SOURCE_BYTES);
  const embedded = html.match(/^\s*window\.ksr_track_properties\s*=\s*(\{[^\r\n]+\});\s*$/m);
  if (!embedded) return null;
  const data = JSON.parse(embedded[1]).project;
  if (!data) return null;
  return {
    name: clean(data.project_name, 300),
    cover: httpsImage(data.project_photo_full, project.url),
    description: clean(data.project_blurb, 5000),
    publisher: clean(data.project_creator_name, 300),
    campaignStart: date(data.project_launched_at),
    campaignEnd: date(data.project_deadline),
    currency: CURRENCIES.includes(data.project_currency) ? data.project_currency : ''
  };
}

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
let googleKeys = new Map();
let googleKeysExpire = 0;

function googleConfigured(env) {
  return /^[\w-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID || '') &&
    /^[a-z0-9.]+@gmail\.com$/i.test(env.GOOGLE_OWNER_EMAIL || '');
}

function decodeBase64Url(part) {
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

async function googleKey(id) {
  if (Date.now() >= googleKeysExpire) {
    const response = await upstream(GOOGLE_CERTS, 'application/json', 5_000);
    if (!response.ok) throw new Error('Google public keys unavailable');
    const { keys } = JSON.parse(await readText(response, 32_000));
    if (!Array.isArray(keys)) throw new Error('Invalid Google public keys');
    const usable = keys.filter(key => key.kty === 'RSA' && key.use === 'sig' &&
      (!key.alg || key.alg === 'RS256') && typeof key.kid === 'string');
    if (!usable.length) throw new Error('Missing Google public keys');
    const entries = await Promise.all(usable.map(async key => [
      key.kid, await crypto.subtle.importKey('jwk', key, GOOGLE_ALGORITHM, false, ['verify'])
    ]));
    const maxAge = Number(response.headers.get('cache-control')?.match(/\bmax-age=(\d+)/i)?.[1] || 0);
    googleKeys = new Map(entries);
    googleKeysExpire = Date.now() + Math.min(maxAge, 3600) * 1000;
  }
  return googleKeys.get(id);
}

async function authorized(request, env) {
  const authorization = request.headers.get('authorization') || '';
  if (authorization.length > 8192) return false;
  const match = authorization.match(/^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/);
  if (!match) return false;
  const [, encodedHeader, encodedClaims, encodedSignature] = match;
  let header;
  let claims;
  let signature;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    header = JSON.parse(decoder.decode(decodeBase64Url(encodedHeader)));
    claims = JSON.parse(decoder.decode(decodeBase64Url(encodedClaims)));
    signature = decodeBase64Url(encodedSignature);
  } catch { return false; }
  const now = Math.floor(Date.now() / 1000);
  if (header?.alg !== 'RS256' || header.crit !== undefined ||
      typeof header.kid !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(header.kid) ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(claims?.iss) ||
      claims.aud !== env.GOOGLE_CLIENT_ID || (claims.azp !== undefined && claims.azp !== env.GOOGLE_CLIENT_ID) ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
      !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.iat >= claims.exp ||
      typeof claims.sub !== 'string' || !claims.sub || claims.email_verified !== true ||
      typeof claims.email !== 'string' || claims.email.toLowerCase() !== env.GOOGLE_OWNER_EMAIL.toLowerCase()) return false;
  const key = await googleKey(header.kid);
  return !!key && await crypto.subtle.verify(GOOGLE_ALGORITHM.name, key, signature,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
}

async function catalogWithCacheKey(db) {
  let row = await db.prepare(
    'SELECT revision, games, key_hex FROM catalog LEFT JOIN catalog_cache_key USING (id) WHERE catalog.id = 1'
  ).first();
  if (row && !row.key_hex) {
    const randomKey = Array.from(crypto.getRandomValues(new Uint8Array(32)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    await db.prepare('INSERT INTO catalog_cache_key (id, key_hex) VALUES (1, ?) ON CONFLICT (id) DO NOTHING')
      .bind(randomKey).run();
    row = await db.prepare(
      'SELECT revision, games, key_hex FROM catalog JOIN catalog_cache_key USING (id) WHERE catalog.id = 1'
    ).first();
  }
  if (!row || !/^[a-f\d]{64}$/.test(row.key_hex)) throw new Error('Missing catalog encryption key');
  return { revision: row.revision, games: JSON.parse(row.games), cacheKey: row.key_hex };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.SITE_ORIGINS || '').split(',').map(value => value.trim());
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
    if (origin && !allowed.includes(origin)) return json({ error: 'Сайт не разрешён настройками Worker.' }, 403);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, PUT, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (!['/api/auth-config', '/api/import', '/api/catalog'].includes(url.pathname)) return json({ error: 'Маршрут не найден.' }, 404);
    if (!googleConfigured(env)) return json({ error: 'Вход через Google пока не настроен.' }, 503);
    if (url.pathname === '/api/auth-config' && request.method === 'GET') {
      return json({ clientId: env.GOOGLE_CLIENT_ID });
    }
    try {
      if (!await authorized(request, env)) return json({ error: 'Войдите через разрешённый Google-аккаунт. Если сессия истекла, войдите повторно.' }, 401);
    } catch {
      return json({ error: 'Проверка входа Google временно недоступна. Повторите позже.' }, 503);
    }
    let operation;
    if (request.method === 'GET') operation = url.pathname === '/api/import' ? 'import' : 'read';
    if (request.method === 'PUT' && url.pathname === '/api/catalog') operation = 'write';
    if (!operation) return json({ error: 'Метод не поддерживается.' }, 405);
    const retryAfter = burstRetryAfter(operation);
    if (retryAfter) {
      return json({ error: `Слишком много запросов. Повторите через ${retryAfter} сек.` },
        429, { 'Retry-After': String(retryAfter) });
    }

    if (url.pathname === '/api/import' && request.method === 'GET') {
      const project = campaign(url.searchParams.get('url'));
      if (!project) return json({ error: 'Вставьте HTTPS-ссылку на кампанию Kickstarter или Gamefound.' }, 400);
      try {
        const data = await (project.platform === 'Gamefound' ? importGamefound(project) : importKickstarter(project));
        if (data?.rateLimited) return json({ error: 'Достигнут бесплатный лимит резервного источника Kickstarter. Попробуйте позже или заполните карточку вручную.' }, 429);
        if (data?.name) return json({ ...data, platform: project.platform });
      } catch {
        // An unavailable source must leave the editable form intact.
      }
      return json({ error: `${project.platform} не вернул данные кампании. Заполните карточку вручную или повторите позже.` }, 502);
    }

    if (url.pathname === '/api/catalog') {
      try {
        if (request.method === 'GET') {
          if (url.searchParams.get('unlock') === '1') return json(await catalogWithCacheKey(env.DB));
          const row = await env.DB.prepare('SELECT revision, games FROM catalog WHERE id = 1').first();
          return json({ revision: row.revision, games: JSON.parse(row.games) });
        }
        if (request.method === 'PUT') {
          let data;
          try {
            data = JSON.parse(await readText(request, MAX_CATALOG_BYTES));
          } catch (error) {
            if (error instanceof BodyTooLarge) return json({ error: 'Каталог превышает 1 МБ.' }, 413);
            return json({ error: 'Некорректный JSON.' }, 400);
          }
          if (!Number.isSafeInteger(data?.revision) || data.revision < 0 || !Array.isArray(data.games) ||
              data.games.some(game => !game || typeof game.id !== 'string' || typeof game.name !== 'string' ||
                !['order', 'wishlist'].includes(game.type)) ||
              new Set(data.games.map(game => game.id)).size !== data.games.length) {
            return json({ error: 'Некорректный каталог.' }, 400);
          }
          const result = await env.DB.prepare(
            'UPDATE catalog SET revision = revision + 1, games = ? WHERE id = 1 AND revision = ?'
          ).bind(JSON.stringify(data.games), data.revision).run();
          if (!result.meta.changes) return json({ error: 'Облачный каталог изменился на другом устройстве.' }, 409);
          return json({ revision: data.revision + 1 });
        }
      } catch (error) {
        if (/free tier daily row (read|write) limit/i.test(String(error))) {
          const now = Date.now();
          const retryAfter = Math.ceil((86_400_000 - now % 86_400_000) / 1000);
          return json({ error: 'Достигнут дневной лимит D1. Синхронизацию можно повторить после 00:00 UTC.' },
            429, { 'Retry-After': String(retryAfter) });
        }
        return json({ error: 'База данных недоступна. Проверьте настройки D1 и миграцию.' }, 503);
      }
    }
    return json({ error: 'Метод не поддерживается.' }, 405);
  }
};
