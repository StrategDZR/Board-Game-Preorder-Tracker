(() => {
  const KEY = 'mbgp_v02_games';
  let games = load();
  let editingId = null;
  const $ = id => document.getElementById(id);
  const fields = ['url', 'name', 'type', 'platform', 'status', 'price', 'currency',
    'shipping', 'eta', 'notes', 'cover', 'publisher', 'description', 'campaignStart', 'campaignEnd'];
  const importFields = ['name', 'platform', 'cover', 'publisher', 'description', 'campaignStart', 'campaignEnd', 'currency'];
  const cloudKey = 'mbgp_v03_cloud';
  let cloud = null;
  let syncing = false;
  let change = 0;
  let formVersion = 0;
  let importRequest;
  function readSetting(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  let state = readSetting(cloudKey, {});
  function setState(next) {
    state = next;
    localStorage.setItem(cloudKey, JSON.stringify(state));
  }
  const statusLabels = {campaign:'Кампания / предзаказ',production:'Производство',shipping:'Отправлено',delivered:'Доставлено',paused:'Приостановлено'};
  function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch{return []}}
  function writeLocal(){localStorage.setItem(KEY,JSON.stringify(games));render()}
  function save(){
    change++;
    setState({ ...state, dirty: true });
    writeLocal();
    if (cloud && state.endpoint === cloud.endpoint && Number.isInteger(state.revision)) sync('auto');
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
  function showDetail(id){const g=games.find(x=>x.id===id);if(!g)return;const d=$('detailContent');const url=webUrl(g.url);d.innerHTML=`<div class="eyebrow">${g.type==='wishlist'?'WISHLIST':'ПРЕДЗАКАЗ'}</div><h2>${esc(g.name)}</h2><p>${esc(g.platform||'Площадка не указана')} · ${esc(statusLabels[g.status]||'Wishlist')}</p>${url?`<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--gold)">Открыть страницу проекта ↗</a></p>`:''}${[['Автор / издатель', g.publisher], ['Начало кампании', g.campaignStart], ['Конец кампании', g.campaignEnd], ['Описание', g.description]].filter(([,value])=>value).map(([label,value])=>'<p><b>'+label+':</b> '+esc(value)+'</p>').join('')}${g.eta?`<p><b>Ожидаемая дата:</b> ${esc(g.eta)}</p>`:''}${g.type==='order'&&(g.price||g.shipping)?`<p><b>Цена:</b> ${esc(g.price||'—')} ${esc(g.currency)}<br><b>Доставка:</b> ${esc(g.shipping||'—')} ${esc(g.currency)}</p>`:''}${g.notes?`<p>${esc(g.notes)}</p>`:''}<div class="detail-actions"><button class="primary-button" id="editGame">Изменить</button><button class="secondary-button" id="deleteGame">Удалить</button></div>`;$('detailDialog').showModal();$('editGame').onclick=()=>{ $('detailDialog').close();editGame(g)};$('deleteGame').onclick=()=>{if(confirm('Удалить эту запись?')){games=games.filter(x=>x.id!==id);save();$('detailDialog').close();toast('Запись удалена')}}}
  function editGame(g){editingId=g.id;cancelImport();$('gameId').value=g.id;$('formTitle').textContent='Редактировать игру';for(const id of fields)$(id).value=g[id]??'';$('orderFields').style.display=g.type==='order'?'block':'none';$('cancelEdit').style.display='inline-block';go('add')}
  $('closeDialog').addEventListener('click',()=>$('detailDialog').close());
  function exportJson(){const blob=new Blob([JSON.stringify({app:'My Board Games Preorders',version:2,exportedAt:new Date().toISOString(),games},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='my-board-games-preorders-backup.json';a.click();URL.revokeObjectURL(a.href);toast('Резервная копия подготовлена')}
  $('exportBtn').addEventListener('click',exportJson);$('backupBtn').addEventListener('click',exportJson);
  $('importFile').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());const incoming=Array.isArray(data)?data:data.games;if(!Array.isArray(incoming)||incoming.some(g=>!g||typeof g.name!=='string'||!['order','wishlist'].includes(g.type)))throw new Error('Неверный формат');if(confirm(`Импортировать ${incoming.length} записей? Текущий список будет заменён.`)){const ids=new Set();games=incoming.map(g=>{let id=String(g.id||crypto.randomUUID());if(ids.has(id))id=crypto.randomUUID();ids.add(id);return {...g,id}});save();toast('Данные импортированы')}}catch{toast('Не удалось прочитать JSON-файл')}e.target.value=''});
  async function api(path, options = {}) {
    const { endpoint, token } = cloud;
    const response = await fetch(endpoint + path, {
      method: options.method || 'GET',
      signal: options.signal ?? AbortSignal.timeout(18000),
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Ошибка Worker.'), { status: response.status });
    return data;
  }

  $('fetchGame').addEventListener('click', async () => {
    const note = $('formNote');
    if (!cloud) {
      note.textContent = 'Подключите Worker в настройках приложения.';
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
      note.textContent = 'Доступные данные подставлены в пустые поля. Проверьте форму и сохраните игру.';
    } catch (error) {
      if (version === formVersion) note.textContent = error.status ? error.message : 'Worker не ответил. Попробуйте ещё раз.';
    } finally {
      clearTimeout(timeout);
      if (version === formVersion) {
        importRequest = null;
        $('fetchGame').disabled = false;
      }
    }
  });

  function cloudStatus(message) { $('cloudStatus').textContent = message; }
  function cloudButtons() {
    $('connectCloud').disabled = syncing;
    $('downloadCloud').disabled = $('uploadCloud').disabled = syncing || !cloud;
  }
  async function sync(mode) {
    if (!cloud || syncing) return;
    syncing = true;
    cloudButtons();
    const endpoint = cloud.endpoint;
    const start = change;
    let continueSaving = false;
    cloudStatus('Связываемся с D1…');
    try {
      const remote = mode === 'auto' ? null : await api('/api/catalog');
      const knownEndpoint = state.endpoint === endpoint;
      if (mode === 'download' || (mode === 'connect' &&
          (knownEndpoint && !state.dirty || !knownEndpoint && !games.length))) {
        if (change !== start) throw new Error('Локальный каталог изменился. Повторите загрузку.');
        games = remote.games;
        if (editingId) resetForm();
        if ($('detailDialog').open) $('detailDialog').close();
        writeLocal();
        setState({ endpoint, revision: remote.revision, dirty: false });
      } else if (mode === 'connect' && remote.revision !== 0 &&
          (state.endpoint !== endpoint || state.revision !== remote.revision)) {
        setState({ endpoint, dirty: true });
        cloudStatus('Выберите, какой каталог оставить: загрузить из D1 или отправить локальный.');
        return;
      } else {
        const snapshot = change;
        const result = await api('/api/catalog', {
          method: 'PUT',
          body: JSON.stringify({ revision: remote?.revision ?? state.revision, games })
        });
        continueSaving = snapshot !== change;
        setState({ endpoint, revision: result.revision, dirty: continueSaving });
      }
      cloudStatus('Каталог синхронизирован с D1.');
    } catch (error) {
      if (error.status === 409) setState({ endpoint, dirty: true });
      cloudStatus(error.status === 409
        ? 'Каталог изменился на другом устройстве. Выберите, какую версию оставить.'
        : error.status ? error.message : 'Синхронизация не завершилась. Локальные записи доступны. Повторите подключение.');
    } finally {
      syncing = false;
      cloudButtons();
    }
    if (continueSaving) sync('auto');
  }

  $('cloudForm').addEventListener('submit', event => {
    event.preventDefault();
    const endpoint = new URL($('workerUrl').value);
    const loopback = ['localhost', '127.0.0.1'].includes(endpoint.hostname);
    if (!(endpoint.protocol === 'https:' || loopback && endpoint.protocol === 'http:') ||
        endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      cloudStatus('Укажите HTTPS-адрес Worker без пути и параметров.');
      return;
    }
    cloud = { endpoint: endpoint.origin, token: $('accessToken').value };
    localStorage.setItem('mbgp_v03_endpoint', cloud.endpoint);
    sessionStorage.setItem(cloudKey, JSON.stringify(cloud));
    sync('connect');
  });
  $('downloadCloud').addEventListener('click', () => {
    if (!games.length || confirm('Заменить локальный каталог версией из D1?')) sync('download');
  });
  $('uploadCloud').addEventListener('click', () => {
    if (confirm('Заменить каталог в D1 локальной версией?')) sync('upload');
  });
  window.addEventListener('hashchange',()=>{const page=location.hash.slice(1);if(['home','orders','wishlist','add','settings'].includes(page))go(page)});
  const initial=location.hash.slice(1);go(['home','orders','wishlist','add','settings'].includes(initial)?initial:'home');render();
  try { cloud = JSON.parse(sessionStorage.getItem(cloudKey)); } catch { /* local mode */ }
  $('workerUrl').value = cloud?.endpoint || localStorage.getItem('mbgp_v03_endpoint') || '';
  $('accessToken').value = cloud?.token || '';
  cloudButtons();
  if (cloud) sync('connect');
})();
