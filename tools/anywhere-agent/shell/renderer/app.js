/*
 * The window's DOM half.
 *
 * It renders one thing: the tab strip, and the page that belongs to the active tab.
 * A service page is a native view owned by the main process and drawn over the page
 * area, so this file draws nothing for it - it only asks the main process where the
 * page area is and lets the view cover it.
 *
 * Everything about *what* is shown comes from `view.js` (a pure projection of the
 * agent snapshot) and from `tabs` in the same snapshot. This file never decides
 * state; it applies it. That split is what keeps the interface testable without a
 * window, and it is the same split the previous shell had.
 */

const el = Object.fromEntries(
  [
    'tabbar',
    'tabs',
    'tab-new',
    'open-palette',
    'open-settings',
    'page',
    'home',
    'home-sub',
    'filter',
    'group-machines',
    'machines-meta',
    'grid-machines',
    'group-services',
    'services-meta',
    'grid-services',
    'home-empty',
    'home-foot',
    'settings',
    'message',
    'banner',
    'agent-bar',
    'agent-text',
    'agent-tier',
    'banner-title',
    'banner-text',
    'banner-actions',
    'server-field',
    'server-input',
    'server-save',
    'server-cancel',
    'palette',
    'palette-scrim',
    'palette-input',
    'palette-list',
    'live',
  ].map((id) => [id, document.getElementById(id)]),
);

/** The eight identity colours a service block can take, assigned by hash so a service keeps its own. */
const PALETTE = ['#4F46E5', '#0D9488', '#B45309', '#BE185D', '#0369A1', '#7C3AED', '#C2410C', '#475569'];

const api = window.anywhere ?? {};
const tabsApi = api.tabs ?? {};

let snapshot = null;
let model = null;
let ui = { query: '', pending: '', note: '', settings: 'network' };
let lastActiveTabId = '';

function call(name, ...args) {
  const fn = tabsApi[name];
  if (typeof fn === 'function') {
    return fn(...args);
  }
  return undefined;
}

