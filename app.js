(() => {
  const legacyGamesKey = 'mbgp_v02_games';
  const encryptedCacheKey = 'mbgp_encrypted_catalog';
  const cacheContext = new TextEncoder().encode('Board Game Preorder Tracker catalog cache v1');
  let games = [];
  let editingId = null;
  const $ = id => document.getElementById(id);
  const fields = ['url', 'name', 'type', 'platform', 'status', 'price', 'currency',
    'shipping', 'eta', 'notes', 'cover', 'publisher', 'description', 'campaignStart', 'campaignEnd'];
  const importFields = ['name', 'platform', 'cover', 'publisher', 'description', 'campaignStart', 'campaignEnd', 'currency'];
  const cloudKey = 'mbgp_v03_cloud';
  const googleSessionKey = 'mbgp_google_session';
  const workerEndpoint = 'https://board-game-preorder-tracker.strategdzr.workers.dev';
  let cloud = null;
  let signedIn = false;
  let loginPending = false;
  let sessionTimer;
  let syncing = false;
  let change = 0;
  let formVersion = 0;
  let importRequest;
  let updatesRequest;
  let catalogGeneration = 0;
  let state = {};
  let localKey = null;
  let cacheWrites = Promise.resolve();

  function toBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }
  function fromBase64(value) {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
  }
  async function encryptLocal(key, snapshot) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const algorithm = { name: 'AES-GCM', iv, additionalData: cacheContext };
    const ciphertext = await crypto.subtle.encrypt(algorithm, key, new TextEncoder().encode(snapshot));
    return JSON.stringify({ version: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) });
  }
  async function decryptLocal(key, raw) {
    const { version, iv, data } = JSON.parse(raw);
    if (version !== 1 || typeof iv !== 'string' || typeof data !== 'string') throw new Error('Unknown cache format');
    const nonce = fromBase64(iv);
    if (nonce.length !== 12) throw new Error('Invalid cache nonce');
    const algorithm = { name: 'AES-GCM', iv: nonce, additionalData: cacheContext };
    const bytes = await crypto.subtle.decrypt(algorithm, key, fromBase64(data));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }

  async function unlockLocal(secret) {
    if (typeof secret !== 'string' || !/^[a-f\d]{64}$/.test(secret)) throw new Error('Ключ локальной копии недоступен.');
    const bytes = Uint8Array.from(secret.match(/../g), pair => Number.parseInt(pair, 16));
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    bytes.fill(0);
    await cacheWrites;
    try {
      const encrypted = localStorage.getItem(encryptedCacheKey);
      const legacyGames = localStorage.getItem(legacyGamesKey);
      const legacyState = localStorage.getItem(cloudKey);
      let snapshot = encrypted ? await decryptLocal(key, encrypted) : {
        games: JSON.parse(legacyGames || '[]'),
        state: JSON.parse(legacyState || '{}')
      };
      if (!Array.isArray(snapshot.games) || !snapshot.state || typeof snapshot.state !== 'object') throw new Error('Invalid cache');
      // A tab running an older release may have made unsynced edits since migration.
      if (encrypted && legacyGames && JSON.parse(legacyState || '{}').dirty) {
        const pending = JSON.parse(legacyGames);
        if (!Array.isArray(pending) || JSON.stringify(pending) !== JSON.stringify(snapshot.games)) {
          throw new Error('Conflicting legacy cache');
        }
      }
      if (!encrypted && (legacyGames !== null || legacyState !== null)) {
        localStorage.setItem(encryptedCacheKey, await encryptLocal(key, JSON.stringify(snapshot)));
      }
      localStorage.removeItem(legacyGamesKey);
      localStorage.removeItem(cloudKey);
      return { key, snapshot };
    } catch {
      throw new Error('Не удалось открыть или перенести локальную копию. Данные сохранены в браузере. Закройте вкладки со старой версией и повторите вход.');
    }
  }
  function persistLocal() {
    const key = localKey;
    if (!key) return;
    const snapshot = JSON.stringify({ games, state });
    cacheWrites = cacheWrites.then(async () => {
      const encrypted = await encryptLocal(key, snapshot);
      localStorage.setItem(encryptedCacheKey, encrypted);
    }).catch(() => {
      if (key === localKey) {
        $('cacheWarning').hidden = false;
        toast('Зашифрованная копия не сохранилась в браузере.');
      }
    });
  }
  const statusLabels = {campaign:'Кампания / предзаказ',production:'Производство',shipping:'Отправлено',delivered:'Доставлено',paused:'Приостановлено'};
  function save(){
    change++;
    state = { ...state, dirty: true };
    persistLocal();
    render();
    if (signedIn && state.endpoint === cloud.endpoint && Number.isInteger(state.revision)) sync('auto');
  }
  function webUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2300)}
  function go(page){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page));document.querySelectorAll('.nav-item').forEach(a=>a.classList.toggle('active',a.dataset.page===page));if(page==='add'&&!editingId)resetForm();window.scrollTo(0,0)}
  document.querySelectorAll('[data-page]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();go(a.dataset.page)}));
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
  function platformFromUrl(url){const u=(url||'').toLowerCase();if(u.includes('kickstarter.com'))return 'Kickstarter';if(u.includes('gamefound.com'))return 'Gamefound';if(u.includes('lavka.games')||u.includes('lavkaigr.ru'))return 'Lavka Games';if(u.includes('gaga.ru')||u.includes('gagagames'))return 'GaGa Games';return ''}
  $('url').addEventListener('change',()=>{const p=platformFromUrl($('url').value);if(p)$('platform').value=p});
  $('type').addEventListener('change',()=>{$('orderFields').style.display=$('type').value==='order'?'block':'none'});
  function card(g){const status=g.type==='wishlist'?'Wishlist':(statusLabels[g.status]||'Предзаказ');const cls=Object.hasOwn(statusLabels,g.status)?g.status:'';const cover=webUrl(g.cover);return `<article class="game-card" data-id="${esc(g.id)}"><div class="cover">${cover?`<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer">`:'✦'}</div><div class="game-info"><h3>${esc(g.name)}</h3><p>${esc(g.platform||'Площадка не указана')} · ${esc(g.eta|| (g.type==='wishlist'?'В списке желаний':''))}</p><span class="status ${cls}">${esc(status)}</span></div><span class="arrow">›</span></article>`}
  function renderList(containerId,emptyId,items){$(containerId).innerHTML=items.map(card).join('');$(emptyId).classList.toggle('show',items.length===0);$(containerId).querySelectorAll('.game-card').forEach(el=>el.addEventListener('click',()=>showDetail(el.dataset.id)))}
  function render(){const orders=games.filter(g=>g.type==='order'),wish=games.filter(g=>g.type==='wishlist');$('stat-orders').textContent=orders.filter(g=>g.status!=='delivered').length;$('stat-shipping').textContent=orders.filter(g=>g.status==='shipping').length;renderList('ordersList','ordersEmpty',filter(orders,$('orderSearch').value));renderList('wishlistList','wishlistEmpty',filter(wish,$('wishSearch').value));const recent=[...orders].sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,3);renderList('recentList','homeEmpty',recent);$('homeEmpty').classList.toggle('show',orders.length===0)}
  function filter(items,q){q=(q||'').trim().toLowerCase();return items.filter(g=>!q||`${g.name} ${g.platform} ${g.notes}`.toLowerCase().includes(q))}
  $('orderSearch').addEventListener('input',render);$('wishSearch').addEventListener('input',render);
  function cancelImport() {
    formVersion++;
    importRequest?.abort();
    importRequest = null;
    $('fetchGame').disabled = false;
    $('formNote').textContent = 'Импорт доступен для Kickstarter и Gamefound.';
  }
  $('url').addEventListener('input', cancelImport);
  function resetForm(){editingId=null;cancelImport();$('gameForm').reset();$('gameId').value='';$('formTitle').textContent='Добавить игру';$('orderFields').style.display='block';$('type').value='order';$('cancelEdit').style.display='none'}
  $('cancelEdit').addEventListener('click',()=>{resetForm();go('orders')});
  $('gameForm').addEventListener('submit', event => {
    event.preventDefault();
    const id = editingId || crypto.randomUUID();
    const index = games.findIndex(game => game.id === id);
    const values = Object.fromEntries(fields.map(field => [field, $(field).value.trim()]));
    if (!values.name) return;
    const game = { ...games[index], ...values, id, updated: Date.now() };
    if (index >= 0) games[index] = game;
    else games.unshift(game);
    save();
    resetForm();
    go(game.type === 'wishlist' ? 'wishlist' : 'orders');
    toast(index >= 0 ? 'Изменения сохранены' : 'Игра добавлена');
  });
  function showDetail(id){const g=games.find(x=>x.id===id);if(!g)return;const d=$('detailContent');const url=webUrl(g.url);d.innerHTML=`<div class="eyebrow">${g.type==='wishlist'?'WISHLIST':'ПРЕДЗАКАЗ'}</div><h2>${esc(g.name)}</h2><p>${esc(g.platform||'Площадка не указана')} · ${esc(statusLabels[g.status]||'Wishlist')}</p>${url?`<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--gold)">Открыть страницу проекта ↗</a></p>`:''}${[['Автор / издатель', g.publisher], ['Начало кампании', g.campaignStart], ['Конец кампании', g.campaignEnd], ['Описание', g.description]].filter(([,value])=>value).map(([label,value])=>'<p><b>'+label+':</b> '+esc(value)+'</p>').join('')}${g.eta?`<p><b>Ожидаемая дата:</b> ${esc(g.eta)}</p>`:''}${g.type==='order'&&(g.price||g.shipping)?`<p><b>Цена:</b> ${esc(g.price||'—')} ${esc(g.currency)}<br><b>Доставка:</b> ${esc(g.shipping||'—')} ${esc(g.currency)}</p>`:''}${g.notes?`<p>${esc(g.notes)}</p>`:''}${renderHistory(g)}<div class="detail-actions"><button class="primary-button" id="editGame">Изменить</button><button class="secondary-button" id="deleteGame">Удалить</button></div>`;$('detailDialog').showModal();$('editGame').onclick=()=>{ $('detailDialog').close();editGame(g)};$('deleteGame').onclick=()=>{if(confirm('Удалить эту запись?')){games=games.filter(x=>x.id!==id);save();$('detailDialog').close();toast('Запись удалена')}}}
  function editGame(g){editingId=g.id;cancelImport();$('gameId').value=g.id;$('formTitle').textContent='Редактировать игру';for(const id of fields)$(id).value=g[id]??'';$('orderFields').style.display=g.type==='order'?'block':'none';$('cancelEdit').style.display='inline-block';go('add')}
  $('closeDialog').addEventListener('click',()=>$('detailDialog').close());
  function exportJson(){const blob=new Blob([JSON.stringify({app:'My Board Games Preorders',version:2,exportedAt:new Date().toISOString(),games},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='my-board-games-preorders-backup.json';a.click();URL.revokeObjectURL(a.href);toast('Резервная копия подготовлена')}
  $('exportBtn').addEventListener('click',exportJson);$('backupBtn').addEventListener('click',exportJson);
  $('importFile').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());const incoming=Array.isArray(data)?data:data.games;if(!Array.isArray(incoming)||incoming.some(g=>!g||typeof g.name!=='string'||!['order','wishlist'].includes(g.type)))throw new Error('Неверный формат');if(confirm(`Импортировать ${incoming.length} записей? Текущий список будет заменён.`)){catalogGeneration++;const ids=new Set();games=incoming.map(g=>{let id=String(g.id||crypto.randomUUID());if(ids.has(id))id=crypto.randomUUID();ids.add(id);return {...g,id}});save();toast('Данные импортированы')}}catch{toast('Не удалось прочитать JSON-файл')}e.target.value=''});
  function cloudResponseMessage(status, body, data) {
    if (typeof data?.error === 'string') return data.error;
    if (/\b(?:error\s+(?:code\s*)?:?\s*1027|daily request limit)\b/i.test(body)) {
      return 'Достигнут дневной лимит бесплатного тарифа Cloudflare Workers. Повторите после 00:00 UTC.';
    }
    if (status === 429) return 'Cloudflare временно ограничил запросы. Попробуйте позже.';
    return 'Cloudflare вернул ошибку. Попробуйте позже.';
  }

  async function api(path, options = {}) {
    const { endpoint, token } = cloud;
    const response = await fetch(endpoint + path, {
      method: options.method || 'GET',
      signal: options.signal ?? AbortSignal.timeout(18000),
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body
    });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { /* Cloudflare can return an HTML error page. */ }
    if (!response.ok) throw Object.assign(new Error(cloudResponseMessage(response.status, body, data)), { status: response.status });
    if (!data) throw new Error('Worker вернул некорректный ответ.');
    return data;
  }

  function updateProject(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?projects\/([a-z\d][a-z\d_-]*\/[a-z\d][a-z\d_-]*)(?:\/|$)/i);
      if (!match) return '';
      if (['kickstarter.com', 'www.kickstarter.com'].includes(url.hostname)) {
        return 'https://www.kickstarter.com/projects/' + match[1];
      }
      if (['gamefound.com', 'www.gamefound.com'].includes(url.hostname)) {
        return 'https://gamefound.com/en/projects/' + match[1];
      }
    } catch { /* An invalid URL cannot be checked. */ }
    return '';
  }

  function renderHistory(game) {
    const history = Array.isArray(game.updateHistory) ? game.updateHistory : [];
    if (game.type !== 'order') return '';
    const entries = history.map(entry => {
      if (!entry || typeof entry.title !== 'string') return '';
      const label = esc(entry.title);
      const url = webUrl(entry.url);
      const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      return `<li>${title} <small>#${esc(entry.number)}${entry.published ? ' · ' + esc(entry.published) : ''}</small></li>`;
    }).join('');
    return `<section class="update-history"><h3>История обновлений</h3>${entries ? '<ul>' + entries + '</ul>' : '<p>Обновлений пока нет.</p>'}</section>`;
  }

  function updateEligible(game) {
    return game.type === 'order' && game.status !== 'delivered';
  }

  function parseUpdates(content, project) {
    const kickstarter = project.startsWith('https://www.kickstarter.com/');
    const feedUrl = project + (kickstarter ? '/posts' : '/updates');
    if (content.match(/^URL Source: (.+)$/m)?.[1].trim() !== feedUrl) return null;
    const updates = [];
    const seen = new Set();
    const pattern = kickstarter
      ? /^Update #(\d+)\r?\n(?:[ \t]*\r?\n)*#{1,3}[ \t]+([^\r\n]+)/gm
      : /^\[Update #(\d+) (\d{1,2})\/(\d{1,2})\/(\d{4}) [^#\r\n]+#[ \t]+(.+?)(?= !\[| \[Read more\]|\r?$)/gm;
    for (const match of content.matchAll(pattern)) {
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) continue;
      const title = (kickstarter ? match[2] : match[5]).trim().slice(0, 260);
      if (!title) continue;
      seen.add(number);
      const published = kickstarter ? '' : `${match[4]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
      const postUrl = kickstarter ? feedUrl : `${feedUrl}/${number}`;
      updates.push({ number, title, url: postUrl, published });
    }
    if (!updates.length) return null;
    return { campaign: project, updates: updates.sort((a, b) => b.number - a.number).slice(0, 30) };
  }

  async function loadUpdates(project, signal) {
    const site = project.startsWith('https://www.kickstarter.com/') ? 'Kickstarter' : 'Gamefound';
    const feed = project + (site === 'Kickstarter' ? '/posts' : '/updates');
    const response = await fetch('https://r.jina.ai/' + feed, {
      signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { Accept: 'text/plain' }
    });
    if (response.status === 429) throw Object.assign(new Error('Источник обновлений ограничил проверку. Повторите позже.'), { status: 429 });
    if (!response.ok || !response.body) throw Object.assign(new Error(site + ' не вернул список обновлений.'), { status: response.status });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) {
        await reader.cancel();
        throw Object.assign(new Error('Список обновлений слишком большой.'), { status: 413 });
      }
      content += decoder.decode(value, { stream: true });
    }
    const result = parseUpdates(content + decoder.decode(), project);
    if (!result) throw Object.assign(new Error(site + ' не вернул читаемый список обновлений.'), { status: 502 });
    return result;
  }

  function addUpdates(game, result) {
    if (!Array.isArray(result.updates) || !result.updates.length) return 0;
    const history = Array.isArray(game.updateHistory) ? game.updateHistory.filter(Boolean) : [];
    const latest = Math.max(0, ...history.filter(entry => entry.campaign === result.campaign &&
      Number.isSafeInteger(entry.number)).map(entry => entry.number));
    const seen = new Set();
    const fresh = result.updates.filter(entry => {
      if (!Number.isSafeInteger(entry?.number) || entry.number <= latest || seen.has(entry.number) ||
          typeof entry.title !== 'string' || !entry.title || !webUrl(entry.url)) return false;
      seen.add(entry.number);
      return true;
    }).sort((a, b) => b.number - a.number).slice(0, latest ? 30 : 5);
    if (!fresh.length) return 0;
    game.updateHistory = fresh.map(entry => ({ ...entry, campaign: result.campaign })).concat(history).slice(0, 30);
    game.updated = Date.now();
    return fresh.length;
  }

  async function checkUpdates(manual = false) {
    const status = $('updatesStatus');
    if (updatesRequest) return;
    if (!signedIn) {
      if (manual) status.textContent = 'Войдите через «Ещё → Личный доступ», чтобы проверить обновления.';
      return;
    }
    const projects = new Map();
    for (const game of games.filter(updateEligible)) {
      const project = updateProject(game.url);
      if (!project) continue;
      if (!projects.has(project)) projects.set(project, []);
      projects.get(project).push(game.id);
    }
    if (!projects.size) {
      if (manual) status.textContent = 'Нет активных предзаказов со ссылкой на Kickstarter или Gamefound.';
      return;
    }
    const request = new AbortController();
    updatesRequest = request;
    const generation = catalogGeneration;
    $('checkUpdates').disabled = true;
    status.textContent = 'Проверяем публикации кампаний…';
    const found = [];
    const errors = [];
    try {
      const entries = [...projects];
      for (let index = 0; index < entries.length && !request.signal.aborted; index += 2) {
        await Promise.all(entries.slice(index, index + 2).map(async ([url, ids]) => {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          request.signal.addEventListener('abort', cancel, { once: true });
          const timeout = setTimeout(cancel, 18_000);
          try {
            const result = await loadUpdates(url, controller.signal);
            found.push({ url, ids, result });
          } catch (error) {
            errors.push(error.status ? error.message : 'Не удалось связаться с источником обновлений.');
          } finally {
            clearTimeout(timeout);
            request.signal.removeEventListener('abort', cancel);
          }
        }));
      }
      if (request.signal.aborted || generation !== catalogGeneration) {
        if (!request.signal.aborted) status.textContent = 'Каталог изменился. Запустите проверку ещё раз.';
        return;
      }
      let added = 0;
      for (const { url, ids, result } of found) {
        for (const game of games) {
          if (ids.includes(game.id) && updateEligible(game) && updateProject(game.url) === url) {
            added += addUpdates(game, result);
          }
        }
      }
      if (added) save();
      const summary = found.length ? (added ? `Добавлено в историю: ${added}.` : 'Новых публикаций нет.') : '';
      status.textContent = [summary, errors.length ? `Не удалось проверить кампаний: ${errors.length}. ${errors[0]}` : ''].filter(Boolean).join(' ');
    } finally {
      updatesRequest = null;
      $('checkUpdates').disabled = false;
    }
  }
  $('checkUpdates').addEventListener('click', () => checkUpdates(true));

  $('fetchGame').addEventListener('click', async () => {
    const note = $('formNote');
    if (!signedIn) {
      note.textContent = 'Для импорта войдите через «Ещё → Личный доступ».';
      return;
    }
    const url = $('url').value.trim();
    if (!url || !$('url').reportValidity()) {
      note.textContent = 'Вставьте ссылку на кампанию.';
      return;
    }
    const version = formVersion;
    const controller = new AbortController();
    importRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 18000);
    const before = Object.fromEntries(importFields.map(id => [id, $(id).value]));
    $('fetchGame').disabled = true;
    note.textContent = 'Получаем данные кампании…';
    try {
      const result = await api('/api/import?url=' + encodeURIComponent(url), { signal: controller.signal });
      if (version !== formVersion) return;
      for (const id of importFields) {
        if (!before[id] && $(id).value === before[id] && typeof result[id] === 'string') $(id).value = result[id];
      }
      note.textContent = 'Доступные данные подставлены в пустые поля. Проверьте форму и сохраните игру.' +
        (typeof result.sourceNote === 'string' ? ' ' + result.sourceNote : '');
    } catch (error) {
      if (version === formVersion) note.textContent = error.status ? error.message
        : 'Не удалось связаться с Cloudflare. Проверьте подключение и повторите позже. Если исчерпана дневная квота, она обновится в 00:00 UTC.';
    } finally {
      clearTimeout(timeout);
      if (version === formVersion) {
        importRequest = null;
        $('fetchGame').disabled = false;
      }
    }
  });

  function cloudStatus(message) {
    $('cloudStatus').textContent = message;
    $('cloudStatus').hidden = !message;
  }
  function cloudButtons() {
    $('authGate').hidden = signedIn;
    $('privateApp').hidden = !signedIn;
    $('googleSignIn').hidden = syncing;
    $('downloadCloud').disabled = $('uploadCloud').disabled = $('logoutCloud').disabled = syncing;
  }

  function endSession(message = '') {
    clearTimeout(sessionTimer);
    cancelImport();
    updatesRequest?.abort();
    $('updatesStatus').textContent = '';
    if ($('detailDialog').open) $('detailDialog').close();
    $('detailContent').replaceChildren();
    resetForm();
    games = [];
    state = {};
    localKey = null;
    $('cacheWarning').hidden = true;
    render();
    cloud = null;
    signedIn = false;
    sessionStorage.removeItem(googleSessionKey);
    window.google?.accounts?.id?.disableAutoSelect();
    $('loginStatus').textContent = message;
    cloudButtons();
    if (!$('googleSignIn').childElementCount) showGoogleSignIn();
  }

  function rememberGoogleSession(token) {
    sessionStorage.setItem(googleSessionKey, token);
    clearTimeout(sessionTimer);
    // The authenticated catalog response has already verified this token.
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    sessionTimer = setTimeout(() => endSession('Сессия истекла. Войдите через Google повторно.'),
      Math.min(2_147_483_647, Math.max(0, claims.exp * 1000 - Date.now())));
  }

  async function showGoogleSignIn() {
    if (loginPending) return;
    loginPending = true;
    $('retryLogin').hidden = true;
    try {
      const response = await fetch(workerEndpoint + '/api/auth-config', {
        signal: AbortSignal.timeout(10000), credentials: 'omit', redirect: 'error'
      });
      if (!response.ok) throw new Error('Google-вход пока недоступен.');
      const { clientId } = await response.json();
      if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) throw new Error('Неверная конфигурация входа.');
      if (!window.google?.accounts?.id) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client';
          script.async = true;
          const timer = setTimeout(() => { script.remove(); reject(new Error('Google не ответил.')); }, 12000);
          script.onload = () => { clearTimeout(timer); resolve(); };
          script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Не удалось загрузить вход Google.')); };
          document.head.append(script);
        });
      }
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          if (syncing || signedIn || typeof credential !== 'string') return;
          cloud = { endpoint: workerEndpoint, token: credential };
          $('loginStatus').textContent = 'Проверяем аккаунт Google…';
          sync('connect');
        }
      });
      $('googleSignIn').replaceChildren();
      window.google.accounts.id.renderButton($('googleSignIn'), { theme: 'outline', size: 'large', locale: 'ru' });
    } catch {
      $('loginStatus').textContent = 'Не удалось открыть вход через Google. Повторите позже.';
      $('retryLogin').hidden = false;
    } finally {
      loginPending = false;
    }
  }
  async function sync(mode) {
    if (!cloud || syncing) return;
    syncing = true;
    cloudButtons();
    const session = cloud;
    const endpoint = session.endpoint;
    const start = change;
    let continueSaving = false;
    let checkOnConnect = false;
    cloudStatus('Связываемся с D1…');
    try {
      const remote = mode === 'auto' ? null : await api('/api/catalog' + (mode === 'connect' ? '?unlock=1' : ''));
      if (cloud !== session) return;
      if (mode === 'connect') {
        const { key, snapshot } = await unlockLocal(remote.cacheKey);
        if (cloud !== session) return;
        localKey = key;
        state = snapshot.state;
        games = snapshot.games;
        rememberGoogleSession(session.token);
        signedIn = true;
        render();
      }
      const knownEndpoint = state.endpoint === endpoint;
      if (mode === 'download' || (mode === 'connect' &&
          (knownEndpoint && !state.dirty || !knownEndpoint && !games.length))) {
        if (change !== start) throw new Error('Локальный каталог изменился. Повторите загрузку.');
        games = remote.games;
        catalogGeneration++;
        if (editingId) resetForm();
        if ($('detailDialog').open) $('detailDialog').close();
        state = { endpoint, revision: remote.revision, dirty: false };
        persistLocal();
        render();
      } else if (mode === 'connect' && remote.revision !== 0 &&
          (state.endpoint !== endpoint || state.revision !== remote.revision)) {
        state = { endpoint, dirty: true };
        persistLocal();
        cloudStatus('Выберите, какой каталог оставить: загрузить из D1 или отправить локальный.');
        return;
      } else {
        const snapshot = change;
        const result = await api('/api/catalog', {
          method: 'PUT',
          body: JSON.stringify({ revision: remote?.revision ?? state.revision, games })
        });
        if (cloud !== session) return;
        continueSaving = snapshot !== change;
        state = { endpoint, revision: result.revision, dirty: continueSaving };
        persistLocal();
      }
      cloudStatus('Каталог синхронизирован с D1.');
      checkOnConnect = mode === 'connect';
    } catch (error) {
      if (cloud !== session) return;
      if (error.status === 401) {
        endSession(error.message);
      } else if (mode === 'connect' && !signedIn) {
        $('loginStatus').textContent = error.message || 'Не удалось открыть каталог. Повторите вход.';
        showGoogleSignIn();
      }
      if (error.status === 409) {
        state = { endpoint, dirty: true };
        persistLocal();
      }
      cloudStatus(error.status === 409
        ? 'Каталог изменился на другом устройстве. Выберите, какую версию оставить.'
        : error.status ? error.message + ' Локальные записи доступны.'
          : 'Cloudflare недоступен. Локальные записи доступны. Повторите подключение позже. Если исчерпана дневная квота, она обновится в 00:00 UTC.');
    } finally {
      syncing = false;
      cloudButtons();
    }
    if (continueSaving) sync('auto');
    if (checkOnConnect) checkUpdates();
  }

  $('retryLogin').addEventListener('click', () => showGoogleSignIn());
  $('logoutCloud').addEventListener('click', () => endSession());
  $('downloadCloud').addEventListener('click', () => {
    if (!games.length || confirm('Заменить локальный каталог версией из D1?')) sync('download');
  });
  $('uploadCloud').addEventListener('click', () => {
    if (confirm('Заменить каталог в D1 локальной версией?')) sync('upload');
  });
  window.addEventListener('hashchange',()=>{const page=location.hash.slice(1);if(['home','orders','wishlist','add','settings'].includes(page))go(page)});
  const initial=location.hash.slice(1);go(['home','orders','wishlist','add','settings'].includes(initial)?initial:'home');render();
  sessionStorage.removeItem(cloudKey);
  const existingToken = sessionStorage.getItem(googleSessionKey);
  if (existingToken) cloud = { endpoint: workerEndpoint, token: existingToken };
  cloudButtons();
  if (cloud) sync('connect');
  else showGoogleSignIn();
})();
