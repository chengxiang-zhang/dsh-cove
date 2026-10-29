/**
 * Renderer: applies the view model to the DOM, and nothing else.
 *
 * Every decision about what to show lives in view.js, which is a pure function of the
 * agent's snapshot plus this file's small amount of local interface state (search
 * text, selection, whether diagnostics are open, whether the sidebar is showing).
 * The division is what makes "is the sign-in panel visible while connecting?" a
 * question a test answers.
 *
 * The window has two views, and the rail names them: the **home** (a launch pad that
 * says which machine a click would open) and the **workspace** (that machine's own
 * page, embedded). The one piece of behaviour that is not a pure projection is what
 * follows from that: entering a machine is a request the user makes, and the auto-open
 * only re-issues it after a refresh while the workspace is still the current view.
 */

const el = Object.fromEntries(
  [
    'split',
    'sidebar',
    'rail',
    'rail-machines',
    'rail-session',
    'rail-diagnostics',
    'rail-appearance',
    'status',
    'status-label',
    'status-detail',
    'refresh',
    'query',
    'groups',
    'account',
    'account-dot',
    'account-name',
    'account-line',
    'account-action',
    'diagnostics-toggle',
    'diagnostics-rows',
    'detail',
    'detail-body',
    'sidebar-toggle',
    'window-title',
    'state-panel',
    'welcome',
    'welcome-tagline',
    'state-title',
    'state-body',
    'state-actions',
    'state-server',
    'state-server-row',
    'state-note',
    'server-field',
    'server-input',
    'server-save',
    'server-cancel',
    'server-note',
    'notice',
    'live',
  ].map((id) => [id, document.getElementById(id)]),
);

/** The agent's last report, and the interface state this file owns. */
let snapshot = null;
const ui = { query: '', selected: '', diagnostics: false, sidebar: true, opened: '', mode: 'home', pending: '', note: '', serverOpen: false };
let model = null;

/** The actions a state offers, as buttons the user can press. */
const ACTION_LABELS = {
  // A button, not a link: the hand-off URL is short-lived, so it is minted when the button
  // is pressed and handed straight to the browser.
  'login-open': { label: '登录', primary: true },
  'fleet-off': { label: '改用本机' },
  connect: { label: '登录', primary: true },
  retry: { label: '重试', primary: true },
  'run-installer': { label: '在终端运行安装器' },
  // The address this install enrolls against, opened from the panels where it is the missing
  // or wrong fact, so the sign-in screen itself stays a single decision.
  'set-server': { label: '设置服务器' },
};

/** The states whose panel is about the private network, where the address belongs. */
const FLEET_PANELS = ['connecting', 'login-required', 'empty', 'error'];

/** The machines currently shown, in the order they appear: keyboard order. */
function visibleMachines() {
  if (!model) {
    return [];
  }
  return model.sidebar.groups.flatMap((group) => group.machines);
}