/** Stable identity colour for a service id. */
function colorOf(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/** Two letters for a machine, one for a web service; never a favicon. */
function monogramOf(service) {
  const name = String(service.name ?? '');
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  if (service.kind === 'machine') {
    return (letters.slice(0, 2) || '?').toUpperCase();
  }
  return (letters.slice(0, 1) || '?').toUpperCase();
}

/**
 * The services this window can open.
 *
 * The main process sends the catalogue. Until it does (older main, or a harness), the
 * machine list from the snapshot is used: a machine is a service whose address is the
 * machine's own DSH entry.
 */
function servicesOf(snap, projection) {
  if (snap && Array.isArray(snap.services) && snap.services.length > 0) {
    return snap.services;
  }
  const groups = projection?.sidebar?.groups ?? [];
  const machines = groups.flatMap((group) => group.machines ?? []);
  return machines.map((machine) => ({
    id: `machine:${machine.host}`,
    kind: 'machine',
    name: machine.name,
    subtitle: machine.host ?? '',
    host: machine.host,
    local: machine.isLocal === true,
    unread: machine.unreadCount ?? 0,
    needsLogin: machine.needsLogin === true,
  }));
}

/** The tab state the main process sent, or a single home tab for a main that predates tabs. */
function tabsOf(snap) {
  const tabs = snap?.tabs;
  if (tabs && Array.isArray(tabs.items) && tabs.items.length > 0) {
    return tabs;
  }
  return { items: [{ id: 'home', kind: 'home', serviceId: '', title: '首页', active: true }], activeId: 'home' };
}

function openService(service) {
  if (!service) {
    return;
  }
  call('openService', service.id);
}

function activeTab(tabs) {
  return tabs.items.find((tab) => tab.id === tabs.activeId) ?? tabs.items[0] ?? null;
}

/* ------------------------------------------------------------------ rendering */

function apply() {
  if (!snapshot) {
    return;
  }
  model = window.AWView.viewModel(snapshot, {
    query: ui.query,
    selected: '',
    diagnostics: false,
    sidebar: false,
    pending: ui.pending,
    note: ui.note,
    brand: window.AWBrand,
  });

  const services = servicesOf(snapshot, model);
  const tabs = tabsOf(snapshot);
  const tab = activeTab(tabs);

  renderTabs(tabs, services);
  renderBanner();
  applyPage(tab, services, tabs);
  applyDetailBounds(tab);

  if (tab && tab.id !== lastActiveTabId) {
    lastActiveTabId = tab.id;
    el.live.textContent = tab.title || '';
  }
}

function renderTabs(tabs, services) {
  const byId = new Map(services.map((service) => [service.id, service]));
  el.tabs.replaceChildren();
  for (const tab of tabs.items) {
    const service = tab.serviceId ? byId.get(tab.serviceId) : null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    button.dataset.active = tab.id === tabs.activeId ? 'true' : 'false';
    button.dataset.tabId = tab.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', tab.id === tabs.activeId ? 'true' : 'false');
    button.draggable = true;
    button.dataset.index = String(el.tabs.children.length);
    if (tab.tone === 'error') {
      button.dataset.tone = 'error';
    }

    const glyph = document.createElement('span');
    glyph.className = 'mono';
    if (tab.kind === 'home' || tab.kind === 'settings' || !service) {
      glyph.style.background = tab.kind === 'home' ? '#0F766E' : '#475569';
      glyph.innerHTML =
        tab.kind === 'home'
          ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 7.4 8 2.8l5.2 4.6V13a.6.6 0 0 1-.6.6h-3v-3.4H6.4v3.4h-3A.6.6 0 0 1 2.8 13Z"/></svg>'
          : '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.9v1.8M8 12.3v1.8M1.9 8h1.8M12.3 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3"/></svg>';
      glyph.style.color = '#ffffff';
    } else {
      glyph.style.background = colorOf(service.id);
      glyph.textContent = monogramOf(service);
    }
    button.append(glyph);

    if (tab.agent) {
      const agent = document.createElement('span');
      agent.className = 'tab-agent';
      agent.textContent = 'A';
      agent.title = 'Agent 正在操作这个页签';
      button.append(agent);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.serviceId || '未命名';
    button.append(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.dataset.close = tab.id;
    close.setAttribute('aria-label', `关闭 ${title.textContent}`);
    close.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"/></svg>';
    button.append(close);

    el.tabs.append(button);
  }
}

function applyPage(tab, services, tabs) {
  const isHome = !tab || tab.kind === 'home';
  const isSettings = tab?.kind === 'settings';
  const failure = tab?.error ?? null;

  // The bar is outside the page area on purpose: a service page is a native view drawn
  // over the page, so anything inside the page would be behind it.
  const agentBusy = Boolean(tab?.agent) && tab?.kind === 'service';
  el['agent-bar'].hidden = !agentBusy;
  if (agentBusy) {
    el['agent-text'].textContent = `Agent 正在操作「${tab.title || tab.serviceId}」`;
    el['agent-tier'].textContent = tab.agentTier === 'control' ? '可写' : '只读';
    el['agent-tier'].dataset.tier = tab.agentTier === 'control' ? 'control' : 'read-only';
  }

  el.home.hidden = !isHome;
  el.settings.hidden = !isSettings;
  el.message.hidden = !(failure && !isHome && !isSettings);

  if (isHome) {
    renderHome(services, tabs);
  } else if (isSettings) {
    renderSettings();
  } else if (failure) {
    renderFailure(tab, failure);
  }
}

function matches(service, query) {
  if (query === '') {
    return true;
  }
  const needle = query.toLowerCase();
  return `${service.name} ${service.subtitle ?? ''} ${service.host ?? ''}`.toLowerCase().includes(needle);
}

function renderHome(services, tabs) {
  const query = ui.query.trim();
  const machines = services.filter((service) => service.kind === 'machine' && matches(service, query));
  const others = services.filter((service) => service.kind !== 'machine' && matches(service, query));
  const openIds = new Set(tabs.items.filter((tab) => tab.serviceId).map((tab) => tab.serviceId));

  const fill = (host, list) => {
    host.replaceChildren();
    for (const service of list) {
      host.append(cardFor(service, openIds.has(service.id)));
    }
  };
  fill(el['grid-machines'], machines);
  fill(el['grid-services'], others);
  el['group-machines'].hidden = machines.length === 0;
  el['group-services'].hidden = others.length === 0;
  // Both groups count in 个: the noun is a workspace or a system, not hardware.
  el['machines-meta'].textContent = machines.length > 0 ? `${machines.length} 个` : '';
  el['services-meta'].textContent = others.length > 0 ? `${others.length} 个` : '';

  const total = services.filter((service) => matches(service, query)).length;
  el['home-empty'].hidden = total > 0;
  if (total === 0) {
    el['home-empty-text'].textContent = query === '' ? '还没有可打开的服务' : '没有匹配的服务';
  }
}

function cardFor(service, open) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card';
  button.dataset.serviceId = service.id;
  if (open) {
    button.dataset.open = 'true';
  }
  if (service.needsLogin || service.offline) {
    button.dataset.dim = 'true';
  }

  if (service.local) {
    const flag = document.createElement('span');
    flag.className = 'card-flag';
    flag.textContent = '本机';
    flag.title = '就是这台电脑';
    button.append(flag);
  }

  const glyph = document.createElement('span');
  glyph.className = 'mono';
  glyph.style.background = colorOf(service.id);
  glyph.textContent = monogramOf(service);
  button.append(glyph);

  const body = document.createElement('div');
  body.className = 'card-body';
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = service.name;
  body.append(name);

  const sub = document.createElement('div');
  sub.className = 'card-sub';
  const bits = [service.subtitle ?? ''];
  if (open) {
    bits.push('已打开');
  }
  if (service.needsLogin) {
    bits.push('需登录');
  } else if (service.offline) {
    bits.push('离线');
  }
  sub.textContent = bits.filter((bit) => bit !== '').join(' · ');
  body.append(sub);
  button.append(body);

  if (service.unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = service.unread > 99 ? '99+' : String(service.unread);
    badge.setAttribute('aria-label', `${service.unread} 项新结果`);
    button.append(badge);
  }

  button.addEventListener('click', () => openService(service));
  return button;
}

/** The settings page: facts only, and each fact in the group that owns it. */
function renderSettings() {
  const diagnostics = model?.sidebar?.diagnostics ?? [];
  el.settings.replaceChildren();

  const nav = document.createElement('nav');
  nav.className = 'settings-nav';
  nav.setAttribute('aria-label', '设置分组');
  const title = document.createElement('div');
  title.className = 'nav-title';
  title.textContent = '设置';
  nav.append(title);
  for (const [key, label] of [
    ['appearance', '外观'],
    ['network', '网络与登录'],
    ['services', '内网服务'],
    ['tabs', '页签'],
    ['about', '关于'],
  ]) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.dataset.section = key;
    item.setAttribute('aria-selected', ui.settings === key ? 'true' : 'false');
    item.addEventListener('click', () => {
      ui.settings = key;
      renderSettings();
    });
    nav.append(item);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.style.marginTop = 'auto';
  copy.textContent = '复制诊断信息';
  copy.addEventListener('click', () => {
    if (typeof api.copyDiagnostics === 'function') {
      api.copyDiagnostics();
      el.live.textContent = '诊断信息已复制';
    }
  });
  nav.append(copy);

  const body = document.createElement('div');
  body.className = 'settings-body';

  const heading = document.createElement('h2');
  heading.textContent = {
    appearance: '外观',
    network: '网络与登录',
    services: '内网服务',
    tabs: '页签',
    about: '关于',
  }[ui.settings];
  body.append(heading);

  const lead = document.createElement('p');
  lead.className = 'lead';
  lead.textContent = {
    appearance: '跟随系统，或固定为浅色 / 深色',
    network: '这台电脑怎么进入私网 · 只影响本应用，不改系统网络',
    services: '服务目录来自发布通道，也可以自己添加',
    tabs: '启动行为与后台回收',
    about: '版本与诊断',
  }[ui.settings];
  body.append(lead);

  const rows = document.createElement('div');
  rows.className = 'rows';

  if (ui.settings === 'network') {
    for (const row of diagnostics) {
      rows.append(rowOf(row.label, row.value, true));
    }
    // Turning the private network on is the one action the home cannot offer: it is a
    // decision about this machine, not about a service, so it belongs here with the
    // rest of the network facts.
    const fleetRow = document.createElement('div');
    fleetRow.className = 'row';
    const fleetKey = document.createElement('span');
    fleetKey.className = 'key';
    fleetKey.textContent = '其他工作区';
    const fleetValue = document.createElement('span');
    fleetValue.className = 'value';
    fleetValue.textContent = snapshot?.fleet?.state === 'ready' ? '已连上私网' : '只显示这台电脑';
    const fleetAction = document.createElement('button');
    fleetAction.type = 'button';
    fleetAction.className = 'row-action';
    fleetAction.textContent = snapshot?.fleet?.state === 'ready' ? '断开' : '连接其他机器';
    fleetAction.addEventListener('click', () => {
      void (snapshot?.fleet?.state === 'ready' ? api.refresh('disconnect') : api.refresh('connect'));
    });
    fleetRow.append(fleetKey, fleetValue, fleetAction);
    rows.append(fleetRow);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'row row-action';
    action.style.width = '100%';
    action.textContent = '更改服务器地址…';
    action.addEventListener('click', () => showServerField());
    rows.append(action);
  } else if (ui.settings === 'appearance') {
    const row = document.createElement('div');
    row.className = 'row';
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = '主题';
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = '跟随系统';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-action';
    button.textContent = '更改…';
    button.addEventListener('click', () => {
      if (typeof api.appearanceMenu === 'function') {
        api.appearanceMenu();
      }
    });
    row.append(key, value, button);
    rows.append(row);
  } else if (ui.settings === 'tabs') {
    rows.append(rowOf('启动', '恢复上次打开的页签'));
    rows.append(rowOf('后台回收', '10 分钟后释放页面，保留页签'));
    rows.append(rowOf('每个服务', '只开一个页签'));
  } else if (ui.settings === 'services') {
    rows.append(rowOf('来源', '发布通道（fleet.json）'));
    rows.append(rowOf('数量', `${servicesOf(snapshot, model).length} 个`));
    rows.append(rowOf('自定义服务', '即将支持'));
  } else {
    rows.append(rowOf('版本', `${snapshot?.app?.version ?? '—'}${snapshot?.app?.build ? `（构建 ${snapshot.app.build}）` : ''}`));
    rows.append(rowOf('服务器', snapshot?.server?.line ?? '还没有地址'));
  }

  body.append(rows);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (ui.settings === 'about') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.textContent = '复制诊断信息';
    button.addEventListener('click', () => {
      if (typeof api.copyDiagnostics === 'function') {
        api.copyDiagnostics();
        el.live.textContent = '诊断信息已复制';
      }
    });
    actions.append(button);
  }
  body.append(actions);

  el.settings.append(nav, body);
}

function rowOf(label, value, mono) {
  const row = document.createElement('div');
  row.className = 'row';
  const key = document.createElement('span');
  key.className = 'key';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = mono ? 'value mono-text' : 'value';
  val.textContent = value ?? '';
  val.title = value ?? '';
  row.append(key, val);
  return row;
}

/**
 * Failure copy, in the window's own language.
 *
 * Chromium's descriptions are English and carry an internal code and the URL, which is
 * not something to hand a person. The table covers the failures a private network
 * actually produces; anything else falls back to one honest sentence and keeps the code
 * visible for whoever has to diagnose it.
 */
const FAILURE_COPY = {
  ERR_CONNECTION_REFUSED: '这个服务没有在监听，可能已经下线。',
  ERR_CONNECTION_TIMED_OUT: '它没有在规定时间内应答。',
  ERR_CONNECTION_RESET: '连接被重置了。',
  ERR_CONNECTION_CLOSED: '连接被对方关掉了。',
  ERR_NAME_NOT_RESOLVED: '这个名字在私网里解析不出来。',
  ERR_ADDRESS_UNREACHABLE: '这个地址在当前网络里不可达。',
  ERR_UNSAFE_PORT: '这个端口浏览器不允许访问。',
  ERR_EMPTY_RESPONSE: '它接收了请求，但没有返回任何内容。',
  ERR_CERT_AUTHORITY_INVALID: '它的证书不被信任。',
  ERR_SSL_PROTOCOL_ERROR: '加密连接没有谈成。',
};

function failureText(failure) {
  const mapped = FAILURE_COPY[failure?.code ?? ''];
  if (mapped) {
    return mapped;
  }
  const reason = String(failure?.reason ?? '');
  // A description that starts with a code is Chromium talking to itself.
  return reason !== '' && !/^ERR_[A-Z_]+/.test(reason) ? reason : '这个服务没有应答。';
}

function renderFailure(tab, failure) {
  const wrap = document.createElement('div');
  wrap.className = 'message-inner';
  const icon = document.createElement('div');
  icon.className = 'icon';
  icon.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8"/><path d="M7 8h10v4a5 5 0 0 1-5 5a5 5 0 0 1-5-5V8Z"/><path d="M12 17v3.5"/><path d="M4.5 20.5l15-17" stroke-width="1.5"/></svg>';
  const h2 = document.createElement('h2');
  h2.textContent = '无法访问这个服务';
  const target = document.createElement('p');
  target.className = 'target';
  target.textContent = tab.title || tab.serviceId || '';
  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = failureText(failure);
  const code = document.createElement('p');
  code.className = 'code';
  code.textContent = failure.code ?? '';
  const actions = document.createElement('div');
  actions.className = 'actions';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button primary';
  retry.textContent = '重试';
  retry.addEventListener('click', () => call('reload', tab.id));
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'button';
  home.textContent = '打开首页';
  home.addEventListener('click', () => call('openHome'));
  actions.append(retry, home);
  wrap.append(icon, h2, target, body, code, actions);
  el.message.replaceChildren(wrap);
}

/** The banner is the only window-wide state left: the local host not being ready, or the private network needing a person. */
function renderBanner() {
  const state = model?.detail?.state;
  const actions = state?.actions ?? [];
  const show =
    model?.detail?.kind !== 'workspace' &&
    Boolean(state?.title || state?.body) &&
    snapshot.state !== 'ready' &&
    snapshot.state !== 'local';
  el.banner.hidden = !show;
  if (!show) {
    return;
  }
  el.banner.dataset.tone = snapshot.state === 'error' ? 'danger' : 'info';
  el['banner-title'].textContent = state.title ?? '';
  el['banner-text'].textContent = state.body ?? '';
  el['banner-actions'].replaceChildren();
  for (const action of actions) {
    const id = typeof action === 'string' ? action : action.id;
    const label = typeof action === 'string' ? labelOfAction(id) : action.label;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.dataset.action = id;
    button.textContent = label;
    button.disabled = ui.pending !== '' && id === 'login-open';
    button.addEventListener('click', () => void runAction(id));
    el['banner-actions'].append(button);
  }
}

function labelOfAction(id) {
  return (
    {
      'login-open': '登录',
      'run-installer': '在终端运行安装器',
      retry: '重试',
      'set-server': '设置服务器',
      connect: '登录',
      'fleet-off': '改用本机',
    }[id] ?? id
  );
}

async function runAction(action) {
  if (action === 'login-open') {
    if (ui.pending === 'login') {
      return;
    }
    ui.pending = 'login';
    ui.note = '';
    apply();
    try {
      const fresh = await api.freshLogin();
      ui.pending = '';
      if (!fresh || fresh.ok === false) {
        ui.note = fresh?.reason ?? '登录链接没有生成';
        apply();
        return;
      }
      apply();
      await api.openExternal(fresh.url);
    } catch (error) {
      ui.pending = '';
      ui.note = String(error?.message ?? error);
      apply();
    }
    return;
  }
  if (action === 'set-server') {
    showServerField();
    return;
  }
  if (action === 'connect') {
    await api.refresh('connect');
    return;
  }
  if (action === 'fleet-off') {
    await api.refresh('disconnect');
    return;
  }
  if (action === 'retry') {
    await api.refresh();
    return;
  }
  if (action === 'run-installer') {
    const opened = await api.runInstaller();
    if (!opened || opened.ok === false) {
      ui.note = opened?.reason ?? '无法打开终端，请复制命令自行运行';
      apply();
    }
  }
}

function showServerField() {
  el['server-field'].hidden = false;
  el['server-input'].value = snapshot?.server?.line ?? '';
  el['server-input'].focus();
  el['server-input'].select();
}

function closeServerField() {
  el['server-field'].hidden = true;
  el['server-input'].value = '';
}

async function saveServerField() {
  const value = el['server-input'].value.trim();
  if (value === '') {
    return;
  }
  const result = await api.setServer(value);
  if (result && result.ok === false) {
    el['server-input'].value = '';
    el['server-input'].placeholder = result.reason ?? '这个地址不可用';
    return;
  }
  closeServerField();
  apply();
}

/* -------------------------------------------------------------- native bounds */

let boundsFrame = 0;

/** Tells the main process where the page area is, so a service's native view can cover it. */
function applyDetailBounds(tab) {
  const isService = tab?.kind === 'service';
  if (boundsFrame) {
    cancelAnimationFrame(boundsFrame);
  }
  boundsFrame = requestAnimationFrame(() => {
    boundsFrame = 0;
    if (typeof api.detailBounds !== 'function') {
      return;
    }
    if (!isService) {
      api.detailBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const rect = el.page.getBoundingClientRect();
    api.detailBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });
}

/* ------------------------------------------------------------------ palette */

function openPalette() {
  el['palette-scrim'].hidden = false;
  el.palette.hidden = false;
  el['palette-input'].value = '';
  el['palette-input'].focus();
  renderPalette('');
}

function closePalette() {
  el.palette.hidden = true;
  el['palette-scrim'].hidden = true;
}

function renderPalette(query) {
  const services = servicesOf(snapshot, model).filter((service) => matches(service, query));
  el['palette-list'].replaceChildren();
  services.slice(0, 12).forEach((service, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'palette-item';
    item.dataset.active = index === 0 ? 'true' : 'false';
    item.dataset.serviceId = service.id;
    const glyph = document.createElement('span');
    glyph.className = 'mono';
    glyph.style.background = colorOf(service.id);
    glyph.textContent = monogramOf(service);
    const label = document.createElement('span');
    label.textContent = service.name;
    item.append(glyph, label);
    item.addEventListener('click', () => {
      closePalette();
      openService(service);
    });
    el['palette-list'].append(item);
  });
}

/* ---------------------------------------------------------------- interactions */

el['tab-new'].addEventListener('click', () => call('openHome'));
el['open-settings'].addEventListener('click', () => call('openSettings'));
el['open-palette'].addEventListener('click', openPalette);

el.tabs.addEventListener('click', (event) => {
  const close = event.target.closest('.tab-close');
  if (close) {
    event.stopPropagation();
    call('close', close.dataset.close);
    return;
  }
  const tab = event.target.closest('.tab');
  if (tab) {
    call('activate', tab.dataset.tabId);
  }
});

/**
 * Reordering: the browser idiom, and the only way to make tab order mean something.
 *
 * The drop asks the main process, which owns the order; this file never reorders its
 * own copy, or the next push would put the strip back where it was.
 */
let dragFrom = -1;

el.tabs.addEventListener('dragstart', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) {
    return;
  }
  dragFrom = Number(tab.dataset.index);
  tab.dataset.dragging = 'true';
  event.dataTransfer.effectAllowed = 'move';
});

