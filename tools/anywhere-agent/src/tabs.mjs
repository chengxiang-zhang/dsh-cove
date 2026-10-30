/**
 * The tab model.
 *
 * One window, one tab strip. A tab is either the home (the service launcher), the
 * settings page, or one service. Two invariants make the strip predictable:
 *
 * 1. **A service has at most one tab.** Opening something already open activates it
 *    instead of stacking a second copy - the reason is not the engine's limit but that
 *    a second copy of the same page has nothing to show that the first does not.
 * 2. **The home exists minimum once.** Closing the last tab re-creates it instead of
 *    leaving an empty window, so there is always a way to open something.
 *
 * Pure: every function takes a state and returns a new one. The main process owns the
 * state (it also owns the views), the renderer only draws what it is given, and the
 * rules can therefore be tested without a window.
 */

export const HOME_TAB_ID = 'home';
export const SETTINGS_TAB_ID = 'settings';

/** The shape every tab carries; `title` is a snapshot the strip can draw without the catalogue. */
function makeTab({ id, kind, serviceId = '', title = '' }) {
  return { id, kind, serviceId, title };
}

/** An empty state, which is not a valid window state: `openHome` is what makes it usable. */
export function createState() {
  return { tabs: [], activeId: '' };
}

/** The tab id of a service, so "one tab per service" is a property of the id. */
export function serviceTabId(serviceId) {
  return `svc:${serviceId}`;
}

function indexOfId(tabs, id) {
  return tabs.findIndex((tab) => tab.id === id);
}

function withActive(state, id) {
  return { ...state, activeId: id };
}

/** The active tab object, or null for a state that has none. */
export function activeTab(state) {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

/** Whether a service is already open (the home card draws its "已打开" mark from this). */
export function isServiceOpen(state, serviceId) {
  return state.tabs.some((tab) => tab.kind === 'service' && tab.serviceId === serviceId);
}

/**
 * Opens a service, or activates it when it is already open.
 *
 * @returns {{state: object, id: string, created: boolean}}
 */
export function openService(state, serviceId, title = '') {
  if (serviceId === '') {
    return { state, id: '', created: false };
  }
  const existing = state.tabs.find((tab) => tab.kind === 'service' && tab.serviceId === serviceId);
  if (existing) {
    return { state: withActive(state, existing.id), id: existing.id, created: false };
  }
  const id = serviceTabId(serviceId);
  const tab = makeTab({ id, kind: 'service', serviceId, title });
  return { state: { tabs: [...state.tabs, tab], activeId: id }, id, created: true };
}

/** Opens the home page, or activates the one that exists (there is never a second). */
export function openHome(state) {
  const existing = state.tabs.find((tab) => tab.kind === 'home');
  if (existing) {
    return { state: withActive(state, existing.id), id: existing.id, created: false };
  }
  const tab = makeTab({ id: HOME_TAB_ID, kind: 'home', title: '首页' });
  // The home sits first: it is the anchor the strip is read from.
  return { state: { tabs: [tab, ...state.tabs], activeId: HOME_TAB_ID }, id: HOME_TAB_ID, created: true };
}

/** Opens the settings page, or activates it. */
export function openSettings(state) {
  const existing = state.tabs.find((tab) => tab.kind === 'settings');
  if (existing) {
    return { state: withActive(state, existing.id), id: existing.id, created: false };
  }
  const tab = makeTab({ id: SETTINGS_TAB_ID, kind: 'settings', title: '设置' });
  return { state: { tabs: [...state.tabs, tab], activeId: SETTINGS_TAB_ID }, id: SETTINGS_TAB_ID, created: true };
}

/** Activates a tab that exists; an unknown id is a no-op rather than a blank window. */
export function activate(state, id) {
  if (indexOfId(state.tabs, id) === -1) {
    return state;
  }
  return withActive(state, id);
}

/**
 * Closes a tab.
 *
 * The next active tab is the one to the right (what the user was about to read), else
 * the one to the left, else the home. Closing the last tab re-creates the home rather
 * than leaving the window empty.
 *
 * @returns {{state: object, closed: boolean}}
 */
export function close(state, id) {
  const index = indexOfId(state.tabs, id);
  if (index === -1) {
    return { state, closed: false };
  }
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (tabs.length === 0) {
    return { state: { ...openHome({ tabs, activeId: '' }).state }, closed: true };
  }
  if (state.activeId !== id) {
    return { state: { tabs, activeId: state.activeId }, closed: true };
  }
  const next = tabs[Math.min(index, tabs.length - 1)];
  return { state: { tabs, activeId: next.id }, closed: true };
}

/** Moves a tab by position; out-of-range indices are ignored. */
export function reorder(state, from, to) {
  const { tabs } = state;
  if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) {
    return state;
  }
  const moved = [...tabs];
  const [tab] = moved.splice(from, 1);
  moved.splice(to, 0, tab);
  return { ...state, tabs: moved };
}

/** Updates a tab's cached title (the catalogue can rename a service under an open tab). */
export function retitle(state, id, title) {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id || tab.title === title) {
      return tab;
    }
    changed = true;
    return { ...tab, title };
  });
  return changed ? { ...state, tabs } : state;
}

/** What to write to disk: kinds and service ids only, no rendered titles. */
export function serialize(state) {
  return state.tabs.map((tab) => ({ kind: tab.kind, serviceId: tab.serviceId, id: tab.id }));
}

/**
 * Rebuilds a state from disk.
 *
 * A service that no longer exists in the catalogue is dropped (`known` answers that),
 * and the active tab falls back to the home when its tab did not survive. Restoring
 * never opens anything: the caller decides whether to load pages.
 */
export function restore(items, { known = () => true, activeId = '' } = {}) {
  const tabs = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (item.kind === 'home') {
      if (!tabs.some((tab) => tab.kind === 'home')) {
        tabs.push(makeTab({ id: HOME_TAB_ID, kind: 'home', title: '首页' }));
      }
      continue;
    }
    if (item.kind === 'settings') {
      if (!tabs.some((tab) => tab.kind === 'settings')) {
        tabs.push(makeTab({ id: SETTINGS_TAB_ID, kind: 'settings', title: '设置' }));
      }
      continue;
    }
    const serviceId = String(item.serviceId ?? '');
    if (serviceId === '' || !known(serviceId)) {
      continue;
    }
    if (!tabs.some((tab) => tab.kind === 'service' && tab.serviceId === serviceId)) {
      tabs.push(makeTab({ id: serviceTabId(serviceId), kind: 'service', serviceId }));
    }
  }
  if (tabs.length === 0) {
    return openHome(createState()).state;
  }
  const wanted = tabs.find((tab) => tab.id === activeId);
  return { tabs, activeId: (wanted ?? tabs[0]).id };
}

/** The tab that should be active after a restore, given the previous session. */
export function activeIdOf(state) {
  return state.activeId;
}
