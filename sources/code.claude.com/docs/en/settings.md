> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Claude Code settings

> Change Claude Code settings, pick the scope a key belongs in, verify the change, and learn which value Claude Code uses when a key is set in several places.

export const SettingsPrecedence = () => {
  const LEVELS = [{
    n: 1,
    name: 'Managed settings',
    file: 'managed-settings.json, MDM, or the claude.ai console',
    who: 'Your organization',
    w: 390
  }, {
    n: 2,
    name: 'Command line',
    file: 'claude --settings',
    who: 'You, this session',
    w: 420
  }, {
    n: 3,
    name: 'Project local',
    file: '.claude/settings.local.json',
    who: 'You, this project',
    w: 480
  }, {
    n: 4,
    name: 'Shared project',
    file: '.claude/settings.json',
    who: 'Everyone in the project',
    w: 540
  }, {
    n: 5,
    name: 'User',
    file: '~/.claude/settings.json',
    who: 'You, every project',
    w: 600
  }];
  const W = 760;
  const ROW = 58;
  const GAP = 8;
  const TOP = 34;
  const H = TOP + LEVELS.length * (ROW + GAP) + 30;
  const cx = W / 2;
  const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
  const sans = 'var(--font-sans, system-ui, -apple-system, sans-serif)';
  return <div className="sp-root not-prose" role="img" aria-label="Settings precedence, highest first: managed settings, command line, project local, shared project, user. A key set at a higher level overrides the same key set lower down.">
      <style>{`
        .sp-root { --sp-text: #1A1918; --sp-sub: #5E5D59; --sp-faint: #8A8880; --sp-fill: #F5F4EF; --sp-stroke: rgba(0,0,0,0.12); --sp-top: #D97757; --sp-top-fill: rgba(217,119,87,0.14); --sp-arrow: #8A8880; margin: 1.25rem 0; }
        .dark .sp-root { --sp-text: #F1EFE9; --sp-sub: #B8B5AD; --sp-faint: #8A8880; --sp-fill: #24231F; --sp-stroke: rgba(255,255,255,0.12); --sp-top-fill: rgba(217,119,87,0.22); --sp-arrow: #8A8880; }
        .sp-root svg { width: 100%; height: auto; display: block; max-width: ${W}px; margin: 0 auto; }
      `}</style>
      <svg viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg">
        <text x={cx} y={18} textAnchor="middle" fontFamily={sans} fontSize="12.5" fontWeight="600" fill="var(--sp-sub)">Highest precedence</text>
        {LEVELS.map((l, i) => {
    const y = TOP + i * (ROW + GAP);
    const x = cx - l.w / 2;
    const top = i === 0;
    return <g key={l.n}>
              <rect x={x} y={y} width={l.w} height={ROW} rx={10} fill={top ? 'var(--sp-top-fill)' : 'var(--sp-fill)'} stroke={top ? 'var(--sp-top)' : 'var(--sp-stroke)'} strokeWidth={top ? 1.5 : 1} />
              <text x={x + 14} y={y + 24} fontFamily={sans} fontSize="14" fontWeight="600" fill="var(--sp-text)">{l.n}. {l.name}</text>
              <text x={x + 14} y={y + 43} fontFamily={mono} fontSize="11.5" fill="var(--sp-sub)">{l.file}</text>
              <text x={x + l.w - 14} y={y + 24} textAnchor="end" fontFamily={sans} fontSize="12" fill="var(--sp-faint)">{l.who}</text>
            </g>;
  })}
        <text x={cx} y={H - 10} textAnchor="middle" fontFamily={sans} fontSize="12.5" fontWeight="600" fill="var(--sp-sub)">Lowest precedence</text>
        <g stroke="var(--sp-arrow)" strokeWidth="1.5" fill="none">
          <line x1={W - 40} y1={TOP + 10} x2={W - 40} y2={H - 38} />
          <path d={`M ${W - 46} ${TOP + 18} L ${W - 40} ${TOP + 10} L ${W - 34} ${TOP + 18}`} />
        </g>
        <text x={W - 40} y={H - 22} textAnchor="middle" fontFamily={sans} fontSize="10.5" fill="var(--sp-faint)">overrides</text>
      </svg>
    </div>;
};