function applyMachines() {
  el.groups.replaceChildren();
  for (const group of model.sidebar.groups) {
    const section = document.createElement('section');
    const head = document.createElement('div');
    head.className = 'group-head';
    const title = document.createElement('span');
    title.className = 'group-title';
    title.textContent = group.title;
    head.append(title);
    if (group.action) {
      const action = document.createElement('button');
      action.className = 'group-action';
      action.type = 'button';
      action.textContent = group.action.label;
      action.addEventListener('click', () => runAction(group.action.id));
      head.append(action);
    }
    section.append(head);

    if (group.machines.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'group-hint';
      hint.textContent = group.hint ?? (model.sidebar.query.trim() === '' ? '暂无' : '没有匹配的机器');
      section.append(hint);
    }

    for (const machine of group.machines) {
      const row = document.createElement('button');
      row.className = 'machine';
      row.type = 'button';
      row.dataset.host = machine.host;
      row.dataset.unread = machine.unread ? 'true' : 'false';
      row.dataset.local = machine.isLocal ? 'true' : 'false';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', machine.selected ? 'true' : 'false');
      // The label and the hover text carry every mark the row shows, so nothing on
      // this row is information a person can only get by seeing it.
      row.setAttribute('aria-label', machine.label);
      row.title = machine.title;

      const dot = document.createElement('span');
      dot.className = 'machine-dot';
      dot.dataset.needsLogin = machine.needsLogin ? 'true' : 'false';
      dot.setAttribute('aria-hidden', 'true');

      const body = document.createElement('div');
      body.className = 'machine-body';
      const name = document.createElement('div');
      name.className = 'machine-name';
      name.textContent = machine.name;
      const host = document.createElement('div');
      host.className = 'machine-host';
      host.textContent = machine.line;
      // The address is the column the stylesheet clips, and it is also the thing a person
      // needs in full to reach the machine from anywhere else. The full host travels as
      // hover text rather than being lost to the ellipsis.
      host.title = machine.host ?? '';
      body.append(name, host);

      row.append(dot, body);
      if (machine.badge !== '') {
        const badge = document.createElement('span');
        badge.className = 'machine-badge';
        badge.textContent = machine.badge;
        row.append(badge);
      }
      // The second mark, and a separate one on purpose: the dot on the left says
      // whether this machine can be entered, this one says how much work finished
      // inside while the user was looking elsewhere. The count is written, not just
      // coloured, so "three conversations finished" is readable at a glance and the
      // same fact reaches a screen reader through the row's name.
      if (machine.unread) {
        const unread = document.createElement('span');
        unread.className = 'machine-unread';
        // The tone is a fact from the row, not a decision taken here: a failure keeps the
        // alarm fill, ordinary finished work is a count in ordinary text colour.
        unread.dataset.tone = machine.unreadTone;
        unread.textContent = machine.unreadCount > 99 ? '99+' : String(machine.unreadCount);
        unread.setAttribute('aria-hidden', 'true');
        row.append(unread);
      }
      row.addEventListener('click', () => select(machine.host));
      section.append(row);
    }
    el.groups.append(section);
  }
}

function applyAccount() {
  const account = model.account;
  el.account.dataset.tone = account.tone;
  el.account.disabled = account.disabled === true;
  el['account-name'].textContent = account.name;
  el['account-line'].textContent = account.line;
  el['account-action'].textContent = account.action?.label ?? '';
  el.account.title = [account.name, account.line].filter((part) => part !== '').join(' · ');
  el.account.setAttribute(
    'aria-label',
    [account.name, account.line, account.action?.label].filter((part) => part !== '').join(','),
  );
}

function applyStatePanel() {
  const { state, kind } = model.detail;
  // The embedded workspace covers this pane when there is one; otherwise the pane is
  // the whole explanation of why there is not.
  el['state-panel'].hidden = kind === 'workspace';
  el['state-panel'].dataset.state = state.id;
  el['state-panel'].dataset.kind = state.kind;
  el['state-title'].textContent = state.title;
  el['state-body'].textContent = state.body;
  // The address travels with the panels that are about the private network. It is the
  // fact that turns "连不上" into "this server did not answer", and it is the one the
  // person can change.
  el['state-server-row'].hidden = !FLEET_PANELS.includes(state.id) || state.server === '';
  el['state-server'].textContent = state.server ?? '';
  // The panel's own line: what the pressed button is doing, or why it could not. A failure
  // that only reaches a corner notice reads as "nothing happened" from where the person is
  // looking, which is the button.
  el['state-note'].hidden = state.note === '';
  el['state-note'].textContent = state.note ?? '';
  el['state-note'].dataset.tone = state.noteTone ?? '';

  el['state-actions'].replaceChildren();
  for (const action of state.actions) {
    // A state's actions are ids, because their labels are the app's vocabulary; the
    // home's primary action names the machine it would open, so it arrives complete.
    // The id the handler acts on is the id the state named - reading it off the label
    // table instead left every id-built button with `action-undefined` and a handler that
    // ran nothing, so "重试" and "在浏览器中登录" looked right and did nothing.
    const spec = typeof action === 'string' ? ACTION_LABELS[action] : action;
    const actionId = typeof action === 'string' ? action : String(spec?.id ?? '');
    if (!spec || actionId === '') {
      continue;
    }
    const button = document.createElement('button');
    button.className = 'button';
    button.type = 'button';
    button.id = `action-${actionId}`;
    button.textContent = spec.label;
    if (spec.primary) {
      button.dataset.variant = 'primary';
    }
    // A button whose work is in flight says so by being unpressable, not by doing nothing
    // twice when someone presses it again.
    button.disabled = spec.disabled === true || (model.detail.pending === true && actionId === 'login-open');
    button.addEventListener('click', () => runAction(actionId));
    el['state-actions'].append(button);
  }
}

