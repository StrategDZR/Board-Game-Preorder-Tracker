(() => {
  const legacyGamesKey = 'mbgp_v02_games';
  const encryptedCacheKey = 'mbgp_encrypted_catalog';
  const cacheContext = new TextEncoder().encode('Board Game Preorder Tracker catalog cache v1');
  let games = [];
  let editingId = null;
  let pendingDeleteId = null;
  const $ = id => document.getElementById(id);
  const fields = ['url', 'name', 'type', 'platform', 'price', 'currency', 'notes', 'cover', 'publisher', 'description'];
  const orderFields = ['status', 'shipping', 'eta', 'actualShipDate', 'actualDeliveryDate', 'campaignEnd'];
  const importFields = ['name', 'platform', 'cover', 'publisher', 'description', 'campaignEnd', 'eta', 'currency', 'price'];
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
  let orderItems = [];
  let importedOrderFields = {};
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
  const deliveryDays = new Intl.NumberFormat('ru', { style: 'unit', unit: 'day', unitDisplay: 'long' });
  const deliveryMonths = new Intl.NumberFormat('ru', { style: 'unit', unit: 'month', unitDisplay: 'long' });
  const deliveryMonthLabel = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayMs = 86_400_000;
  const isDeliveryMonth = value => /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
  const deliverySeason = value => /^(20\d{2})-(winter|spring|summer|autumn)$/.exec(value);
  const seasonLabels = { winter: 'зима', spring: 'весна', summer: 'лето', autumn: 'осень' };

  function deliveryDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return null;
    const iso = isDeliveryMonth(value) ? value + '-01' : value;
    const date = new Date(iso + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? date : null;
  }

  function formatDeliveryDate(value) {
    const season = deliverySeason(value);
    if (season) return `${seasonLabels[season[2]]} ${season[1]}`;
    const date = deliveryDate(value);
    return date && isDeliveryMonth(value) ? deliveryMonthLabel.format(date) : value;
  }

  function calendarMonthOffset(date, months) {
    const offset = new Date(date);
    offset.setUTCDate(1);
    offset.setUTCMonth(offset.getUTCMonth() + months + 1, 0);
    offset.setUTCDate(Math.min(date.getUTCDate(), offset.getUTCDate()));
    return offset;
  }

  function deliveryCountdown(eta, now = new Date()) {
    const delivery = deliveryDate(eta);
    if (!delivery) return '';
    const today = new Date(now);
    today.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate());
    today.setUTCHours(0, 0, 0, 0);
    let months = (delivery.getUTCFullYear() - today.getUTCFullYear()) * 12 +
      delivery.getUTCMonth() - today.getUTCMonth();
    if (isDeliveryMonth(eta)) {
      if (months === 0) return 'Ожидается в этом месяце';
      if (months < 0) return 'Ожидаемый месяц прошёл';
      return 'Ориентировочно через ' + deliveryMonths.format(months);
    }
    const days = (delivery - today) / dayMs;
    if (days === 0) return 'Ожидается сегодня';
    if (days < 0) return 'Срок прошёл ' + deliveryDays.format(-days) + ' назад';

    if (calendarMonthOffset(today, months) > delivery) months--;
    if (!months) return 'До доставки меньше месяца (' + deliveryDays.format(days) + ')';
    const remainder = (delivery - calendarMonthOffset(today, months)) / dayMs;
    return 'До доставки ' + deliveryMonths.format(months) +
      (remainder ? ' ' + deliveryDays.format(remainder) : '');
  }

  function deliveryCountdownMarkup(game) {
    if (game.type !== 'order' || !game.eta || game.status === 'delivered' || game.actualDeliveryDate) return '';
    const text = deliveryCountdown(game.eta);
    return text ? `<span class="delivery-countdown" data-delivery-date="${esc(game.eta)}">${esc(text)}</span>` : '';
  }

  function refreshDeliveryCountdowns() {
    const now = new Date();
    for (const countdown of document.querySelectorAll('[data-delivery-date]')) {
      countdown.textContent = deliveryCountdown(countdown.dataset.deliveryDate, now);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDeliveryCountdowns();
  });
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
  function go(page, newType) {
    if (page === 'add' && (newType || !editingId)) resetForm(newType);
    document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page));
    document.querySelectorAll('.nav-item').forEach(a=>a.classList.toggle('active',a.dataset.page===page));
    if (page === 'home' || page === 'orders') refreshDeliveryCountdowns();
    window.scrollTo(0,0);
  }
  function navigate(page) {
    if (page === 'add') {
      if ($('page-add').classList.contains('active')) return;
      go(page, $('page-wishlist').classList.contains('active') ? 'wishlist' : 'order');
    } else go(page);
  }
  document.querySelectorAll('[data-page]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();navigate(a.dataset.page)}));
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.go)));
  function platformFromUrl(url){const u=(url||'').toLowerCase();if(u.includes('kickstarter.com'))return 'Kickstarter';if(u.includes('gamefound.com'))return 'Gamefound';if(u.includes('lavka.games')||u.includes('lavkaigr.ru'))return 'Lavka Games';if(u.includes('gaga.ru')||u.includes('gagagames')||u.includes('gaga-games.com'))return 'GaGa Games';return ''}
  $('url').addEventListener('change',()=>{const p=platformFromUrl($('url').value);if(p)$('platform').value=p});
  function showTypeFields() {
    const isOrder = $('type').value === 'order';
    $('orderFields').hidden = !isOrder;
    $('orderFields').disabled = !isOrder;
    $('releaseDateField').hidden = isOrder;
    $('releaseDate').disabled = isOrder;
  }
  $('type').addEventListener('change', showTypeFields);
  function card(game) {
    const order = game.type === 'order';
    const status = order ? statusLabels[game.status] || 'Предзаказ' : 'Wishlist';
    const cssClass = order && Object.hasOwn(statusLabels, game.status) ? game.status : '';
    const cover = webUrl(game.cover);
    const countdown = deliveryCountdownMarkup(game);
    const subtitle = order ? esc(formatDeliveryDate(game.eta) || '') : 'В списке желаний';
    return `<article class="game-card" data-id="${esc(game.id)}">
      <div class="cover">${cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer">` : '✦'}</div>
      <div class="game-info"><h3>${esc(game.name)}</h3>
        <p>${esc(game.platform || 'Площадка не указана')}${subtitle ? ' · ' + subtitle : ''}</p>
        ${countdown ? `<p class="delivery-summary">${countdown}</p>` : ''}
        <span class="status ${cssClass}">${esc(status)}</span>
      </div><span class="arrow">›</span>
    </article>`;
  }
  function renderList(containerId,emptyId,items){$(containerId).innerHTML=items.map(card).join('');$(emptyId).classList.toggle('show',items.length===0);$(containerId).querySelectorAll('.game-card').forEach(el=>el.addEventListener('click',()=>showDetail(el.dataset.id)))}
  function render(){const orders=games.filter(g=>g.type==='order'),wish=games.filter(g=>g.type==='wishlist');$('stat-orders').textContent=orders.filter(g=>g.status!=='delivered').length;$('stat-shipping').textContent=orders.filter(g=>g.status==='shipping').length;renderList('ordersList','ordersEmpty',filter(orders,$('orderSearch').value));renderList('wishlistList','wishlistEmpty',filter(wish,$('wishSearch').value));const recent=[...orders].sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,3);renderList('recentList','homeEmpty',recent);$('homeEmpty').classList.toggle('show',orders.length===0)}
  function filter(items,q){q=(q||'').trim().toLowerCase();return items.filter(g=>!q||`${g.name} ${g.platform} ${g.notes}`.toLowerCase().includes(q))}
  $('orderSearch').addEventListener('input',render);$('wishSearch').addEventListener('input',render);
  function cancelImport() {
    formVersion++;
    importRequest?.abort();
    importRequest = null;
    $('fetchGame').disabled = false;
    $('formNote').textContent = '';
    orderItems = [];
    importedOrderFields = {};
    $('orderItem').replaceChildren();
    $('orderItemField').hidden = true;
  }
  $('url').addEventListener('input', cancelImport);
  function setDeliveryInput(value, month = isDeliveryMonth(value)) {
    const seasonal = Boolean(deliverySeason(value));
    $('etaMonthMode').checked = month;
    $('etaMonthMode').parentElement.hidden = seasonal;
    $('refineEta').hidden = !seasonal;
    $('eta').type = seasonal ? 'text' : month ? 'month' : 'date';
    $('eta').readOnly = seasonal;
    $('eta').value = seasonal ? formatDeliveryDate(value) : value;
    if (seasonal) $('eta').dataset.season = value;
    else delete $('eta').dataset.season;
  }
  $('refineEta').addEventListener('click', () => {
    setDeliveryInput('');
    $('eta').focus();
  });
  $('etaMonthMode').addEventListener('change', () => {
    const month = $('etaMonthMode').checked;
    setDeliveryInput(month ? $('eta').value.slice(0, 7) : '', month);
  });
  function normalizeDeliveryDates(catalog) {
    return catalog.map(game => {
      const { eta, ...rest } = game;
      if (eta === undefined || eta === '') return game;
      if (deliveryDate(eta) || deliverySeason(eta)) return game;
      return rest;
    });
  }
  function resetForm(type = 'order') {
    editingId = null;
    cancelImport();
    $('gameForm').reset();
    setDeliveryInput('');
    $('gameId').value = '';
    $('formTitle').textContent = 'Добавить игру';
    $('type').value = type;
    showTypeFields();
    $('cancelEdit').hidden = true;
  }
  $('cancelEdit').addEventListener('click', () => {
    const page = games.find(game => game.id === editingId)?.type === 'wishlist' ? 'wishlist' : 'orders';
    resetForm();
    go(page);
  });
  $('gameForm').addEventListener('submit', event => {
    event.preventDefault();
    const id = editingId || crypto.randomUUID();
    const index = games.findIndex(game => game.id === id);
    const visibleFields = $('type').value === 'order' ? [...fields, ...orderFields] : [...fields, 'releaseDate'];
    const values = Object.fromEntries(visibleFields.map(field => [field, $(field).value.trim()]));
    if (values.type === 'order' && $('eta').dataset.season) values.eta = $('eta').dataset.season;
    if (!values.name) return;
    if (values.eta && !deliveryDate(values.eta) && !deliverySeason(values.eta)) {
      toast('Укажите срок доставки в календаре.');
      $('eta').focus();
      return;
    }
    const game = { ...games[index], ...values, id, updated: Date.now() };
    if (index >= 0) games[index] = game;
    else games.unshift(game);
    save();
    resetForm();
    go(game.type === 'wishlist' ? 'wishlist' : 'orders');
    toast(index >= 0 ? 'Изменения сохранены' : 'Игра добавлена');
  });
  function showDetail(id) {
    const g = games.find(game => game.id === id);
    if (!g) return;
    showDeletePrompt(null);
    const d = $('detailContent');
    const url = webUrl(g.url);
    const order = g.type === 'order';
    const countdown = deliveryCountdownMarkup(g);
    d.innerHTML=`<div class="eyebrow">${g.type==='wishlist'?'WISHLIST':'ПРЕДЗАКАЗ'}</div><h2>${esc(g.name)}</h2><p>${esc(g.platform||'Площадка не указана')} · ${esc(order ? statusLabels[g.status]||'Предзаказ' : 'Wishlist')}</p>${url?`<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--gold)">Открыть страницу проекта ↗</a></p>`:''}${[['Автор / издатель', g.publisher], ['Описание', g.description], ['Дата релиза', g.releaseDate], ...(order ? [['Ожидаемая доставка', formatDeliveryDate(g.eta)], ['Фактически отправлено', g.actualShipDate], ['Фактически получено', g.actualDeliveryDate], ['Конец кампании', g.campaignEnd]] : [])].filter(([,value])=>value).map(([label,value])=>'<p><b>'+label+':</b> '+esc(value)+'</p>').join('')}${(g.price||g.type==='order'&&g.shipping)?`<p><b>Цена:</b> ${esc(g.price||'—')} ${esc(g.currency)}${g.type==='order'&&g.shipping?'<br><b>Доставка:</b> '+esc(g.shipping)+' '+esc(g.currency):''}</p>`:''}${g.notes?`<p>${esc(g.notes)}</p>`:''}${renderHistory(g)}<div class="detail-actions">${order?'':'<button type="button" class="primary-button" id="moveToOrders">Перенести в предзаказы</button>'}<button type="button" class="${order?'primary':'secondary'}-button" id="editGame">Изменить</button><button class="secondary-button" id="deleteGame">Удалить</button></div>`;
    if (countdown) d.querySelector('h2').insertAdjacentHTML('afterend', `<p>${countdown}</p>`);
    $('detailDialog').showModal();
    $('editGame').onclick = () => {
      $('detailDialog').close();
      editGame(g);
    };
    if (!order) $('moveToOrders').onclick = () => moveToOrders(id);
    $('deleteGame').onclick = () => showDeletePrompt(g);
  }

  function showDeletePrompt(game) {
    pendingDeleteId = game?.id ?? null;
    $('detailContent').hidden = !!game;
    $('closeDialog').hidden = !!game;
    $('deletePrompt').hidden = !game;
    $('deleteGameName').textContent = game?.name ?? '';
    if (game) {
      $('detailDialog').setAttribute('aria-labelledby', 'deletePromptTitle');
      $('cancelDelete').focus();
    } else {
      $('detailDialog').removeAttribute('aria-labelledby');
    }
  }
  $('cancelDelete').addEventListener('click', () => {
    showDeletePrompt(null);
    $('deleteGame')?.focus();
  });
  $('confirmDelete').addEventListener('click', () => {
    const index = games.findIndex(game => game.id === pendingDeleteId);
    if (index < 0) return;
    games.splice(index, 1);
    showDeletePrompt(null);
    $('detailDialog').close();
    save();
    toast('Запись удалена');
  });
  $('detailDialog').addEventListener('close', () => showDeletePrompt(null));

  function moveToOrders(id) {
    const game = games.find(entry => entry.id === id && entry.type === 'wishlist');
    if (!game) return;
    game.type = 'order';
    if (!Object.hasOwn(statusLabels, game.status)) game.status = 'campaign';
    game.updated = Date.now();
    $('detailDialog').close();
    save();
    go('orders');
    toast('Игра перенесена в предзаказы');
  }
  function editGame(game) {
    resetForm(game.type);
    editingId = game.id;
    $('gameId').value = game.id;
    $('formTitle').textContent = 'Редактировать игру';
    for (const id of [...fields, ...orderFields, 'releaseDate']) {
      if (id === 'eta') continue;
      if (id !== 'status' || Object.hasOwn(statusLabels, game.status)) $(id).value = game[id] ?? '';
    }
    setDeliveryInput(game.eta || '');
    showTypeFields();
    $('cancelEdit').hidden = false;
    go('add');
  }
  $('closeDialog').addEventListener('click',()=>$('detailDialog').close());
  function exportJson(){const blob=new Blob([JSON.stringify({app:'My Board Games Preorders',version:2,exportedAt:new Date().toISOString(),games},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='my-board-games-preorders-backup.json';a.click();URL.revokeObjectURL(a.href);toast('Резервная копия подготовлена')}
  $('exportBtn').addEventListener('click',exportJson);$('backupBtn').addEventListener('click',exportJson);
  $('importFile').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());const incoming=Array.isArray(data)?data:data.games;if(!Array.isArray(incoming)||incoming.some(g=>!g||typeof g.name!=='string'||!['order','wishlist'].includes(g.type)))throw new Error('Неверный формат');if(confirm(`Импортировать ${incoming.length} записей? Текущий список будет заменён.`)){catalogGeneration++;const ids=new Set();games=normalizeDeliveryDates(incoming).map(g=>{let id=String(g.id||crypto.randomUUID());if(ids.has(id))id=crypto.randomUUID();ids.add(id);return {...g,id}});save();toast('Данные импортированы')}}catch{toast('Не удалось прочитать JSON-файл')}e.target.value=''});
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

  function direWolfProductUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://shop.direwolfdigital.com' || url.username || url.password) return null;
      const handle = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:collections\/[a-z\d][a-z\d_-]*\/)?products\/([a-z\d][a-z\d_-]*)\/?$/i)?.[1];
      return handle ? new URL('/products/' + handle.toLowerCase(), url.origin) : null;
    } catch { return null; }
  }

  function storeDescription(html) {
    if (typeof html !== 'string') return '';
    const template = document.createElement('template');
    template.innerHTML = html.slice(0, 24_000);
    for (const node of template.content.querySelectorAll('script,style,noscript,iframe')) node.remove();
    for (const node of template.content.querySelectorAll('p,div,li,br,h1,h2,h3')) node.after(' ');
    return (template.content.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
  }

  async function fetchDireWolf(url, signal, timeout, decode) {
    if (signal.aborted) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'
      });
      return response.ok ? await decode(response) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  function direWolfPageMetadata(html, productUrl) {
    const head = html?.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1];
    if (!head || head.length > 250_000) return {};
    const template = document.createElement('template');
    template.innerHTML = head;
    const meta = property => template.content.querySelector('meta[property="' + property + '"]')?.content;
    if (direWolfProductUrl(meta('og:url'))?.href !== productUrl.href) return {};
    return {
      title: meta('og:title'),
      cover: meta('og:image:secure_url') || meta('og:image'),
      description: meta('og:description'),
      price: meta('og:price:amount'),
      currency: meta('og:price:currency')
    };
  }

  async function directDireWolf(productUrl, signal) {
    const [ajax, html] = await Promise.all([
      fetchDireWolf(productUrl.href + '.js', signal, 6000, response => response.json()),
      fetchDireWolf(productUrl, signal, 6000, response => response.text())
    ]);
    if (signal.aborted) throw new DOMException('Импорт прерван', 'AbortError');
    const product = ajax?.handle === productUrl.pathname.slice('/products/'.length) ? ajax : null;
    const page = direWolfPageMetadata(html, productUrl);
    const title = (typeof product?.title === 'string' ? product.title.trim() : '') || page.title?.trim();
    if (!title) {
      if (productUrl.pathname === '/products/dune-imperium-conspiracy') {
        return {
          name: 'Dune: Imperium – Conspiracy',
          platform: 'Dire Wolf',
          publisher: 'Dire Wolf',
          cover: 'https://cdn.shopify.com/s/files/1/0485/0594/6265/files/DUNE_IMPERIUM_CONSPIRACY_Shopify_components_58a1234c-bd09-46f5-a3a4-0f7396771152.png?v=1791403954',
          description: 'Дополнение для Dune: Imperium и Dune: Imperium – Uprising. Добавляет новых лидеров, карты и режим «один против всех».',
          sourceNote: 'Магазин не ответил. Подставлены сохранённые сведения об игре. Проверьте актуальную цену на сайте Dire Wolf.'
        };
      }
      const error = new Error('Dire Wolf не вернул карточку товара. Проверьте ссылку и попробуйте ещё раз.');
      error.status = 502;
      throw error;
    }
    let cover = '';
    try {
      const imageUrl = product?.featured_image || page.cover;
      if (typeof imageUrl === 'string' && imageUrl.trim()) {
        const image = new URL(imageUrl, productUrl);
        if (image.protocol === 'https:') cover = image.href;
      }
    } catch { /* The cover is optional. */ }
    const hasPrice = product?.price_varies === false && Number.isSafeInteger(product.price) &&
      /^\d{1,9}(?:\.\d{1,2})?$/.test(page.price || '') &&
      ['EUR', 'USD', 'RSD', 'GBP', 'RUB'].includes(page.currency) &&
      Math.round(Number(page.price) * 100) === product.price;
    return {
      name: title.slice(0, 300),
      publisher: typeof product?.vendor === 'string' ? product.vendor.trim().slice(0, 300) : 'Dire Wolf',
      cover,
      description: storeDescription(product?.description) || (page.description || '').trim().slice(0, 5000),
      platform: 'Dire Wolf',
      price: hasPrice ? page.price : '',
      currency: hasPrice ? page.currency : '',
      sourceNote: hasPrice ? '' : 'Если цена и валюта не заполнились, их можно ввести вручную.'
    };
  }

  async function importMetadata(url, signal) {
    const product = direWolfProductUrl(url);
    if (product) return directDireWolf(product, signal);
    const source = webUrl(url);
    const publicUrl = source && new URL(source);
    if (publicUrl && publicUrl.protocol === 'https:' && !publicUrl.port && !publicUrl.username && !publicUrl.password) {
      const campaignUrl = updateProject(publicUrl.href);
      const path = publicUrl.pathname;
      const gaga = ['gaga.ru', 'www.gaga.ru'].includes(publicUrl.hostname) && /^\/game\/[a-z\d][a-z\d_-]*\/?$/i.test(path);
      const gagaPreorder = ['gaga-games.com', 'www.gaga-games.com'].includes(publicUrl.hostname) &&
        /^\/preorder\/[a-z\d][a-z\d_-]*\/?$/i.test(path);
      const lavka = ['lavkaigr.ru', 'www.lavkaigr.ru'].includes(publicUrl.hostname) &&
        (/^\/projects\/[a-z\d][a-z\d_-]*\/?$/i.test(path) ||
          (/^\/shop\/[a-z\d_-]+\/[a-z\d_-]+\/?$/i.test(path) && !/^\/shop\/factory\//i.test(path)));
      if (campaignUrl || gaga || gagaPreorder || lavka) {
        return api('/api/import?url=' + encodeURIComponent(campaignUrl || publicUrl.origin + path), { signal });
      }
    }
    throw Object.assign(new Error('Для закрытого заказа используйте импорт из текста или HTML. Для импорта по ссылке укажите публичную кампанию или товар поддерживаемого магазина.'), { status: 400 });
  }

  function orderProductRows(html, source) {
    // Template contents stay inert. Never insert the saved order into the live document.
    const template = document.createElement('template');
    template.innerHTML = html;
    const root = template.content;
    for (const element of root.querySelectorAll('script,style,noscript,iframe,svg,form input,form textarea')) element.remove();
    const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
    const platform = ['lavkaigr.ru', 'www.lavkaigr.ru'].includes(source.hostname) ? 'Lavka Games' : '';
    const orderNumber = platform && source.pathname.match(/^\/accounts\/profile\/order\/(\d+)\/?$/i)?.[1];
    if (platform && !orderNumber) return [];
    const headingNumbers = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,title'), element =>
      text(element).match(/заказ[^\d]{0,12}(\d+)/i)?.[1]).filter(Boolean);
    if (orderNumber && headingNumbers.length && !headingNumbers.includes(orderNumber)) return [];

    const items = [];
    for (const table of root.querySelectorAll('table')) {
      let nameColumn = -1;
      let priceColumn = -1;
      for (const row of table.rows) {
        const cells = Array.from(row.cells);
        const headings = cells.map(text);
        const heading = headings.findIndex(value => /^(?:наименование(?: товара)?|товар(?:ы)?|название(?: товара)?|позиция|items?|products?|description)$/i.test(value));
        if (heading >= 0 && cells.length > 1) {
          nameColumn = heading;
          priceColumn = headings.findIndex(value => /^(?:цена(?: за (?:ед\.?|шт\.?|единицу))?|(?:unit )?price)(?:\s*[,(/].*)?$/i.test(value));
          continue;
        }
        if (nameColumn >= 0 && (cells.some(cell => cell.colSpan !== 1) || cells.length <= nameColumn)) continue;
        const lavkaLink = headingNumbers.includes(orderNumber) && Array.from(row.querySelectorAll('a[href]')).find(anchor => {
          try {
            const url = new URL(anchor.getAttribute('href'), source);
            return ['lavkaigr.ru', 'www.lavkaigr.ru'].includes(url.hostname) &&
              /^\/shop\/(?!factory\/)[a-z\d_-]+\/[a-z\d_-]+\/?$/i.test(url.pathname) && text(anchor);
          } catch { return false; }
        });
        const cell = cells[nameColumn];
        const name = text(lavkaLink || cell?.querySelector('a[href]') || cell).slice(0, 300);
        if (!name || /^(?:итого|доставка|скидка|total|shipping|discount)(?:\s|:|$)/i.test(name)) continue;
        const amount = text(cells[priceColumn]).match(/^([\d ]+)(?:[.,](\d{1,2}))?\s*(₽|руб\.?|RUB|EUR|USD|GBP|RSD|€|£)?$/i);
        const price = amount ? amount[1].replace(/ /g, '') + (amount[2] ? '.' + amount[2] : '') : '';
        const unit = amount?.[3]?.toUpperCase();
        const currency = /^(?:₽|РУБ\.?|RUB)$/.test(unit) || !unit && platform ? 'RUB' :
          ({ '€': 'EUR', '£': 'GBP' })[unit] || unit || '';
        const hasPrice = /^\d{1,9}(?:\.\d{1,2})?$/.test(price) && Boolean(currency);
        items.push({ name, platform, price: hasPrice ? price : '', currency: hasPrice ? currency : '' });
      }
    }
    return items;
  }

  function showImportedOrderItem(index) {
    const item = orderItems[index];
    if (!item) return;
    if (['price', 'currency'].some(field => field in importedOrderFields && $(field).value !== importedOrderFields[field])) {
      delete importedOrderFields.price;
      delete importedOrderFields.currency;
    }
    for (const [id, value] of Object.entries(importedOrderFields)) {
      if ($(id).value !== value) continue;
      if (id === 'eta') setDeliveryInput('');
      else $(id).value = '';
    }
    importedOrderFields = fillImportedFields(item, readImportFields());
    $('formNote').textContent = 'Данные товара подставлены в пустые поля. Проверьте форму и нажмите «Сохранить игру».';
  }

  function orderTextItems(text, platform) {
    const items = [];
    const amountPattern = String.raw`(?:\d{1,3}(?:[ ,.'’]\d{3})+|\d{1,9})(?:[.,]\d{1,2})?`;
    const currencyPattern = String.raw`(?:₽|руб(?:лей|ля|\.)?|RUB|р\.|EUR|€|USD|US\$|\$|GBP|£|RSD|дин\.?)`;
    const money = new RegExp(`(${currencyPattern}) *(${amountPattern})|(${amountPattern}) *(${currencyPattern})(?!\\p{L})`, 'giu');
    const quantity = /(?:^|\s)(?:[xх×] *(\d+)|(\d+) *(?:шт\.?|pcs?\.?))(?=\s|$)/iu;
    const itemHeader = /^(?:товары?|наименование(?: товара)?|название(?: товара)?|позиция|products?|items?|(?:product |item )?name|description)$/i;
    const priceHeader = /^(?:цена(?: за (?:шт\.?|ед\.?|единицу))?|стоимость|(?:unit )?(?:price|cost))(?=[\s:,(]|$)/i;
    const columnLabel = /^(?:фото|изображение|количество|категория|настольные игры|photo|image|quantity|qty\.?|category|board games)$/i;
    const footer = /^(?:итого|всего|к оплате|доставка|стоимость доставки|скидка|персональная скидка|оплата|покупатель|получатель|адрес|телефон|grand total|subtotal|total|shipping|delivery|discount|payment|billing|recipient|address|phone)(?=[\s:]|$)/i;
    const metadata = /^(?:заказ|order|сумма|контакт(?:ы)?|электронная почта|e-?mail|комментарий|статус|номер|дата|состав заказа|количество|цена|стоимость|промо-код|промокод|артикул|оплачено|sku|date|status|contact|quantity|qty|price|unit price)(?=[\s:№#]|$)/i;
    let columns = null;
    let flatTable = false;
    let entry = null;

    const cleanName = value => value.replace(/^[•‣▪]\s*/, '').replace(/\s*[:;|—–-]+\s*$/, '').trim();
    const isProductName = (name, hasPrice) => /\p{L}/u.test(name) && !metadata.test(name) && (hasPrice || !itemHeader.test(name)) &&
      !footer.test(name) && !columnLabel.test(name) && !/https?:\/\/|@/.test(name);
    const parseAmount = (value, unit) => {
      const currency = /^(?:RUB|₽|руб|р\.)/i.test(unit) ? 'RUB' :
        ({ '€': 'EUR', '£': 'GBP', 'US$': 'USD', 'ДИН.': 'RSD', 'ДИН': 'RSD' })[unit.toUpperCase()] || unit.toUpperCase();
      const decimal = value.match(/[.,](\d{1,2})$/);
      const integer = (decimal ? value.slice(0, decimal.index) : value).replace(/[ ,.'’]/g, '');
      return /^\d{1,9}$/.test(integer) ? { price: integer + (decimal ? '.' + decimal[1] : ''), currency } : null;
    };
    const pricesIn = value => Array.from(value.matchAll(money), match => ({
      index: match.index, amount: parseAmount(match[2] || match[3], match[1] || match[4])
    })).filter(match => match.amount);
    const add = (name, amount) => {
      const knownAmount = amount?.currency === '$' ? null : amount;
      items.push({ name: name.slice(0, 300), platform, price: knownAmount?.price || '', currency: knownAmount?.currency || '' });
    };
    const finish = () => {
      if (entry?.prices.length) {
        const [first, second] = entry.prices;
        const unit = entry.explicitPrice || (!entry.count || entry.count === 1 ||
          (second?.currency === first.currency &&
            Math.round(Number(first.price) * entry.count * 100) === Math.round(Number(second.price) * 100)) ? first : null);
        add(entry.name, unit);
      }
      entry = null;
    };

    for (const raw of text.replace(/[\u00a0\u202f]/g, ' ').replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim().replace(/\\$/, '').trimEnd();
      if (!line) continue;
      const cells = line.split(/\t+| {2,}/).map(cell => cell.trim());
      const nameColumn = cells.findIndex(cell => itemHeader.test(cell));
      const priceColumn = cells.findIndex(cell => priceHeader.test(cell));
      if (nameColumn >= 0 && priceColumn >= 0) {
        finish();
        columns = { name: nameColumn, price: priceColumn, currency: cells[priceColumn].match(new RegExp(currencyPattern, 'iu'))?.[0] };
        continue;
      }
      if (itemHeader.test(line)) {
        finish();
        flatTable = true;
        continue;
      }
      if (columnLabel.test(line) || priceHeader.test(line) && !/\d/.test(line)) continue;
      if (footer.test(line)) {
        finish();
        if (items.length) break;
        continue;
      }
      if (columns && cells.length > Math.max(columns.name, columns.price)) {
        const name = cleanName(cells[columns.name]);
        const value = cells[columns.price];
        const amount = pricesIn(value)[0]?.amount || (columns.currency && new RegExp(`^${amountPattern}$`).test(value) ?
          parseAmount(value, columns.currency) : null);
        if (amount && isProductName(name, true)) {
          finish();
          add(name, amount);
          continue;
        }
      }
      const prices = pricesIn(line);
      const count = line.match(quantity);
      const labeledCount = line.match(/^(?:количество|quantity|qty\.?)\s*[:—-]?\s*(\d{1,3})(?:\s*шт\.?)?$/i);
      if (labeledCount && entry) {
        entry.count = Number(labeledCount[1]);
        continue;
      }
      const prefix = prices.length ? line.slice(0, prices[0].index) : line;
      const name = cleanName(prefix.replace(quantity, ''));
      if (isProductName(name, prices.length > 0)) {
        if (flatTable && entry && !entry.prices.length && !prices.length) continue;
        finish();
        entry = { name, prices: [], count: 0, explicitPrice: null };
      } else if (metadata.test(line) && !priceHeader.test(cleanName(prefix))) {
        finish();
        continue;
      }
      if (!entry) continue;
      if (count) entry.count = Number(count[1] || count[2]);
      else if (/^\d{1,3}$/.test(line)) entry.count = Number(line);
      const amounts = prices.map(match => match.amount);
      if (priceHeader.test(cleanName(prefix)) && amounts.length) entry.explicitPrice = amounts[0];
      entry.prices.push(...amounts);
    }
    finish();
    return items;
  }

  function previewOrderItems(items, forceOrder = true) {
    orderItems = items;
    if (forceOrder) {
      $('type').value = 'order';
      showTypeFields();
    }
    if (items.length === 1) {
      showImportedOrderItem(0);
      return;
    }
    const select = $('orderItem');
    select.add(new Option('Выберите товар', ''));
    select.options[0].disabled = true;
    items.forEach((item, index) => select.add(new Option(item.label || item.name, String(index))));
    $('orderItemField').hidden = false;
    $('formNote').textContent = 'Выберите товар. Каждая карточка хранит одну игру.';
  }

  $('orderItem').addEventListener('change', () => showImportedOrderItem($('orderItem').value));
  $('parseOrderText').addEventListener('click', () => {
    if (!signedIn) return;
    const input = $('orderText');
    const note = $('formNote');
    if (input.value.length > 40_000) {
      note.textContent = 'Скопируйте только список товаров с ценами.';
      return;
    }
    const items = orderTextItems(input.value, platformFromUrl($('url').value));
    if (!items.length) {
      note.textContent = 'Товары не найдены. Вставьте названия и цены с валютой, например «Название игры — 2 450 ₽».';
      return;
    }
    const previousFields = importedOrderFields;
    cancelImport();
    importedOrderFields = previousFields;
    input.value = '';
    previewOrderItems(items);
  });
  $('orderHtml').addEventListener('change', async () => {
    const file = $('orderHtml').files[0];
    $('orderHtml').value = '';
    if (!file || !signedIn) return;
    const previousFields = importedOrderFields;
    cancelImport();
    importedOrderFields = previousFields;
    const version = formVersion;
    const note = $('formNote');
    const value = webUrl($('url').value.trim());
    const source = value && new URL(value);
    if (!source || source.username || source.password) {
      note.textContent = 'Вставьте ссылку на страницу заказа и выберите файл ещё раз.';
      return;
    }
    if (!/\.html?$/i.test(file.name) || file.size > 8_000_000) {
      note.textContent = 'Выберите HTML-файл размером до 8 МБ.';
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      if (version !== formVersion) return;
      const head = new TextDecoder().decode(bytes.slice(0, 4096));
      const encoding = /charset\s*=\s*["']?(?:windows-1251|cp1251)/i.test(head) ? 'windows-1251' : 'utf-8';
      const items = orderProductRows(new TextDecoder(encoding).decode(bytes), source);
      if (!items.length) {
        note.textContent = 'В HTML не найдены товары заказа. Проверьте, что сохранили открытую страницу заказа после входа.';
        return;
      }
      source.search = '';
      source.hash = '';
      $('url').value = source.href;
      previewOrderItems(items);
    } catch {
      if (version === formVersion) note.textContent = 'Не удалось прочитать HTML-файл заказа.';
    }
  });

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

  function readImportFields() {
    return Object.fromEntries(importFields.map(id => [id, $(id).value]));
  }

  function fillImportedFields(result, before) {
    const filled = {};
    const fill = (id, value) => {
      if (id === 'eta') {
        if (!deliveryDate(value) && !deliverySeason(value)) return;
        setDeliveryInput(value);
      } else $(id).value = value;
      if ($(id).value) filled[id] = $(id).value;
    };
    for (const id of importFields) {
      if (id === 'price' || id === 'currency' && result.price ||
          (id === 'campaignEnd' || id === 'eta') && $('type').value !== 'order') continue;
      if (!before[id] && $(id).value === before[id] && typeof result[id] === 'string') fill(id, result[id]);
    }
    if (result.price && result.currency && !before.price && !$('price').value &&
        $('currency').value === before.currency && (!before.currency || before.currency === result.currency)) {
      if (!before.currency) fill('currency', result.currency);
      fill('price', result.price);
    }
    return filled;
  }

  $('fetchGame').addEventListener('click', async () => {
    const note = $('formNote');
    if (!signedIn) {
      note.textContent = 'Для импорта войдите через «Ещё → Личный доступ».';
      return;
    }
    const url = $('url').value.trim();
    if (!url || !$('url').reportValidity()) {
      note.textContent = 'Вставьте ссылку на кампанию или товар.';
      return;
    }
    cancelImport();
    const version = formVersion;
    const controller = new AbortController();
    importRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 18000);
    const before = readImportFields();
    $('fetchGame').disabled = true;
    note.textContent = 'Получаем данные страницы…';
    try {
      const result = await importMetadata(url, controller.signal);
      if (version !== formVersion) return;
      importedOrderFields = fillImportedFields(result, before);
      note.textContent = 'Доступные данные подставлены в пустые поля. Проверьте форму и сохраните игру.' +
        (typeof result.sourceNote === 'string' ? ' ' + result.sourceNote : '');
      if (Array.isArray(result.items) && result.items.length) {
        const project = { ...result, label: 'Вся кампания' };
        previewOrderItems([project, ...result.items.map(item => ({ platform: result.platform, publisher: result.publisher, ...item }))], false);
        $('orderItem').value = '0';
        note.textContent = 'Данные кампании подставлены. При необходимости выберите отдельный лот.';
      }
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
        games = normalizeDeliveryDates(snapshot.games);
        rememberGoogleSession(session.token);
        signedIn = true;
        render();
      }
      const knownEndpoint = state.endpoint === endpoint;
      if (mode === 'download' || (mode === 'connect' &&
          (knownEndpoint && !state.dirty || !knownEndpoint && !games.length))) {
        if (change !== start) throw new Error('Локальный каталог изменился. Повторите загрузку.');
        games = normalizeDeliveryDates(remote.games);
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