export const SettingsScope = ({defaultSelected = 'project'}) => {
  const FILES = [{
    id: 'user',
    path: '~/.claude/settings.json'
  }, {
    id: 'project',
    path: 'acme-app/.claude/settings.json'
  }, {
    id: 'local',
    path: 'acme-app/.claude/settings.local.json'
  }, {
    id: 'managed',
    path: 'Managed settings',
    ring: 'managed-settings.json, MDM, or the claude.ai console'
  }];
  const SHORT = {
    user: '~/.claude/settings.json',
    project: 'acme-app/.claude/settings.json',
    local: 'acme-app/.claude/settings.local.json',
    managed: 'managed-settings.json, MDM, or the claude.ai console'
  };
  const TILE_MARK = {
    project: 'settings.json',
    local: 'settings.local.json'
  };
  const initial = FILES.some(f => f.id === defaultSelected) ? defaultSelected : 'project';
  const [sel, setSel] = useState(initial);
  const [scale, setScale] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rootRef = useRef(null);
  const frameRef = useRef(null);
  const CANVAS_W = 862;
  const CANVAS_H = 240;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / CANVAS_W));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = () => {
    if (!rootRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen(); else rootRef.current.requestFullscreen().catch(() => {});
  };
  const COVERAGE = {
    user: ['website', 'api', 'yacme'],
    project: ['yacme', 'tacme', 'cacme'],
    local: ['yacme'],
    managed: ['website', 'api', 'yacme', 'tacme', 'cacme']
  };
  const RINGS = {
    local: {
      l: 282,
      t: 50,
      w: 142,
      h: 124
    },
    project: {
      l: 282,
      t: 50,
      w: 560,
      h: 124
    },
    user: {
      l: 2,
      t: 34,
      w: 446,
      h: 198
    },
    managed: {
      l: 0,
      t: 32,
      w: 862,
      h: 204
    }
  };
  const TILES = [{
    id: 'website',
    name: 'website/',
    left: 30,
    caption: ''
  }, {
    id: 'api',
    name: 'api/',
    left: 160,
    caption: ''
  }, {
    id: 'yacme',
    name: 'acme-app/',
    left: 290,
    caption: ''
  }, {
    id: 'tacme',
    name: 'acme-app/',
    left: 497,
    caption: sel === 'project' ? 'their clone, once you commit the file' : 'their clone'
  }, {
    id: 'cacme',
    name: 'acme-app/',
    left: 704,
    caption: sel === 'project' ? 'fresh clone, once you commit the file' : sel === 'managed' ? 'server-managed only' : 'fresh clone'
  }];
  const FILE_AT = {
    user: {
      machine: 'you',
      tiles: []
    },
    project: {
      machine: null,
      tiles: ['yacme', 'tacme', 'cacme']
    },
    local: {
      machine: null,
      tiles: ['yacme']
    },
    managed: {
      machine: null,
      tiles: []
    }
  };
  const fileAt = FILE_AT[sel];
  const coverage = COVERAGE[sel];
  const ring = RINGS[sel];
  const selFile = FILES.find(f => f.id === sel);
  const FolderIcon = ({open}) => <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />
      {open && <path d="M1.5 7.5h13" />}
    </svg>;
  const FileIcon = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13" />
    </svg>;
  const CloudIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 12.5h7a2.5 2.5 0 0 0 .4-4.97A3.5 3.5 0 0 0 5.2 6.6 3 3 0 0 0 4.5 12.5z" />
    </svg>;
  const LaptopIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
      <path d="M1 12.5h14" />
    </svg>;
  return <div ref={rootRef} className={'ssc-root not-prose' + (isFullscreen ? ' ssc-fs' : '')}>
      <style>{`
        .ssc-root {
          --ssc-bg: #FFFFFF;
          --ssc-text: #1A1918;
          --ssc-sub: #5E5D59;
          --ssc-faint: #8A8880;
          --ssc-border: rgba(0,0,0,0.12);
          --ssc-panel: #F5F4EF;
          --ssc-tile: #FAFAF8;
          --ssc-clay: #D97757;
          --ssc-clay-bg: rgba(217,119,87,0.14);
          --ssc-label: #B0562F;
          --ssc-hover: rgba(115,114,108,0.10);
          font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
          background: var(--ssc-bg);
          color: var(--ssc-text);
          border: 1px solid var(--ssc-border);
          border-radius: 16px;
          padding: 20px 24px 24px;
          margin: 1.5rem 0;
          box-sizing: border-box;
        }
        .dark .ssc-root {
          --ssc-bg: #1B1A18;
          --ssc-text: #F1EFE9;
          --ssc-sub: #B8B5AD;
          --ssc-faint: #8A8880;
          --ssc-border: rgba(255,255,255,0.12);
          --ssc-panel: #24231F;
          --ssc-tile: #2A2925;
          --ssc-clay-bg: rgba(217,119,87,0.20);
          --ssc-label: #EBC9B7;
        }
        .ssc-fs { display: flex; flex-direction: column; justify-content: center; align-items: center; margin: 0; border-radius: 0; height: 100vh; }
        .ssc-fs .ssc-head { width: 100%; max-width: ${CANVAS_W}px; }
        .ssc-fs .ssc-frame { width: 100%; }
        .ssc-mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
        .ssc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
        .ssc-files { display: flex; gap: 8px; flex-wrap: wrap; }
        .ssc-file {
          font-size: 12.5px; font-weight: 430; padding: 8px 13px; border-radius: 10px; cursor: pointer;
          border: 0.5px solid var(--ssc-border); background: var(--ssc-tile); color: var(--ssc-text);
          white-space: nowrap; transition: background 0.2s, border-color 0.2s;
        }
        .ssc-file:hover { filter: brightness(0.97); }
        .ssc-file[aria-pressed="true"] { font-weight: 600; border: 1.5px solid var(--ssc-clay); background: var(--ssc-clay-bg); }
        .ssc-fsbtn {
          display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex-shrink: 0;
          border: none; background: none; border-radius: 6px; cursor: pointer; color: var(--ssc-faint); font-size: 15px;
        }
        .ssc-fsbtn:hover { background: var(--ssc-hover); }
        .ssc-frame { width: 100%; max-width: ${CANVAS_W}px; margin: 0 auto; }
        .ssc-canvas { position: relative; width: ${CANVAS_W}px; height: ${CANVAS_H}px; transform-origin: top left; }
        .ssc-machine { position: absolute; top: 42px; height: 182px; background: var(--ssc-panel); border-radius: 16px; }
        .ssc-machine-label { position: absolute; top: 192px; display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; }
        .ssc-tile {
          position: absolute; top: 58px; width: 126px; height: 108px; border-radius: 12px; padding: 11px 12px; box-sizing: border-box;
          background: var(--ssc-tile); border: 0.5px solid var(--ssc-border); opacity: 0.6;
          transition: background 0.25s, border-color 0.25s, opacity 0.25s;
        }
        .ssc-tile.ssc-on { background: var(--ssc-clay-bg); border: 1px solid var(--ssc-clay); opacity: 1; }
        .ssc-tile-name { display: flex; align-items: center; gap: 6px; color: var(--ssc-faint); }
        .ssc-tile.ssc-on .ssc-tile-name { color: var(--ssc-clay); }
        .ssc-tile-name span { font-size: 12px; font-weight: 430; white-space: nowrap; color: var(--ssc-text); }
        .ssc-tile.ssc-on .ssc-tile-name span { font-weight: 600; }
        .ssc-tile-caption { font-size: 10.5px; color: var(--ssc-sub); margin-top: 5px; line-height: 1.35; }
        .ssc-filemark {
          position: absolute; left: 5px; right: 5px; bottom: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 2px;
          font-size: 8.5px; color: var(--ssc-label); background: var(--ssc-bg); border: 1px solid var(--ssc-clay);
          border-radius: 6px; padding: 2px 3px; white-space: nowrap; overflow: hidden;
        }
        .ssc-filemark svg { flex-shrink: 0; }
        .ssc-machine-filemark { display: inline-flex; align-items: center; gap: 4px; margin-left: 10px; font-size: 10.5px; font-weight: 500; color: var(--ssc-label); }
        .ssc-ring {
          position: absolute; border: 2px solid var(--ssc-clay); border-radius: 18px; pointer-events: none;
          transition: left 0.35s ease, top 0.35s ease, width 0.35s ease, height 0.35s ease;
        }
        .ssc-ring-label {
          position: absolute; font-size: 12px; font-weight: 600; color: var(--ssc-label); white-space: nowrap; pointer-events: none;
          transition: left 0.35s ease, top 0.35s ease;
        }
      `}</style>

      <div className="ssc-head">
        <div className="ssc-files" role="group" aria-label="Settings file">
          {FILES.map(f => <button key={f.id} type="button" className="ssc-file ssc-mono" aria-pressed={f.id === sel} onClick={() => setSel(f.id)}>{f.path}</button>)}
        </div>
        <button type="button" className="ssc-fsbtn" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>{isFullscreen ? '⤡' : '⛶'}</button>
      </div>

      <div ref={frameRef} className="ssc-frame" style={{
    height: CANVAS_H * scale + 'px'
  }}>
        <div className="ssc-canvas" style={{
    transform: 'scale(' + scale + ')'
  }}>
          <div className="ssc-machine" style={{
    left: '10px',
    width: '430px'
  }} />
          <span className="ssc-machine-label" style={{
    left: '30px'
  }}><LaptopIcon />Your machine{fileAt.machine === 'you' && <span className="ssc-machine-filemark ssc-mono"><FileIcon />{selFile.path}</span>}</span>
          <div className="ssc-machine" style={{
    left: '460px',
    width: '200px'
  }} />
          <span className="ssc-machine-label" style={{
    left: '470px'
  }}><LaptopIcon />A teammate’s machine</span>
          <div className="ssc-machine" style={{
    left: '682px',
    width: '170px'
  }} />
          <span className="ssc-machine-label" style={{
    left: '692px'
  }}><CloudIcon />A cloud session</span>

          {TILES.map(t => {
    const on = coverage.includes(t.id);
    return <div key={t.id} className={'ssc-tile' + (on ? ' ssc-on' : '')} style={{
      left: t.left + 'px'
    }}>
                <div className="ssc-tile-name"><FolderIcon open={on} /><span className="ssc-mono">{t.name}</span></div>
                {t.caption && <div className="ssc-tile-caption">{t.caption}</div>}
                {fileAt.tiles.includes(t.id) && <span className="ssc-filemark ssc-mono" title={SHORT[sel]}><FileIcon />{TILE_MARK[sel]}</span>}
              </div>;
  })}

          <div className="ssc-ring" style={{
    left: ring.l + 'px',
    top: ring.t + 'px',
    width: ring.w + 'px',
    height: ring.h + 'px'
  }} />
          <span className="ssc-ring-label ssc-mono" style={{
    left: ring.l + 14 + 'px',
    top: ring.t - 26 + 'px'
  }}>{selFile.ring || selFile.path}</span>
        </div>
      </div>
    </div>;
};