/**
 * The address field: the way out of a server that is missing or wrong.
 *
 * It opens from an action rather than sitting under the panel, so the sign-in screen stays
 * a decision instead of reading as a form to fill in. Saving hands the value to the main
 * process, which owns the address, the engine and the restart a change implies; a value it
 * rejects is reported here rather than closing as if it were stored.
 */
function openServerField() {
  ui.serverOpen = true;
  el['server-field'].hidden = false;
  el['server-input'].value = model?.server?.url ?? '';
  el['server-note'].hidden = true;
  el['server-note'].textContent = '';
  el['server-input'].focus();
  el['server-input'].select();
}

function closeServerField() {
  ui.serverOpen = false;
  el['server-field'].hidden = true;
  el['server-input'].value = '';
  el['server-note'].hidden = true;
  el['server-note'].textContent = '';
}

async function saveServerField() {
  const result = await window.anywhere.setServer(el['server-input'].value.trim());
  if (result && result.ok === false) {
    el['server-note'].hidden = false;
    el['server-note'].textContent = result.reason ?? '这个地址没有保存';
    el['server-input'].focus();
    return;
  }
  closeServerField();
}

async function runAction(action) {
  if (action === 'login-open') {
    // A press is acknowledged where it was made, and it cannot be pressed again while it is
    // working: minting a hand-off can take a while (the engine may restart to recover its
    // callback port), and a press that looks ignored is a press that gets repeated - which
    // handed the browser the same link once per press.
    if (ui.pending === 'login') {
      return;
    }
    ui.pending = 'login';
    ui.note = '';
    apply();
    try {
      // Minted now, not when the screen was painted: the hand-off window is short, and a
      // stale link looks exactly like a broken app to the person clicking it.
      const fresh = await window.anywhere.freshLogin();
      ui.pending = '';
      if (!fresh || fresh.ok === false) {
        ui.note = fresh?.reason ?? '登录链接没有生成';
        apply();
        return;
      }
      apply();
      await window.anywhere.openExternal(fresh.url);
    } catch (error) {
      ui.pending = '';
      ui.note = String(error?.message ?? error);
      apply();
    }
  } else if (action === 'set-server') {
    openServerField();
  } else if (action === 'open-selected') {
    // The home's primary action: enter the machine the pane just named.
    await select(model.sidebar.selected);
  } else if (action === 'connect') {
    await refresh('connect');
  } else if (action === 'fleet-off') {
    await refresh('disconnect');
  } else if (action === 'retry') {
    refresh();
  } else if (action === 'run-installer') {
    // The install happens in the person's own terminal, never inside this app.
    const opened = await window.anywhere.runInstaller();
    if (!opened || opened.ok === false) {
      el.notice.hidden = false;
      el.notice.textContent = opened?.reason ?? '无法打开终端,请复制命令自行运行';
    }
  }
}

/**
 * Opens the selected machine's workspace when the model says there is one.
 *
 * Called after every apply, so the sequence "client starts, local host comes up,
 * workspace opens" needs no click. `opened` is the host already handed to the main
 * process: re-issuing it on every snapshot would reload nothing but would fight the
 * user's own selection, and clearing it when no workspace is available is what lets
 * a later selection be applied.
 */
async function openSelected() {
  if (!model || model.detail.kind !== 'workspace') {
    ui.opened = '';
    return;
  }
  const host = model.sidebar.selected;
  if (host === '' || host === ui.opened) {
    return;
  }
  ui.opened = host;
  const result = await window.anywhere.selectMachine(host);
  if (result && result.ok === false) {
    // A refusal must be visible: a click that does nothing is the worst answer. The
    // host is released so the next snapshot retries rather than staying silent because
    // this one was already "opened".
    ui.opened = '';
    el.notice.hidden = false;
    el.notice.textContent = result.reason ?? '打开失败';
  }
}

