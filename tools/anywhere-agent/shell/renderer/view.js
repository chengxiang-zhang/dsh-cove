/*
 * The screen, as a pure function of the agent's snapshot.
 *
 * Everything about what the user sees and can do is decided here: the status line,
 * the sidebar's groups and selection, the detail pane's state, which actions exist,
 * and what the diagnostics block says. The DOM half lives in app.js and only applies
 * this result, which is what makes the interface verifiable in milliseconds instead
 * of by launching an app and looking at it.
 *
 * The rules it encodes are in DESIGN.md, which cites the standards they come from:
 * status is always visible with a way out (H1, H9), recognition beats recall (H6),
 * internals are diagnostics rather than front-page content (H8), and every state
 * names what happened, why, and what to do next.
 *
 * Two product rules are structural here rather than cosmetic:
 *
 * 1. **The sign-in is optional.** This machine's workspace is reachable with no
 *    account at all; the private network that carries the user's *other* machines
 *    is an addition the user asks for. `state` therefore has a `local` destination
 *    that is a success, not a degraded sign-in screen.
 * 2. **The sign-in is a button.** A hand-off URL is short-lived and the engine's
 *    callback listener is even shorter-lived, so the screen never shows one; the
 *    click re-mints it. Nothing in this file returns a URL for display.
 *
 * This is a classic script on purpose. The renderer is a file:// page and Chromium
 * refuses module scripts from a null origin, so the renderer cannot use ESM - and the
 * file must not be `.js`-as-ESM either, which is what the package's
 * `"type": "module"` would otherwise make it. The tests run this file exactly the way
 * the browser does, through `node:vm`.
 */