<Note>
  This page covers Claude Code running on your machine: the terminal, the [VS Code](/docs/en/vs-code) and [JetBrains](/docs/en/jetbrains) extensions, and the [desktop app](/docs/en/desktop), which all read the same settings files. A cloud session on [Claude Code on the web](/docs/en/claude-code-on-the-web) runs on a different machine and reads only some of them; see [Settings in cloud sessions](#settings-in-cloud-sessions).
</Note>

Settings are the JSON keys that change how Claude Code behaves: which model it starts with, what it can run without asking, which files it can't read, how it looks in your terminal, and what your organization enforces.

Claude Code reads settings from JSON settings files such as `~/.claude/settings.json`. It looks for them in a few locations, and [the file it reads a setting from decides who the setting applies to](#settings-files-and-who-they-affect).

Use this page to pick the settings file that reaches the people you want a setting to apply to, change a setting and confirm it applied, and see which value Claude Code uses when the same key is set in more than one file.

<span id="available-settings" />

<span id="permission-rule-syntax" />

<span id="marketplace-key-aliases" />

<span id="environment-variables" />

<span id="sandbox-settings" />

<span id="permission-settings" />

<span id="hook-configuration" />

<span id="plugin-settings" />

<span id="global-config-settings" />

<span id="compute-managed-settings-with-a-policy-helper" />

<span id="attribution-settings" />

<span id="authentication-and-login" />

<span id="context-and-memory" />

<span id="data-and-privacy" />

<span id="exclude-sensitive-files" />

<span id="file-suggestion-settings" />

<span id="footer-link-badges" />

<span id="hook-and-skill-settings" />

<span id="manage-plugins" />

<span id="managed-policy" />

<span id="plugin-configuration" />

<span id="tools-available-to-claude" />

<span id="worktree-settings" />

<span id="invalid-entries-in-managed-settings" />

<span id="sandbox-path-prefixes" />

<span id="owner-wildcards" />

<span id="enabledplugins" />

<span id="pluginconfigs" />

<span id="extraknownmarketplaces" />

<span id="strictknownmarketplaces" />

<span id="strictpluginonlycustomization" />

The [settings reference](/docs/en/settings-reference) lists every key you can set, with the file you set it in, its type, and its default. [Configure permissions](/docs/en/permissions) covers what Claude Code can run without asking and how to write `allow`, `ask`, and `deny` rules.

<span id="settings-files" />

<span id="configuration-scopes" />

<span id="available-scopes" />

<span id="when-to-use-each-scope" />

<span id="what-uses-scopes" />

<span id="subagent-configuration" />

<span id="where-settings-live" />

## Settings files and who they affect

Claude Code reads settings from four files, and an organization can also deliver managed settings from the claude.ai console. Each source has a scope: the set of people and projects a setting saved in it applies to, whether that's just you, everyone in a project, or everyone in your organization.

| Scope          | File                                                                                          | Who it affects                                                                                                                                                       | Use it for                                                                         |
| :------------- | :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| User           | `~/.claude/settings.json`                                                                     | You, in every project on this machine                                                                                                                                | Personal preferences: theme, editor mode, default model, your own permission rules |
| Shared project | `.claude/settings.json`                                                                       | Everyone working in the folder that contains it. In a git repository, commit it so teammates get it                                                                  | Team permissions, hooks, plugins, and the environment variables the project needs  |
| Project local  | `.claude/settings.local.json`                                                                 | You, in this one project only. Claude Code keeps it out of git when it creates the file; if you create it by hand, add it to `.gitignore` yourself                   | Personal overrides for one project, and testing before you share                   |
| Managed        | `managed-settings.json` and other [managed sources](/docs/en/managed-settings#delivery-mechanisms) | Everyone your organization deploys it to; nothing you set overrides it, apart from a few [security-sensitive exceptions](#exceptions-to-managed-settings-precedence) | Security policy and compliance requirements                                        |

In the File column, `~/.claude` is the `.claude` folder in your home directory, and a bare `.claude` is the `.claude` folder inside your project.

<span id="where-each-file-applies" />

<span id="compare-what-each-file-reaches" />

### Compare the scope of each settings file

Suppose you have three projects on your machine, `website/`, `api/`, and `acme-app/`, a teammate has their own clone of `acme-app/`, and you start a [cloud session](#settings-in-cloud-sessions) on `acme-app/`.

The graphic below shows which of those folders a setting applies in when you start Claude Code from them. Click a settings file to see the folders it reaches.

<SettingsScope />

* **`~/.claude/settings.json`**: every project on your machine, and nothing on your teammate's or in the cloud session
* **`acme-app/.claude/settings.json`**: your `acme-app/`. It reaches your teammate's clone and the cloud session only if you commit the file to version control; until you do, it's a file on your disk like any other and nobody else has it
* **`acme-app/.claude/settings.local.json`**: your `acme-app/` only. Claude Code adds it to your global git excludes the first time it writes the file, so it stays out of your commits; if you create the file by hand, [add it to `.gitignore` yourself](#keep-personal-settings-out-of-a-repository)
* **Managed settings**, whether a `managed-settings.json` file, an MDM policy, or [server-managed settings](/docs/en/server-managed-settings) from the claude.ai console: every project on every machine your organization deploys it to, or that you sign in to with your organization account. Only server-managed settings reach the cloud session

<span id="which-files-you-have" />

### Find or create your settings files

Installing Claude Code doesn't create any settings file. If your machine or project already has one, it came from one of these sources:

* **Managed**: your organization deploys it. You don't create or edit it.
* **Shared project**: a project that already uses Claude Code may have one committed. If not, create it at `.claude/settings.json` in the project folder.
* **User** and **Project local**: create them yourself, or let Claude Code create them. It writes `~/.claude/settings.json` the first time you change an option in the `/config` menu that it stores in user settings, such as the theme, and `.claude/settings.local.json` the first time you give a standing approval on a permission prompt, such as "Yes, and don't ask again" for a Bash command. A few `/config` options, including **Show tips**, save to `.claude/settings.local.json` instead of the user file.

<Info>
  On Windows, `~/.claude` means `%USERPROFILE%\.claude`. To keep the home-directory files somewhere else, set [`CLAUDE_CONFIG_DIR`](/docs/en/env-vars); Claude Code then stores your settings, session history, and plugins there instead.
</Info>

Claude Code also keeps a fifth file, [`~/.claude.json`](/docs/en/claude-directory#ce-claude-json), that it writes for itself; you don't need to edit it. It holds your sign-in session, [MCP server](/docs/en/mcp) configurations, per-project state such as trust decisions, and the [global config keys](/docs/en/settings-reference#global-config-settings) that `/config` writes for you.

### Share settings with your team

Commit `.claude/settings.json` so everyone who clones the repository gets the same permissions, hooks, telemetry, and plugins. Each teammate can still override it for themselves in their own `.claude/settings.local.json`, so personal exceptions don't need a commit. For a complete team file, see [a team's shared settings](/docs/en/settings-example#a-teams-shared-settings).

Some of what you commit waits until each teammate [trusts the folder](/docs/en/permissions#project-allow-rules-and-workspace-trust), and a few keys never take effect from a repository file; [Troubleshoot a setting that doesn't apply](#common-cases) covers both.

<span id="local-settings-file" />

<span id="where-claude-code-saves-the-project-local-file" />

<span id="the-project-local-file" />

<span id="keep-personal-settings-out-of-the-repository" />

### Keep personal settings out of a repository

To change a setting for yourself in one project without changing it for your teammates, save it in `.claude/settings.local.json` inside the project. Claude Code applies that file over the committed `.claude/settings.json`, so if your team's file sets `"model": "claude-sonnet-5"` and you want Opus, put `"model": "claude-opus-4-8"` in your local file and only your sessions change.

Three things to know about the local file:

* **Claude Code writes it too.** When Claude asks permission to run a Bash command and you choose "Yes, and don't ask again", Claude Code saves that [permission approval](/docs/en/permissions#permission-system) here as an `allow` rule.
* **You don't need to gitignore it yourself, unless you created it by hand.** The first time Claude Code writes the file in a git repository that doesn't already ignore it, it adds `**/.claude/settings.local.json` to your global git excludes file, so the file stays out of your commits in every repository. That file is `core.excludesFile` when your global git config sets it to an absolute or `~`-prefixed path; otherwise it's `$XDG_CONFIG_HOME/git/ignore`, or `~/.config/git/ignore` when `XDG_CONFIG_HOME` is unset. If you created the file by hand and Claude Code hasn't written to it yet, add it to `.gitignore` yourself.
* **Its allow rules don't wait for trust while the file stays untracked.** Because the file is yours and not the repository's, Claude Code applies its `allow` rules without the [workspace trust](/docs/en/permissions#project-allow-rules-and-workspace-trust) step it requires for the committed file. If the file is tracked by git, the trust step applies to it too; see [When your local settings file needs trust](/docs/en/permissions#when-your-local-settings-file-needs-trust).

<span id="where-claude-code-looks-for-each-file" />

<span id="how-claude-code-keeps-the-local-file-out-of-git" />

<span id="local-allow-rules-dont-wait-for-workspace-trust" />

#### Where Claude Code keeps the local file in a git repository

When Claude asks permission to run a Bash command and you choose "Yes, and don't ask again", Claude Code saves that approval as an `allow` rule in `.claude/settings.local.json`. If you start Claude Code in a subdirectory of a git repository, it reads and writes that file at the repository root and applies the approval across the whole repository. In a [worktree](/docs/en/worktrees), it uses the file at the main checkout's root.

Two rules qualify the root location:

* **When the file stays with `.claude/settings.json` instead**: outside a git repository, when the repository root is your home directory, on Windows, or when the repository root or its `.git` or `.claude` entry isn't owned by your user.
* **Paths in the file don't anchor at the repository root**: a permission rule that starts with `/` or a relative sandbox path [anchors at the session's primary working directory](/docs/en/permissions#read-and-edit) instead.

Before v2.1.211, Claude Code kept the file in the starting directory. It still reads a file an earlier version left there alongside the root file; where both set the same key, the root's value applies, and permission rules from both files apply. The Agent SDK's [`resolveSettings()`](/docs/en/agent-sdk/typescript#resolvesettings) helper always reads the file from the starting directory.

Claude Code reads the shared `.claude/settings.json` from the session's [primary working directory](/docs/en/permissions#working-directories), so to use a file committed at the repository root, start Claude Code there. After you [move the session with `/cd`](/docs/en/permissions#move-the-session-to-another-directory), Claude Code reads both project files from the new directory instead, placing the local file by the same rules. Reading them from the directory you moved to requires Claude Code v2.1.246 or later.

<span id="managed-settings-delivery" />

<span id="precedence-within-the-managed-tier" />

<span id="parent-settings-from-embedding-hosts" />

<span id="enforce-settings-for-an-organization" />

<span id="settings-your-organization-manages" />

### Check what your organization enforces

If your organization manages Claude Code, some settings are decided for you and nothing you put in your own files changes them. To see which, run `/status`: the `Setting sources` line names the managed source that applies to you. Managed settings apply wherever Claude Code runs on this machine; [What a developer can change](/docs/en/managed-settings#what-a-developer-can-change) covers local admin rights and tools other than Claude Code.

Managed settings reach you through the [delivery mechanisms](/docs/en/managed-settings#delivery-mechanisms) on the managed settings page, most commonly:

* [Server-managed settings](/docs/en/server-managed-settings), which Claude Code fetches from the claude.ai admin console or a self-hosted [Claude apps gateway](/docs/en/claude-apps-gateway)
* MDM or OS-level policies, and `managed-settings.json` files in a system directory
* An embedding host such as Claude Desktop, through the SDK `managedSettings` option; see [Control policy from an embedding host](/docs/en/managed-settings#parent-settings-from-embedding-hosts)

In a [Cowork](https://claude.com/docs/cowork/overview) session that runs on your machine in the Claude Desktop app, Claude Code doesn't fetch server-managed settings from the claude.ai admin console, and it reads policy deployed to your device unless your organization's Claude Desktop configuration sets `requireCoworkFullVmSandbox`. [Where and when a policy applies](/docs/en/managed-settings#where-and-when-a-policy-applies) covers Cowork and cloud sessions.

If you're the administrator, [Set up Claude Code for your organization](/docs/en/admin-setup) walks through choosing what to enforce, and [Deploy managed settings](/docs/en/managed-settings) covers delivery and how to confirm a policy is in force.

## Change a setting

You can change a setting from the `/config` menu, by editing a settings file, or for one session from the command line.

<span id="system-prompt" />

Claude Code's system prompt isn't published. To give Claude standing instructions, use [`CLAUDE.md` files](/docs/en/memory) or the `--append-system-prompt` flag.

### Use the /config menu

Run `/config` inside Claude Code and open the **Config** tab. It lists a short set of personal options such as theme, editor mode, and verbose output, not every settings key. Select an option to change it; Claude Code saves it for you:

* **Most options**: `~/.claude/settings.json`
* **A few options, such as Show tips**: `.claude/settings.local.json`
* **The [global config options](/docs/en/settings-reference#global-config-settings)**: `~/.claude.json`

To set one option without the menu, pass `key=value`, such as `/config verbose=true`.

<Note>
  `/config` is part of the terminal interface. The [VS Code](/docs/en/vs-code) chat panel and the [desktop app](/docs/en/desktop) don't open it; change settings there by editing a settings file or through those apps' own settings.
</Note>

### Edit a settings file

Open the settings file for the scope you want in your editor and add or change a key. Settings files are strict JSON: a `//` comment or a trailing comma is a syntax error, and Claude Code reports the file as a [Settings Error](#fix-a-broken-settings-file) at the next start. For example, to let Claude Code run your lint and test commands without asking and stop it reading `.env` files, add this to `~/.claude/settings.json`:

```json ~/.claude/settings.json theme={null}
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test *)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)"
    ]
  }
}
```

Each entry under `permissions` is a rule that names a tool and what it may do; [Configure permissions](/docs/en/permissions) explains the syntax. The `$schema` line points to the [published JSON schema](https://json.schemastore.org/claude-code-settings.json) for Claude Code settings, which gives you autocomplete and inline validation in VS Code, Cursor, and any other editor that supports JSON schema. The schema can lag behind the newest CLI releases, so a validation warning on a recently documented key doesn't mean your configuration is invalid.

After you save, run `/status` inside Claude Code to confirm the file loaded; [Confirm what loaded](#check-what-loaded) says what the `Setting sources` line shows and how a broken file is reported.

For a complete personal file, team file, and organization file, each shown with a comment on every key it sets, see the [example settings files](/docs/en/settings-example).

<span id="pass-settings-for-one-session" />

### Change a setting for one session

To try a value without saving it, set it when you start Claude Code. The value applies to that session and your settings files stay as they were. You have three ways to do it:

* **`--settings`**: pass a key as JSON, inline or as a path to a file. Claude Code applies it above your user, project, and local files and below managed settings. It can set any key your user settings file can set; it can't set `Managed` or `Global config` keys.
* **A flag for that key**: some keys have their own flag, such as `--model` for `model` and `--effort` for `effortLevel` and `modelSettings`.
* **An environment variable**: export the key's paired variable before you run `claude`, such as `ANTHROPIC_MODEL` for `model`.

Each key's entry on the [settings reference](/docs/en/settings-reference) lists its per-session overrides and which one takes precedence, so check the entry for the key you want to change.

Commands you run inside a session mostly save your choice: `/config` writes to your settings files, `/model` saves the value as your default for new sessions, and `/effort` on your machine saves the level as your default for the model you're using.

If you press `s` in the `/model` picker, Claude Code switches the model without saving it as your user default. Claude Code applies some `/effort` levels, such as `max` and `ultracode`, to the current session only; see [Adjust effort level](/docs/en/model-config#adjust-effort-level).

For example, to start one session on Opus without changing your default:

```bash theme={null}
claude --settings '{"model": "claude-opus-4-8"}'
```

### When edits take effect

Claude Code watches your settings files and reloads them when they change, so it applies most edits to the running session without a restart, including edits to `permissions`, `hooks`, and credential helpers such as `apiKeyHelper`. The reload covers user, project, local, and managed settings, and Claude Code runs the [`ConfigChange` hook](/docs/en/hooks#configchange) for each settings-file change it detects, not for managed settings that arrive from MDM or the claude.ai console. Managed settings that arrive through MDM or from the claude.ai console reach a running session on a schedule rather than on save; the [delivery table](/docs/en/managed-settings#choose-a-delivery-mechanism) gives it per source.

Claude Code reads some keys only once, at session start, so an edit to one of them doesn't reach the running session. Admin-side keys that also wait for a restart, such as `requiredMinimumVersion`, are listed under [where and when a policy applies](/docs/en/managed-settings#where-and-when-a-policy-applies). The ones you're most likely to edit mid-session:

* [`model`](/docs/en/settings-reference#model): use [`/model`](/docs/en/model-config#setting-your-model) to switch mid-session. Each model has its own prompt cache, so the first request after a switch re-reads the whole conversation uncached; see [Switching models](/docs/en/prompt-caching#switching-models)
* [`effortLevel`](/docs/en/settings-reference#effortlevel) and [`modelSettings`](/docs/en/settings-reference#modelsettings): use [`/effort`](/docs/en/model-config#adjust-effort-level) to change effort mid-session
* [`outputStyle`](/docs/en/settings-reference#outputstyle): part of the system prompt, so Claude Code applies the edit after `/clear` or a restart

<span id="verify-active-settings" />

<span id="check-what-loaded" />

### Confirm what loaded

Run `/status` inside Claude Code to see which settings sources are active. The **Status** tab includes a `Setting sources` line that lists each settings file Claude Code loaded for the current session, such as `User settings` or `Project local settings`. When [managed settings](/docs/en/admin-setup#decide-how-settings-reach-devices) are in effect, the managed settings entry shows in parentheses how they reached your machine.

The line confirms which files Claude Code read; it doesn't show which file supplied each key. To list entries Claude Code rejected, run [`claude doctor`](/docs/en/debug-your-config); for a model that project or managed settings set, the startup header names the file that set it. `/status` and `/config` open the same dialog on different tabs, and the **Config** tab isn't a view of your `settings.json` contents.

### Fix a broken settings file

If you mistype JSON or set a key to a value Claude Code doesn't accept, Claude Code tells you at the start of an interactive session. What it shows depends on how much of the file is affected:

* **Settings Error**: a user, project, or local file has invalid JSON or a value the schema rejects. At the start of an interactive session Claude Code shows a dialog that lets you fix the file with Claude's help, exit, or continue without the broken settings.
* **Settings Warning**: only individual entries fail, such as a malformed permission rule or an unknown hook event name. Claude Code skips those values and keeps the rest of the file in effect.
* **Managed settings**: Claude Code keeps enforcing the rest of the file. [Invalid entries in managed settings](/docs/en/managed-settings#invalid-entries-in-managed-settings) says what it drops and which keys fall back to a stricter value until you fix them. For a managed settings document that isn't valid JSON, see [Managed settings document could not be parsed](/docs/en/errors#managed-settings-document-could-not-be-parsed).
* **Configuration error**: `~/.claude.json` can't be parsed. Claude Code copies the broken file to `~/.claude/backups/.claude.json.corrupted.<timestamp>` and asks whether to exit and fix it by hand or reset to the default configuration; a `-p` run prints the error and exits. To recover your previous state, copy back one of the five most recent `.claude.json.backup.<timestamp>` files in `~/.claude/backups/`, which Claude Code saves before it writes the file.

After you continue, run `/status` to see the affected files and `claude doctor` for the details of each error.

A `-p` run shows no dialog. Unless [a managed settings document can't be parsed](/docs/en/errors#managed-settings-document-could-not-be-parsed), Claude Code skips the broken file or values and continues with the rest, so after a `-p` run that ignores a setting, run `claude doctor` to see what it dropped.

<span id="how-scopes-interact" />

<span id="key-points-about-the-configuration-system" />

<span id="which-value-claude-code-uses" />

<span id="which-value-wins" />

## Settings precedence

When the same key appears in more than one place, Claude Code uses the value from the highest level that sets it. The stack below shows the levels, highest on top; a key at a higher level overrides the same key anywhere below it.

<SettingsPrecedence />

In order, highest precedence first:

1. **Managed settings**: settings your organization deploys, by a `managed-settings.json` file, an MDM policy, or [server-managed settings](/docs/en/server-managed-settings) from the claude.ai console. Nothing you set overrides them: a key you pass with `--settings` doesn't override the same managed key, and a flag such as `--model` picks only from the models your organization allows. A managed `model` sets the model each session starts with, and you can still switch with `/model`; the lock is [`availableModels`](/docs/en/settings-reference#availablemodels), which constrains `/model`, `--model`, and the `model` key in your own files. When your organization delivers more than one managed source, the rules for [precedence within the managed tier](/docs/en/managed-settings#precedence-within-the-managed-tier) say what Claude Code reads from each.
2. **Command line arguments**: flags you pass when you start `claude` from a terminal, for one session; see [Change a setting for one session](#change-a-setting-for-one-session). Claude Code merges JSON you pass with `--settings <file-or-json>` with your settings files by the same rules as the other levels: it takes a key you set here over the same key in local, project, or user settings, and keeps the lower-level value for a key you omit.
3. **Project local settings** (`.claude/settings.local.json`): your personal settings for this project.
4. **Shared project settings** (`.claude/settings.json`): settings your team checks into source control.
5. **User settings** (`~/.claude/settings.json`): your personal settings for every project.

Environment variables aren't a level in this stack. When a behavior has both a shell variable and a settings key, which one applies is decided per pair, not by level: `ANTHROPIC_MODEL` exported in your shell applies over the `model` key from any file, while `ANTHROPIC_DEFAULT_MODEL` applies only when no file sets `model`. The [environment variables reference](/docs/en/env-vars#precedence) says which keys have a pair and which one Claude Code reads first. An `env` block inside a settings file is an ordinary key and follows the levels above.

For a few security-sensitive keys, Claude Code honors a stricter value from a lower level over a managed value; [Exceptions to managed settings precedence](#exceptions-to-managed-settings-precedence) lists them.

### Lists merge instead of overriding

When you set the same list key, such as `permissions.allow`, in more than one file, Claude Code combines the lists instead of picking one, so each file can add entries without removing another file's. Four keys that hold model lists or per-model entries follow their own rules:

* [`fallbackModel`](/docs/en/settings-reference#fallbackmodel) is an ordered chain where position carries meaning, so Claude Code takes the whole value from the highest-precedence file that defines it.
* [`modelPicker`](/docs/en/settings-reference#modelpicker) holds one ordered list of rows plus a replace flag, so Claude Code never merges rows from two sources. It takes the whole value from the highest of managed settings, `--settings`, and user settings that defines it, and ignores the key in project and local settings. Requires Claude Code v2.1.242 or later.
* [`availableModels`](/docs/en/settings-reference#availablemodels): when the managed settings Claude Code applies define it, Claude Code applies that list as-is and ignores entries you add in user, project, or local settings, unless an app that embeds Claude Code supplies its own model list; see [Exceptions to managed settings precedence](#exceptions-to-managed-settings-precedence). Across managed sources the list never merges either; [how Claude Code combines managed sources](/docs/en/managed-settings#how-claude-code-combines-managed-sources) says which source's list applies. Across non-managed scopes Claude Code merges the arrays as usual.
* [`modelSettings`](/docs/en/settings-reference#modelsettings): Claude Code resolves it one model at a time, together with [`effortLevel`](/docs/en/settings-reference#effortlevel). The `modelSettings` entry states which file's value applies to a model.

<span id="examples" />

### Precedence examples

While Claude works, Claude Code shows a one-line tip under the spinner, such as "Use /config to change your default permission mode (including Plan Mode)". Suppose you want those tips off, so you set [`spinnerTipsEnabled`](/docs/en/settings-reference#spinnertipsenabled) to `false` in `~/.claude/settings.json`. Each scenario below is something that can turn them back on, and what you can do about it.

#### Team settings override personal settings

Your team's `.claude/settings.json` sets it to `true`. Claude Code uses the project value because shared project sits above user, so you see tips in that project and nowhere else.

You can get your value back: add `"spinnerTipsEnabled": false` to `.claude/settings.local.json` in that project. Project local sits above shared project, so your sessions there stop showing tips and your teammates' sessions don't change.

#### Organization settings override everything

Your organization's managed settings set it to `true`. Nothing you put in user, project, or local settings turns tips off, and neither does `--settings`. Managed is the top level.

You can't get your value back. Run `/status` to see which managed source applies, and ask your administrator if the policy should change.

#### The command line overrides your files for one session

You started the session with `claude --settings '{"spinnerTipsEnabled": true}'`. Command line sits above every file except managed, so that session shows tips even though your files say `false`.

You get your value back on the next session; `--settings` lasts one session and doesn't write to any file.

#### A flag or environment variable sets the same thing

Some keys have a command line flag or an environment variable that overrides the settings value regardless of which file set it: `ANTHROPIC_MODEL` overrides the [`model`](/docs/en/settings-reference#model) setting, and `--model` overrides both for a session.

Whether you can get your value back depends on the key: unset the variable or drop the flag, and check the key's entry on the [settings reference](/docs/en/settings-reference) and the variable's row on the [environment variables reference](/docs/en/env-vars) for which one Claude Code uses.

<span id="keys-ignored-in-a-repository-file" />

<span id="keys-only-you-or-your-organization-can-set" />

<span id="common-cases" />

<span id="which-value-applies-in-common-situations" />

### Troubleshoot a setting that doesn't apply

When you set a key and Claude Code doesn't behave as if you had, start with `/status` to see which files it loaded, then find your symptom below. [Debug your configuration](/docs/en/debug-your-config) covers the wider checks, including a clean-configuration test.

#### A value you set is ignored

Something else is setting the same key, the file can't set that value, or the file didn't load:

* **A higher level sets it.** Another settings file, a `--settings` flag, or a managed source sets the key above yours; the [stack](#settings-precedence) says which. A flag or environment variable can also override the key on its own, decided key by key; the key's entry on the [settings reference](/docs/en/settings-reference) says which one Claude Code uses, and the [`env` entry](/docs/en/settings-reference#env) covers a managed `env` value versus a shell export.
* **A security key keeps its strict value.** For a few keys Claude Code honors the restrictive value from any file, so a project `true` for [`disableClaudeAiConnectors`](/docs/en/settings-reference#disableclaudeaiconnectors) stays on; see [Exceptions to managed settings precedence](#exceptions-to-managed-settings-precedence).
* **The file can't set that value.** [`permissions.defaultMode`](/docs/en/settings-reference#permissions-defaultmode) values `auto` and `bypassPermissions` don't take effect from project or local settings; set them in user or managed settings instead, or pass `--permission-mode` for one session. Before v2.1.257, `bypassPermissions` took effect from any file.
* **The file is broken.** Invalid JSON or a rejected value makes Claude Code skip the file or the entry; see [Fix a broken settings file](#fix-a-broken-settings-file).

#### A managed change hasn't reached you

Managed sources reach a running session on the schedule in the [delivery table](/docs/en/managed-settings#choose-a-delivery-mechanism), so restart the session first. If `/status` then names a different source than the one your administrator changed, a higher-priority source applies; [How Claude Code combines managed sources](/docs/en/managed-settings#how-claude-code-combines-managed-sources) gives the order.

#### A committed key doesn't reach teammates

Two things keep a key in `.claude/settings.json` from applying for everyone who clones it:

* **Claude Code ignores the key in a repository file.** Look for `User, local, or managed`, `User or managed`, `Managed`, or `Global config` in the Scope column of the [All settings](/docs/en/settings-reference#all-settings) index; those keys never apply from the shared file, apart from [`autoContinueAtUsageLimit`](/docs/en/settings-reference#autocontinueatusagelimit), which a repository file can still switch off: while the file sets the key and no user, `--settings`, or managed value does, Claude Code reads the setting as off. `Global config` keys apply only from `~/.claude.json`.
* **The key waits for trust.** `permissions.allow` rules, `permissions.additionalDirectories`, `extraKnownMarketplaces`, and most [`env`](/docs/en/settings-reference#env) values apply only after each teammate [trusts the folder](/docs/en/permissions#project-allow-rules-and-workspace-trust). Until then they still see prompts and don't get plugins from a marketplace the file declares. `deny` and `ask` rules apply right away.

#### Permission rules combine differently than you expected

* **You chose "Yes, and don't ask again" on a permission prompt but still get prompted for the same tool.** That choice saved an `allow` rule to your local file, and an `allow` rule there doesn't outrank an `ask` rule from a project or managed file; [how permission rules combine](/docs/en/permissions#settings-precedence) explains the order. In the VS Code extension the approval card lets you pick the destination file, including the project's shared file, which changes the rule for everyone; in the CLI, Claude Code writes only to your local file.
* **Your organization's allow rules still apply alongside yours.** That's expected: Claude Code merges [`permissions.allow`](/docs/en/settings-reference#permissions-allow) across scopes, unless your organization sets [`allowManagedPermissionRulesOnly`](/docs/en/settings-reference#allowmanagedpermissionrulesonly).

<span id="security-keys-where-the-stricter-value-applies" />

### Exceptions to managed settings precedence

For a few security-sensitive keys, Claude Code honors a restrictive value from a scope that otherwise couldn't override managed settings. Find the key in this table to see which value it honors and from where.

| Key                                                                             | Value Claude Code honors                                                                                                     | Notes                                                                                                                                                              |
| :------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`disableClaudeAiConnectors`](/docs/en/settings-reference#disableclaudeaiconnectors) | `true` from any scope                                                                                                        | Honored even when a managed source sets `false`                                                                                                                    |
| [`enableArtifact`](/docs/en/settings-reference#enableartifact)                       | `false` from any scope, and `disableArtifact: true` from any scope                                                           | Honored even when a managed source sets `true`; nothing turns the [Artifact tool](/docs/en/artifacts#disable-artifacts) back on. Requires Claude Code v2.1.242 or later |
| [`isolatePeerMachines`](/docs/en/settings-reference#isolatepeermachines)             | `true` from any scope                                                                                                        | Honored even when a managed source sets `false`                                                                                                                    |
| [`remoteControlAtStartup`](/docs/en/settings-reference#remotecontrolatstartup)       | `false` from `.claude/settings.json` or `.claude/settings.local.json`                                                        | Honored even when a managed source sets `true`; a project or local `true` is ignored                                                                               |
| [`crossSessionInbound`](/docs/en/settings-reference#crosssessioninbound)             | A stricter value from `.claude/settings.json` or `.claude/settings.local.json`, on the `accept` \< `hold` \< `refuse` ladder | Honored over managed, `--settings`, and user values; a project or local value that isn't stricter is ignored                                                       |
| [`useAutoModeDuringPlan`](/docs/en/settings-reference#useautomodeduringplan)         | `false` from any managed source, `--settings`, `~/.claude/settings.json`, or `.claude/settings.local.json`                   | Honored even when the winning managed source sets `true`; a `false` in `.claude/settings.json` is ignored                                                          |
| [`syncClaudeAiSkills`](/docs/en/settings-reference#syncclaudeaiskills)               | `false` from any managed source, `--settings`, `~/.claude/settings.json`, or `.claude/settings.local.json`                   | Honored even when the winning managed source sets `true`; a `false` in `.claude/settings.json` is ignored                                                          |

An app that runs Claude Code inside itself and sets [`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`](/docs/en/env-vars) is also an exception. Claude Code takes that app's model configuration over the `model`, `fallbackModel`, and `modelOverrides` keys from every managed source, and over the model-selection variables in a managed `env` block, such as `ANTHROPIC_MODEL` and the `ANTHROPIC_DEFAULT_*_MODEL` family. Claude Code keeps a managed [`availableModels`](/docs/en/settings-reference#availablemodels) allowlist in force unless the app supplies its own.

## Settings in cloud sessions

A cloud session, on [Claude Code on the web](/docs/en/claude-code-on-the-web) or from [`claude --cloud`](/docs/en/claude-code-on-the-web#from-terminal-to-web), runs in a [cloud environment](/docs/en/cloud-environments) on a fresh clone of your repository, not on your machine. That changes which settings reach it:

* **Shared project settings** (`.claude/settings.json`): read, because the file is part of the clone. Commit a setting there to apply it in cloud sessions.
* **User and project local settings** (`~/.claude/settings.json` and `.claude/settings.local.json`): not read. Both stay on your machine, and the local file isn't in the clone.
* **Managed settings**: only [server-managed settings](/docs/en/server-managed-settings) reach a cloud session; a `managed-settings.json` file or MDM profile on your device doesn't. A [self-hosted environment](/docs/en/self-hosted-environments) also reads the managed settings file in its runner image. [How Claude Code combines managed sources](/docs/en/managed-settings#how-claude-code-combines-managed-sources) says when that file applies.
* **`/config`**: on the web, opens the Claude Code section of your claude.ai settings instead of changing a value. To change a setting for a cloud session, set an [environment variable](/docs/en/cloud-environments#set-environment-variables) on the environment or commit the key to the repository's `.claude/settings.json`.

[What carries over from your setup](/docs/en/cloud-environments#what-carries-over-from-your-setup) lists the rest: `CLAUDE.md`, skills, MCP servers, plugins, and credentials.

## What's next

* [Settings reference](/docs/en/settings-reference): every key, with where you set it and an example
* [Example settings files](/docs/en/settings-example): a personal file, a team file, and an organization's managed file
* [Configure permissions](/docs/en/permissions): allow, ask, and deny rules, and what Claude Code runs without asking
* [Environment variables](/docs/en/env-vars): the variables Claude Code reads and the `env` block
* [Debug your configuration](/docs/en/debug-your-config): when a setting doesn't apply
* [Claude directory reference](/docs/en/claude-directory): every file Claude Code reads, including subagents, MCP servers, plugins, and `CLAUDE.md`
