const CURRENCIES = ['EUR', 'USD', 'RSD', 'GBP'];
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

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

async function upstream(url, accept) {
  return fetch(url, { redirect: 'manual', headers: { accept }, signal: AbortSignal.timeout(10000) });
}

async function importGamefound(project) {
  const api = new URL('https://gamefound.com/api/public/projects/getCrowdfundingProject');
  api.searchParams.set('urlName', project.slug);
  const response = await upstream(api, 'application/json');
  if (!response.ok) return null;
  const data = await response.json();
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
  const response = await upstream(`${project.url}/widget/card.html`, 'text/html');
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return null;
  const html = await response.text();
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
    const json = (data, status = 200) => Response.json(data, { status, headers });
    if (origin && !allowed.includes(origin)) return json({ error: 'Сайт не разрешён настройками Worker.' }, 403);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, PUT, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (!['/api/import', '/api/catalog'].includes(url.pathname)) return json({ error: 'Маршрут не найден.' }, 404);
    if (!await authorized(request, env.ACCESS_TOKEN)) return json({ error: 'Проверьте ключ доступа.' }, 401);

    if (url.pathname === '/api/import' && request.method === 'GET') {
      const project = campaign(url.searchParams.get('url'));
      if (!project) return json({ error: 'Вставьте HTTPS-ссылку на кампанию Kickstarter или Gamefound.' }, 400);
      try {
        const data = await (project.platform === 'Gamefound' ? importGamefound(project) : importKickstarter(project));
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
            const reader = request.body?.getReader();
            const decoder = new TextDecoder();
            let size = 0;
            let body = '';
            while (reader) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 1000000) {
                await reader.cancel();
                return json({ error: 'Каталог превышает 1 МБ.' }, 413);
              }
              body += decoder.decode(value, { stream: true });
            }
            data = JSON.parse(body + decoder.decode());
          } catch { return json({ error: 'Некорректный JSON.' }, 400); }
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
      } catch { return json({ error: 'База данных недоступна. Проверьте настройки D1 и миграцию.' }, 503); }
    }
    return json({ error: 'Метод не поддерживается.' }, 405);
  }
};