(function (root) {
  const factory = () => {
    /** Status text per window state. */
    const STATE_LABEL = {
      provisioning: '正在准备',
      local: '本机可用',
      connecting: '正在接入',
      'login-required': '等待登录',
      ready: '已连接',
      empty: '没有其他机器',
      error: '连不上',
    };

    /** The status tone, which the stylesheet maps to a colour. */
    const STATE_TONE = {
      provisioning: 'busy',
      local: 'good',
      connecting: 'busy',
      'login-required': 'attention',
      ready: 'good',
      empty: 'idle',
      error: 'bad',
    };

    /** What the client is doing before the local host answers, per step. */
    const PROVISIONING_COPY = {
      checking: { title: '正在检查本机环境', body: '' },
      // Something is missing and this window installs nothing: the way out is the
      // command shown in the panel, run in the person's own terminal.
      'needs-install': {
        title: '本机还没装好',
        body: '',
        actions: ['run-installer', 'retry'],
      },
      ready: { title: '本机已就绪', body: '' },
      error: { title: '本机服务起不来', body: '' },
    };

    /**
     * What the detail pane shows when no workspace covers it.
     *
     * Each one names what happened, why, and the way out. `actions` are ids the
     * renderer wires to bridge calls; an empty list means the state resolves itself.
     */
    const STATE_PANEL = {
      provisioning: {
        title: '正在准备本机环境',
        body: '',
        actions: [],
      },
      local: {
        title: '选一台机器',
        body: '从左边选一台机器,它的工作区会显示在这里。',
        actions: [],
      },
      connecting: {
        title: '正在接入',
        // This is the state the user could not get out of, so it keeps its way back to this
        // machine and says what it is doing in one line.
        body: '正在联系服务器。',
        actions: [{ id: 'fleet-off', label: '改用本机' }],
      },
      'login-required': {
        title: '登录',
        body: '登录后,你的其他电脑会出现在这里。本机不受影响。',
        // One button. The link is minted on the click, so a second button that copied it and
        // a third that declined a network the person had just asked for were both decisions
        // this screen did not need to put in front of anyone.
        actions: ['login-open'],
      },
      empty: {
        title: '没有看到其他机器',
        body: '在别的电脑上登录同一个账号,它就会出现在这里。',
        actions: ['retry'],
      },
      error: {
        title: '连不上',
        body: '',
        // The engine's own words are kept (they are the diagnosis) and the address is named
        // beside them, because it is the one fact the person can correct. Copying the
        // diagnostics lives in the Help menu and in the sidebar's own block.
        actions: ['retry', 'set-server'],
      },
      ready: {
        title: '选一台机器',
        body: '从左边选一台机器,它的工作区会显示在这里。',
        actions: [],
      },
    };

    /**
     * The states where pressing refresh would start a second run of a sequence already in
     * flight: preparing this machine installs things, so a second press is not a re-read.
     * `connecting` is deliberately not one of them - pressing refresh there re-reads the
     * list, which is exactly what a person does when a connection looks stuck. Blocking it
     * left the only way out of a wedged connect as the menu item or a restart.
     */
    const REFRESH_LOCKED = ['provisioning'];

    /** The rail: what the window is showing, plus what is always available. */
    const RAIL_ACTIVE = { home: 'machines', workspace: 'session' };

    /** What the second section says while the fleet half is not showing machines. */
    const FLEET_HINT = {
      starting: '正在启动连接,还没有回应。',
      connecting: '正在联系服务器,还没有回应。',
      'login-required': '登录后,你的其他电脑会出现在这里。',
      ready: '还没有别的电脑登录这个账号。',
      empty: '还没有别的电脑登录这个账号。',
      error: '网络连接失败,本机不受影响。',
    };

    /** The one state where the product has just met the user and may introduce itself. */
    const WELCOME = ['provisioning'];

    const str = (value, fallback = '') =>
      value === undefined || value === null || value === '' ? fallback : String(value);

    /** Case-insensitive match over the fields a person would type. */
    function matches(machine, query) {
      const needle = String(query ?? '').trim().toLowerCase();
      if (needle === '') {
        return true;
      }
      return [machine.name, machine.host, machine.ip].some((field) =>
        String(field ?? '').toLowerCase().includes(needle),
      );
    }

    /**
     * The group titles: this machine, then the user's others.
     *
     * One level of hierarchy, as the platform guidance for sidebars asks. When the
     * network is off the second group is still present, holding the way to turn it
     * on: an absent section reads as "you have no other machines", which is a claim
     * the client cannot make before anyone has signed in.
     */
    function groupMachines(machines, query, fleetState) {
      const shown = (Array.isArray(machines) ? machines : []).filter((machine) => matches(machine, query));
      // One fact decides this section, and it is not a name: the row the client built for
      // the machine it runs on. The snapshot says which row that is (by address, in the
      // shell); a name would not be an identity - one machine holds a name per enrollment,
      // so comparing names either matches nothing or matches two machines.
      const isSelf = (machine) => machine.isLocal === true;
      const self = shown.filter(isSelf);
      const others = shown.filter((machine) => !isSelf(machine));
      const groups = [];
      if (self.length > 0) {
        groups.push({ id: 'self', title: '本机', machines: self });
      }
      if (others.length > 0) {
        groups.push({ id: 'ours', title: '其他机器', machines: others });
      }
      if (String(query ?? '').trim() !== '') {
        if (self.length === 0 && others.length === 0) {
          groups.push({ id: 'none', title: '没有匹配的机器', machines: [] });
        }
        return groups;
      }
      if (fleetState === 'off' || fleetState === '') {
        groups.push({
          id: 'fleet-off',
          title: '其他机器',
          machines: [],
          hint: '登录后,你的其他电脑会出现在这里。',
          action: { id: 'connect', label: '登录' },
        });
      } else if (others.length === 0) {
        // The section is always present, and it always says which of the four
        // situations the user is in: signing in, searching, none yet, or a link that
        // failed. An absent section would read as "you own one computer".
        groups.push({
          id: 'ours',
          title: '其他机器',
          machines: [],
          hint: FLEET_HINT[fleetState] ?? '',
          ...(fleetState === 'login-required' ? { action: { id: 'connect', label: '登录' } } : {}),
        });
      }
      if (groups.length === 0) {
        groups.push({ id: 'none', title: '机器', machines: [] });
      }
      return groups;
    }

    /**
     * Selection survives a refresh, and falls back to the first machine offered.
     *
     * Keeping it stable matters: a refresh that silently moved the user to another
     * machine would be a worse bug than one that keeps a stale row.
     */
    function resolveSelection(machines, selected) {
      const list = Array.isArray(machines) ? machines : [];
      if (selected && list.some((machine) => machine.host === selected)) {
        return selected;
      }
      return list.length > 0 ? list[0].host : '';
    }

    function normalizeState(snapshot) {
      const state = snapshot?.state;
      return typeof state === 'string' && STATE_LABEL[state] ? state : 'provisioning';
    }

    /**
     * The status line: the layer, the result, and a count when there is one to give.
     *
     * The agent's own note is engine-facing English ("6 machines reachable by
     * registration"), so it is not what the user reads. The one place its exact words
     * appear is the error panel, where they are the diagnosis.
     */
    function statusOf(snapshot) {
      const state = normalizeState(snapshot);
      const count = Array.isArray(snapshot?.entries) ? snapshot.entries.length : 0;
      let detail = '';
      if (state === 'ready') {
        detail = count > 0 ? `${count} 台可达` : '';
      }
      return {
        tone: STATE_TONE[state],
        label: STATE_LABEL[state],
        detail,
      };
    }

    /** How a machine reads in the list: reachable, or waiting on a sign-in. */
    function machineBadge(machine) {
      return machine.needsLogin ? '需登录' : '';
    }

    /**
     * How many finished runs this machine reports that the user has not looked at.
     *
     * A missing or unusable count is zero rather than a throw: the feed is not
     * deployed everywhere yet, and its absence is not an error on this screen.
     */
    function unreadCountOf(entry) {
      const count = Number(entry?.unread);
      return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    }

    /**
     * What a machine reads as to someone who cannot see its marks.
     *
     * The marks are shapes to the eye; the words are what the row actually says, so
     * an unread count is never conveyed by colour alone.
     */
    function machineLabel(machine) {
      return [machine.name, machine.host, machine.badge, machine.unreadLabel].filter((part) => part !== '').join(',');
    }

    /**
     * The hover text: the same facts as the accessible name, plus the address, which
     * stays reachable here without taking a line in the row.
     */
    function machineTitle(machine) {
      return [`${machine.name} · ${machine.host}`, machine.address, machine.unreadLabel].filter((part) => part !== '').join(' · ');
    }

    /** The host on this machine, in the four states worth telling apart. */
    function kernelFact(kernel) {
      if (!kernel || typeof kernel !== 'object' || kernel.error) {
        return '-';
      }
      if (kernel.installed !== true) {
        return '未安装';
      }
      const version = kernel.version ? String(kernel.version) : '已安装';
      if (kernel.reachable !== true) {
        return `${version} · 未运行`;
      }
      return kernel.service && kernel.service.loaded ? `${version} · 常驻` : `${version} · 外部托管`;
    }

    /**
     * How the address in force was obtained, in the window's own words.
     *
     * The fact belongs on screen because it is the difference between "the network is
     * down" and "this install was never told where the network is", and the second one is
     * something the person can fix.
     */
    const SERVER_SOURCE = {
      flag: '启动参数',
      environment: '启动参数',
      choice: '自己设置',
      enrolled: '这台电脑已经登录过',
      bundled: '安装包自带',
      channel: '发布通道',
      none: '还没有地址',
    };

    /**
     * The address facts the window shows, from the shell's decision.
     *
     * `（自建）` is the same mark the mobile client puts on an address the user set
     * themselves: the two clients say the same thing about the same state.
     */
    function serverOf(snapshot) {
      const server = snapshot?.server && typeof snapshot.server === 'object' ? snapshot.server : null;
      const url = str(server?.url);
      const host = str(server?.host, url);
      const source = str(server?.source, url === '' ? 'none' : '');
      const custom = server?.isCustom === true;
      return {
        url,
        host,
        source,
        hasUrl: url !== '',
        // The same words the mobile client uses for the same fact, down to the colon and
        // the badge, so one deployment's two clients read alike.
        label: host === '' ? '' : custom ? `${host}（自建）` : host,
        line: host === '' ? '服务器：还没有地址' : `服务器：${custom ? `${host}（自建）` : host}`,
        origin: str(SERVER_SOURCE[source], ''),
      };
    }

    /** What the pane shows when the fleet is wanted and there is no address to dial. */
    const NO_SERVER_PANEL = {
      title: '填服务器地址',
      body: '这台电脑还不知道去哪里登录。',
      actions: ['set-server', 'fleet-off'],
    };

    /** What the pane shows when this machine's own host is what failed. */
    const LOCAL_ERROR_PANEL = {
      title: '本机服务起不来',
      body: '',
      // The fleet's own error panel offers the address; this one must not, because the
      // address has nothing to do with the local host being down. The installer action is
      // dropped by the caller when there is no command to hand over.
      actions: ['run-installer', 'retry'],
    };

    /** The diagnostics block: internals, folded away until someone needs them. */
    function diagnosticsOf(snapshot) {
      const engine = snapshot?.engine && typeof snapshot.engine === 'object' ? snapshot.engine : null;
      const kernel = snapshot?.kernel && typeof snapshot.kernel === 'object' ? snapshot.kernel : null;
      const local = snapshot?.local && typeof snapshot.local === 'object' ? snapshot.local : null;
      const proxy = str(snapshot?.proxy);
      const app = snapshot?.app && typeof snapshot.app === 'object' ? snapshot.app : null;
      const rows = [];
      // First, because it answers "which build is this" before any fact that describes the
      // machine rather than the window. The build number is what tells two builds of one
      // version apart, so it is shown beside the version rather than folded away.
      if (str(app?.version) !== '') {
        const build = str(app?.build);
        rows.push({ label: '本窗口', value: build === '' ? str(app.version) : `${str(app.version)} (构建 ${build})` });
      }
      rows.push({ label: '本机', value: kernelFact(kernel) });
      if (local?.machine) {
        rows.push({ label: '本机名', value: String(local.machine) });
      }
      // Before the engine's own numbers: when the fleet fails, this is the row that says
      // what it was talking to, and it is the only one the person can act on.
      const server = serverOf(snapshot);
      rows.push({ label: '服务器', value: server.hasUrl ? `${server.label}（${server.origin}）` : '还没有地址' });
      if (engine) {
        rows.push({ label: '协议', value: str(engine.protocol, '-') });
        rows.push({ label: '网络引擎', value: str(engine.netbird, '-') });
        rows.push({ label: '引擎构建', value: str(engine.helper, '-') });
      }
      if (proxy) {
        rows.push({ label: '本地代理', value: proxy });
      }
      return rows;
    }

    /**
     * The front door: the pane the client lands on.
     *
     * It is a launch pad rather than an auto-opened workspace. Landing straight inside a
     * machine made the window's own structure invisible - there was no home to come back
     * to, nothing to name the machine being opened, and no place for the new-session
     * entry to mean anything. One click still enters a machine, and the click is the one
     * the user chose.
     *
     * @param {object|null} machine the machine the primary action would open
     * @returns {{ title: string, body: string, actions: object[] }}
     */
    function homePanel(machine) {
      if (machine === null) {
        return { title: '还没有可用的机器', body: '本机的服务还在准备;准备好之后它会出现在左边。', actions: [] };
      }
      // The title asks the question and the button answers it by naming the machine. A
      // sentence repeating both was the shape this screen kept wearing for no reason.
      return {
        title: '要打开哪台机器?',
        body: '',
        actions: [{ id: 'open-selected', label: `打开 ${machine.name} 的工作区`, primary: true }],
      };
    }

    /**
     * The account chip at the foot of the list.
     *
     * It is where the two halves of the product are kept apart in the user's mind:
     * the line under the name says whether the *other machines* are reachable, never
     * whether the app works. Its action is the one place the network is switched on.
     */
    function accountOf(snapshot, state) {
      const fleet = snapshot?.fleet && typeof snapshot.fleet === 'object' ? snapshot.fleet : null;
      const local = snapshot?.local && typeof snapshot.local === 'object' ? snapshot.local : null;
      const fleetState = str(fleet?.state, 'off');
      const count = Array.isArray(snapshot?.entries) ? snapshot.entries.length : 0;
      if (state === 'provisioning' || (local && local.state !== 'ready')) {
        const step = str(local?.state, 'checking');
        return {
          tone: 'busy',
          name: '正在准备本机',
          line: str(PROVISIONING_COPY[step]?.title, ''),
          action: null,
          disabled: true,
        };
      }
      if (state === 'error') {
        return { tone: 'bad', name: '连不上网络', line: '', action: { id: 'retry', label: '重试' }, disabled: false };
      }
      if (fleetState === 'off' || fleetState === '') {
        // One word for one action, everywhere it appears: the chip, the group header and the
        // sign-in screen all say 登录, not three near-synonyms for the same click.
        return { tone: 'idle', name: '未登录', line: '只使用这台电脑', action: { id: 'connect', label: '登录' }, disabled: false };
      }
      if (fleetState === 'starting' || fleetState === 'connecting') {
        // The chip used to promise a search and disable itself, which left the one state
        // that can hang with no way out of it. It now says what is actually happening and
        // keeps the way back to this machine.
        return { tone: 'busy', name: '正在接入', line: '正在联系服务器', action: { id: 'fleet-off', label: '改用本机' }, disabled: false };
      }
      if (fleetState === 'login-required') {
        const server = serverOf(snapshot);
        return server.hasUrl
          ? { tone: 'attention', name: '等待登录', line: '本机不受影响', action: { id: 'connect', label: '登录' }, disabled: false }
          : { tone: 'attention', name: '还没有服务器地址', line: '本机不受影响', action: { id: 'set-server', label: '设置服务器' }, disabled: false };
      }
      if (fleetState === 'empty') {
        return { tone: 'idle', name: '没有其他机器', line: '本机不受影响', action: { id: 'retry', label: '重试' }, disabled: false };
      }
      return {
        tone: 'good',
        // One name for this machine everywhere it is written: the row, the title and this
        // chip all say what the list says, never the engine's separate name for it.
        name: str(snapshot?.local?.machine, str(snapshot?.self?.machine, '已连接')),
        line: count > 0 ? `${count} 台可达` : '已连接',
        action: null,
        disabled: false,
      };
    }

    /**
     * Projects one agent snapshot onto the screen.
     *
     * @param {object} snapshot what the agent reports
     * @param {{ query?: string, selected?: string, diagnostics?: boolean, sidebar?: boolean, pending?: string, note?: string, brand?: object }} [ui] local interface state
     */
    function viewModel(snapshot, ui = {}) {
      const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
      // The product's name and tagline come from the generated brand script, never
      // typed into the renderer, so a rename cannot leave the client behind.
      const brand = ui.brand && typeof ui.brand === 'object' ? ui.brand : null;
      const tagline = brand?.tagline?.zh ?? '';
      const state = normalizeState(source);
      const local = source.local && typeof source.local === 'object' ? source.local : null;
      const fleet = source.fleet && typeof source.fleet === 'object' ? source.fleet : null;
      const fleetState = str(fleet?.state, 'off');
      const machines = (Array.isArray(source.entries) ? source.entries : []).map((entry) => {
        const unreadCount = unreadCountOf(entry);
        const failedCount = unreadCountOf({ unread: entry.unreadFailed });
        return {
          host: String(entry.host ?? ''),
          name: String(entry.machine ?? ''),
          ip: String(entry.ip ?? ''),
          // The row carries what a person recognises - the machine name and its
          // canonical host. The overlay address is a diagnostic detail: it truncated the
          // line and nobody identifies a machine by its overlay number.
          line: String(entry.host ?? ''),
          address: String(entry.ip ?? ''),
          url: String(entry.url ?? ''),
          isLocal: entry.local === true,
          needsLogin: entry.statusCode === 302,
          // The two marks are independent: a machine can need a sign-in and also have
          // finished work waiting, and neither fact may hide the other.
          unread: unreadCount > 0,
          unreadCount,
          // Severity is part of the fact, not decoration: only work that *failed* is
          // worth a colour that says act on me, so the row carries which one it is and
          // the stylesheet decides how loud that is.
          unreadTone: unreadCount > 0 && failedCount > 0 ? 'danger' : 'notice',
          unreadLabel:
            unreadCount > 0 ? `${unreadCount} 项新结果${failedCount > 0 ? '（含出错）' : ''}` : '',
        };
      });
      const query = String(ui.query ?? '');
      const selected = resolveSelection(machines, ui.selected);
      const groups = groupMachines(machines, query, fleetState).map((group) => ({
        ...group,
        machines: group.machines.map((machine) => {
          const marked = { ...machine, badge: machineBadge(machine), selected: machine.host === selected };
          // Composed after the marks are known, so the accessible name cannot drift
          // from what the row shows.
          return { ...marked, label: machineLabel(marked), title: machineTitle(marked) };
        }),
      }));
      const selectedMachine = machines.find((machine) => machine.host === selected) ?? null;
      // A workspace covers the pane only when the user asked for it: `ui.mode` is the
      // rail's own state, and the home is what it falls back to.
      const wantsWorkspace = ui.mode === 'workspace';
      const canOpen = (state === 'local' || state === 'ready') && selectedMachine !== null;
      const ready = canOpen && wantsWorkspace;
      const home = (state === 'local' || state === 'ready') && !ready;
      const server = serverOf(source);
      const panel = state === 'provisioning'
        ? PROVISIONING_COPY[str(local?.state, 'checking')] ?? STATE_PANEL.provisioning
        : home
          ? homePanel(canOpen ? selectedMachine : null)
          : state === 'error' && str(local?.state) === 'error'
            // A failure of this machine's own host and a failure of the private network are
            // different problems with different answers; one panel for both offered the
            // server field to someone whose local host was down.
            ? LOCAL_ERROR_PANEL
            : state === 'login-required' && !server.hasUrl
              // The fleet was asked for with nowhere to dial. The address is the missing
              // fact, so the field takes the place of the sign-in button.
              ? NO_SERVER_PANEL
              : STATE_PANEL[state] ?? STATE_PANEL.provisioning;
      // A press that is still working, and the reason the last one could not: both are local
      // interface state, and both belong beside the button that was pressed.
      const pending = str(ui.pending, '');
      const note = str(ui.note, '');
      const panelActions = (panel.actions ?? [])
        // The runtime action exists only when there is a command to run: a button that
        // cannot do anything is worse than no button.
        .filter((action) => {
          const id = typeof action === 'string' ? action : str(action?.id, '');
          return id !== 'run-installer' || str(local?.command, '') !== '';
        });

      return {
        state,
        status: statusOf(source),
        layout: {
          sidebar: ui.sidebar !== false,
          diagnostics: ui.diagnostics === true,
        },
        // The rail: which view is current, and whether the new-session entry has a
        // machine to act on. Appearance is always available and carries no state.
        rail: {
          active: ready ? RAIL_ACTIVE.workspace : RAIL_ACTIVE.home,
          session: { disabled: !canOpen },
          diagnostics: { pressed: ui.diagnostics === true },
        },
        identity: {
          // The row's name wins: this machine is whatever the list calls it, and the engine's
          // own record is only a fallback for a deployment that reports no local block.
          name: str(local?.machine, str(source.self?.machine, '尚未加入网络')),
          ip: str(source.self?.ip),
          engineLine: source.self?.interfaceType ? `netbird ${source.self.interfaceType}` : '',
        },
        account: accountOf(source, state),
        // The address in force, and where it came from: the pane names it in every fleet
        // state, so a failure can be read as "this server" rather than "the network".
        server,
        sidebar: {
          query,
          groups,
          selected,
          shown: machines.filter((machine) => matches(machine, query)).length,
          registered: Number.isFinite(source.registered) ? source.registered : machines.length,
          diagnostics: diagnosticsOf(source),
        },
        // The brand's front door belongs where the user has not met the product yet.
        // Elsewhere it would be decoration.
        welcome: brand && WELCOME.includes(state) ? { tagline } : null,
        detail: {
          // A workspace only when there is something to show; otherwise the pane
          // carries the state, so the window is never empty without explanation.
          kind: ready ? 'workspace' : 'state',
          // A press of the sign-in button that has not answered yet: the button that started
          // it is the one that says so, and it cannot be pressed again. Pressing repeatedly
          // handed the browser the same link once per press, which is how several tabs
          // opened at once.
          pending: pending === 'login',
          machine: ready ? { name: selectedMachine.name, host: selectedMachine.host } : null,
          // What the window title names. A workspace names the machine it is showing; every
          // other screen names this machine, which used to leave the title reading
          // "Anywhere Work" while the fleet was connecting to something.
          windowMachine: { name: ready ? selectedMachine.name : str(local?.machine, str(source.self?.machine, '')) },
          state: {
            id: state,
            // The front door is a different screen from a notice: the stylesheet gives
            // it the display step, and the POC checks which one is up.
            kind: home ? 'home' : 'state',
            title: panel.title,
            // The address travels with the panel, so the engine's own words are read
            // beside the server they came from.
            server: server.line,
            // What the pressed button is doing, or why it could not do it. Empty means the
            // panel has nothing to report and says nothing.
            note: pending === 'login' ? '正在打开浏览器…' : note,
            noteTone: pending === 'login' ? '' : 'danger',
            body: state === 'error'
              ? str(source.detail, str(local?.detail, '未知错误'))
              : local?.state === 'needs-install'
                // The reason and the exact command: the person runs it themselves.
                ? [str(local?.detail), str(local?.command)].filter((line) => line !== '').join('\n')
                : str(panel.body, ''),
            actions: panelActions,
          },
        },
        // The user asked to see the workspace but there is nothing to show.
        notice: (state === 'ready' || state === 'local') && selectedMachine === null ? '这台机器现在没有应答,已刷新列表' : '',
      };
    }

    return {
      viewModel,
      groupMachines,
      resolveSelection,
      kernelFact,
      statusOf,
      diagnosticsOf,
      accountOf,
      STATE_LABEL,
      STATE_TONE,
      STATE_PANEL,
      PROVISIONING_COPY,
      REFRESH_LOCKED,
      WELCOME,
    };
  };

  root.AWView = factory();
})(globalThis);