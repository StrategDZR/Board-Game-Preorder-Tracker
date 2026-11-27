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

async function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const encode = value => new TextEncoder().encode(value);
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(`Bearer ${secret}`)),
    crypto.subtle.digest('SHA-256', encode(request.headers.get('authorization') || ''))
  ]);
  return crypto.subtle.timingSafeEqual(expected, supplied);
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
    if (!['/api/import', '/api/catalog'].includes(url.pathname)) return json({ error: 'Маршрут не найден.' }, 404);
    if (!await authorized(request, env.ACCESS_TOKEN)) return json({ error: 'Проверьте ключ доступа.' }, 401);
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