function apply() {
  // The product's own words come from the generated brand script, never typed here.
  model = AWView.viewModel(snapshot ?? {}, { ...ui, brand: globalThis.AWBrand ?? null });
  // A reason that belonged to the sign-in screen does not follow the person to another one.
  if (ui.note !== '' && model.state !== 'login-required') {
    ui.note = '';
  }

  el.welcome.hidden = model.welcome === null;
  el['welcome-tagline'].textContent = model.welcome?.tagline ?? '';

  // The title names the machine in use, and the product when none is. This is the window's
  // answer to "where am I"; the brand's place in the window is this name and its voice, not
  // a logo. A screen that is not a workspace still names this machine: "Anywhere Work" alone
  // said nothing while the fleet was connecting to something the reader could not see.
  const named = model.detail.machine?.name ?? model.detail.windowMachine?.name ?? '';
  el['window-title'].textContent = named === ''
    ? (globalThis.AWBrand?.name ?? 'Anywhere Work')
    : `${named} · ${globalThis.AWBrand?.name ?? 'Anywhere Work'}`;
  el.status.dataset.tone = model.status.tone;
  el['status-label'].textContent = model.status.label;
  el['status-detail'].textContent = model.status.detail;
  document.body.dataset.sidebar = model.layout.sidebar ? 'shown' : 'hidden';
  el.refresh.disabled = AWView.REFRESH_LOCKED.includes(model.state);

  if (el.query.value !== model.sidebar.query) {
    el.query.value = model.sidebar.query;
  }
  applyMachines();
  applyAccount();
  applyStatePanel();
  applyRail();

  el['diagnostics-toggle'].setAttribute('aria-expanded', model.layout.diagnostics ? 'true' : 'false');
  el['diagnostics-rows'].hidden = !model.layout.diagnostics;
  if (model.layout.diagnostics) {
    el['diagnostics-rows'].replaceChildren();
    for (const row of model.sidebar.diagnostics) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      el['diagnostics-rows'].append(dt, dd);
    }
  }

  el.notice.hidden = model.notice === '';
  el.notice.textContent = model.notice;

  el.live.textContent = `${model.status.label}${model.status.detail ? `:${model.status.detail}` : ''}`;
}

/** The rail's own state: which view is current, and what cannot be pressed yet. */
function applyRail() {
  const rail = model.rail;
  for (const id of ['rail-machines', 'rail-session']) {
    const view = id === 'rail-machines' ? 'machines' : 'session';
    const button = el[id];
    button.dataset.active = rail.active === view ? 'true' : 'false';
    button.setAttribute('aria-current', rail.active === view ? 'page' : 'false');
  }
  el['rail-session'].disabled = rail.session.disabled === true;
  el['rail-diagnostics'].setAttribute('aria-pressed', rail.diagnostics.pressed ? 'true' : 'false');
}

/** Selection is local, and the main process is told so it can show the workspace. */
async function select(host) {
  ui.selected = host;
  // Choosing a machine is asking to be inside it: the row click and the home's primary
  // action both mean the same thing.
  ui.mode = host === '' ? 'home' : 'workspace';
  apply();
  const result = await window.anywhere.selectMachine(model.detail.kind === 'workspace' ? host : '');
  ui.opened = result && result.ok !== false ? host : '';
  if (result && result.ok === false) {
    // A refusal must be visible: a click that does nothing is the worst answer.
    el.notice.hidden = false;
    el.notice.textContent = result.reason ?? '打开失败';
  }
}

/** Back to the launch pad, with the pane's workspace put away. */
async function showHome() {
  ui.mode = 'home';
  ui.opened = '';
  apply();
  await window.anywhere.selectMachine('');
}

/**
 * Starts a new conversation on the selected machine: the rail's second view.
 *
 * It is a deliberate open rather than a switch, because "new session" means the page is
 * taken back to the machine's own front door - the screen where a conversation begins.
 */
async function newSession() {
  const host = model.sidebar.selected;
  if (host === '' || model.rail.session.disabled) {
    return;
  }
  ui.mode = 'workspace';
  apply();
  const result = await window.anywhere.newSession(host);
  ui.opened = result && result.ok !== false ? host : '';
  if (result && result.ok === false) {
    el.notice.hidden = false;
    el.notice.textContent = result.reason ?? '打不开这台机器';
  }
}

async function refresh(selectState) {
  snapshot = await window.anywhere.refresh(selectState);
  apply();
  await openSelected();
}

// ------------------------------------------------------------------ keyboard

function moveSelection(delta) {
  const machines = visibleMachines();
  if (machines.length === 0) {
    return;
  }
  const index = machines.findIndex((machine) => machine.host === model.sidebar.selected);
  const next = Math.min(Math.max(index + delta, 0), machines.length - 1);
  select(machines[next === -1 ? 0 : next].host);
}