el.tabs.addEventListener('dragend', (event) => {
  event.target.closest('.tab')?.removeAttribute('data-dragging');
  dragFrom = -1;
});

el.tabs.addEventListener('dragover', (event) => {
  if (dragFrom === -1) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});

el.tabs.addEventListener('drop', (event) => {
  const target = event.target.closest('.tab');
  if (!target || dragFrom === -1) {
    return;
  }
  event.preventDefault();
  const to = Number(target.dataset.index);
  if (Number.isFinite(to) && to !== dragFrom) {
    call('reorder', dragFrom, to);
  }
  dragFrom = -1;
});

el.tabs.addEventListener('auxclick', (event) => {
  if (event.button !== 1) {
    return;
  }
  const tab = event.target.closest('.tab');
  if (tab) {
    call('close', tab.dataset.tabId);
  }
});

el.filter.addEventListener('input', () => {
  ui.query = el.filter.value;
  apply();
});

el['palette-scrim'].addEventListener('click', closePalette);

el['palette-input'].addEventListener('input', () => renderPalette(el['palette-input'].value));
el['palette-input'].addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closePalette();
    return;
  }
  if (event.key === 'Enter') {
    const first = el['palette-list'].querySelector('.palette-item');
    if (first) {
      closePalette();
      call('openService', first.dataset.serviceId);
    }
  }
});

