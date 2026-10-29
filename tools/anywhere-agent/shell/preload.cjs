// Preload bridge: the renderer gets exactly this surface and nothing else.
// No node integration, no remote module, no filesystem reach.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anywhere', {
  state: () => ipcRenderer.invoke('state'),
  refresh: (select) => ipcRenderer.invoke('refresh', select),
  loginStatus: () => ipcRenderer.invoke('login-status'),
  // Selection, not a second window: the workspace is embedded in the detail pane.
  selectMachine: (host) => ipcRenderer.invoke('select-machine', host),
  // The same machine, taken back to its own front door: where a new conversation starts.
  newSession: (host) => ipcRenderer.invoke('new-session', host),
  freshLogin: () => ipcRenderer.invoke('fresh-login'),
  // The address this install enrolls against. Reading it back is how a rejected value
  // gets an explanation instead of looking accepted.
  setServer: (url) => ipcRenderer.invoke('set-server', url),
  // Hands the installer command to the platform's terminal: the app never downloads a
  // runtime itself, so a missing one is answered with a command the person owns.
  runInstaller: () => ipcRenderer.invoke('run-installer'),
  detailBounds: (rect) => ipcRenderer.send('detail-bounds', rect),
  setSidebar: (visible) => ipcRenderer.send('sidebar', visible),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // The agent's state is pushed, not polled: the main process owns the agent, so it
  // is the only place that knows when something changed.
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('snapshot', listener);
    return () => ipcRenderer.removeListener('snapshot', listener);
  },
  onWorkspaceFailure: (callback) => {
    const listener = (_event, failure) => callback(failure);
    ipcRenderer.on('workspace-failed', listener);
    return () => ipcRenderer.removeListener('workspace-failed', listener);
  },
  scheme: () => ipcRenderer.invoke('scheme'),
  // Appearance is a native popup: it shows which choice is active, which a button that
  // cycles through three states cannot.
  appearanceMenu: () => ipcRenderer.send('appearance-menu'),
  onSchemeChanged: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('scheme-changed', listener);
    return () => ipcRenderer.removeListener('scheme-changed', listener);
  },
  // The application menu drives these; the window is not the only place they live.
  onMenu: (name, callback) => {
    const listener = () => callback();
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
});
// The window chrome differs by platform: macOS floats its controls over the toolbar,
// Windows draws a frame. The stylesheet reads this instead of guessing, and the
// renderer is the only place that knows which window it is inside.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
});