document.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;

  if (meta && key.toLowerCase() === 'r') {
    event.preventDefault();
    refresh();
    return;
  }
  if (meta && key.toLowerCase() === 'f') {
    event.preventDefault();
    el.query.focus();
    el.query.select();
    return;
  }
  if (meta && event.altKey && key.toLowerCase() === 's') {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (meta && /^[1-9]$/.test(key)) {
    const machines = visibleMachines();
    const machine = machines[Number(key) - 1];
    if (machine) {
      event.preventDefault();
      select(machine.host);
    }
    return;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (key === 'Enter' && document.activeElement === el.query) {
    const first = visibleMachines()[0];
    if (first) {
      event.preventDefault();
      select(first.host);
    }
    return;
  }
  if (key === 'Escape' && document.activeElement === el.query) {
    ui.query = '';
    apply();
    el.query.blur();
  }
});

// -------------------------------------------------------------- interactions

el.query.addEventListener('input', () => {
  ui.query = el.query.value;
  apply();
});

el['diagnostics-toggle'].addEventListener('click', () => {
  ui.diagnostics = !ui.diagnostics;
  apply();
});

el['sidebar-toggle'].addEventListener('click', () => toggleSidebar());

el.account.addEventListener('click', () => {
  const action = model?.account?.action;
  if (action) {
    runAction(action.id);
  }
});

// ----------------------------------------------------------------- the rail

el['rail-machines'].addEventListener('click', () => void showHome());
el['rail-session'].addEventListener('click', () => void newSession());
el['rail-diagnostics'].addEventListener('click', () => {
  ui.diagnostics = !ui.diagnostics;
  apply();
});
// Appearance is a native popup, so it shows which choice is active - a button that
// merely cycles three states cannot.
el['rail-appearance'].addEventListener('click', () => window.anywhere.appearanceMenu());

// The address field. Enter saves - the shortest path for a value typed once - and Escape
// leaves without changing anything, which is what a field inside a panel should do.
// The address is changed from wherever it is shown: the line on the fleet panels, the panels
// that need one, and the application menu, which reaches it from any screen.
el['state-server'].addEventListener('click', () => openServerField());
el['server-save'].addEventListener('click', () => void saveServerField());
el['server-cancel'].addEventListener('click', () => closeServerField());
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

/** Folding the list away, which the View menu and the shortcut both ask for. */
function toggleSidebar() {
  ui.sidebar = !ui.sidebar;
  apply();
  window.anywhere.setSidebar(ui.sidebar);
}

el.refresh.addEventListener('click', () => refresh());

/** Applying an appearance choice, wherever it was chosen: the View menu. */
function applyScheme(value) {
  if (value.scheme) {
    document.documentElement.dataset.scheme = value.scheme;
  } else {
    delete document.documentElement.dataset.scheme;
  }
}

/**
 * The embedded workspace is a native view placed over the detail pane, so the pane
 * has to report where it is. Anything that changes the layout - a window resize, the
 * sidebar folding away - goes through this.
 */
function reportDetailBounds() {
  // The body, not the pane: the drag strip above it belongs to the window, not to the
  // workspace.
  const rect = el['detail-body'].getBoundingClientRect();
  window.anywhere.detailBounds({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

new ResizeObserver(reportDetailBounds).observe(el['detail-body']);
window.addEventListener('resize', reportDetailBounds);

(async () => {
  try {
    applyScheme(await window.anywhere.scheme());
    window.anywhere.onSchemeChanged(applyScheme);
    // The application menu is a second way to the same actions, never a second set.
    window.anywhere.onMenu('toggle-sidebar', toggleSidebar);
    window.anywhere.onMenu('open-server-field', () => openServerField());
    window.anywhere.onMenu('focus-search', () => {
      el.query.focus();
      el.query.select();
    });
    // Subscribe before the first read: a state published while this file was loading
    // would otherwise be missed.
    // The workspace lives in a native view; when it fails, the news arrives here.
    window.anywhere.onWorkspaceFailure((failure) => {
      el.notice.hidden = false;
      el.notice.textContent = `工作区打不开:${failure.reason}`;
    });
    window.anywhere.onSnapshot((next) => {
      snapshot = next;
      apply();
      void openSelected();
    });
    await refresh();
    reportDetailBounds();
  } catch (error) {
    // Never silent, and never a blank window: the failure is the screen.
    el['state-panel'].dataset.state = 'error';
    el['state-title'].textContent = '连不上';
    el['state-body'].textContent = String(error?.message ?? error);
  }
})();