el['server-save'].addEventListener('click', () => void saveServerField());
el['server-cancel'].addEventListener('click', closeServerField);
el['server-input'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void saveServerField();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeServerField();
  }
});

document.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;

  if (meta && key.toLowerCase() === 't') {
    event.preventDefault();
    call('openHome');
    return;
  }
  if (meta && key.toLowerCase() === 'w') {
    event.preventDefault();
    call('close', tabsOf(snapshot).activeId);
    return;
  }
  if (meta && key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
    return;
  }
  if (meta && key === ',') {
    event.preventDefault();
    call('openSettings');
    return;
  }
  if (meta && /^[1-9]$/.test(key)) {
    const items = tabsOf(snapshot).items;
    const target = items[Number(key) - 1];
    if (target) {
      event.preventDefault();
      call('activate', target.id);
    }
    return;
  }
  if (event.key === 'Escape') {
    if (!el.palette.hidden) {
      closePalette();
    } else if (!el['server-field'].hidden) {
      closeServerField();
    }
  }
});

/* ---------------------------------------------------------------- bootstrap */

async function start() {
  if (typeof api.onSnapshot === 'function') {
    api.onSnapshot((next) => {
      snapshot = next;
      apply();
    });
  }
  if (typeof api.onTabs === 'function') {
    api.onTabs((payload) => {
      snapshot = { ...(snapshot ?? {}), ...payload };
      apply();
    });
  }
  if (typeof api.onSchemeChanged === 'function') {
    api.onSchemeChanged((value) => {
      if (value?.scheme) {
        document.documentElement.dataset.scheme = value.scheme;
      } else {
        delete document.documentElement.dataset.scheme;
      }
    });
  }
  if (typeof api.state === 'function') {
    snapshot = await api.state();
  }
  apply();
}

start().catch((error) => {
  el.banner.hidden = false;
  el['banner-title'].textContent = '窗口没有启动起来';
  el['banner-text'].textContent = String(error?.message ?? error);
});
