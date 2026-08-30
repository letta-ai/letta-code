> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Claude Code settings reference

> Complete reference for every Claude Code settings.json key: where each one goes, its type and default, and a paste-ready example, with an index of every key.

export const BackToIndex = ({href = '#all-settings', label = 'Back to index'}) => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight);
    onScroll();
    window.addEventListener('scroll', onScroll, {
      passive: true
    });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return <div className="not-prose">
      <style>{`
        .bti-btn {
          position: fixed; right: 20px; bottom: 20px; z-index: 40;
          display: inline-flex; align-items: center; gap: 6px;
          padding: 8px 12px; border-radius: 999px;
          font-size: 13px; font-weight: 500; line-height: 1; text-decoration: none;
          color: #1f1f1f; background: #ffffff; border: 1px solid #d9d9d9;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          opacity: 0; pointer-events: none; transform: translateY(6px);
          transition: opacity 160ms ease, transform 160ms ease;
        }
        .bti-btn.bti-show { opacity: 1; pointer-events: auto; transform: translateY(0); }
        .bti-btn:hover { border-color: #b3b3b3; }
        .dark .bti-btn { color: #ececec; background: #1e1e1e; border-color: #3a3a3a; box-shadow: 0 2px 8px rgba(0,0,0,0.5); }
        .dark .bti-btn:hover { border-color: #5a5a5a; }
        @media (max-width: 1279px) { .bti-btn { bottom: 112px; } }
        @media print { .bti-btn { display: none; } }
      `}</style>
      <a className={'bti-btn' + (show ? ' bti-show' : '')} href={href} aria-hidden={!show} tabIndex={show ? 0 : -1}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        {label}
      </a>
    </div>;
};

export const ReferenceFilter = ({placeholder, noun, facets, facetOrder, columnHelp, children}) => {
  const useLive = init => {
    const [v, setV] = useState(init);
    const ref = useRef(init);
    return [v, ref, x => {
      ref.current = x;
      setV(x);
    }];
  };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = s => s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's';
  const facetNames = facets || ['category', 'topic', 'scope', 'where'];
  const orderOf = {};
  Object.keys(facetOrder || ({})).forEach(k => {
    orderOf[k] = facetOrder[k].map(x => String(x).toLowerCase());
  });
  const rankIn = (col, v) => {
    const list = orderOf[col];
    if (!list) return -1;
    const i = list.indexOf(String(v).toLowerCase());
    return i < 0 ? list.length : i;
  };
  const cmpValues = col => (a, b) => {
    const ra = rankIn(col, a);
    const rb = rankIn(col, b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const help = columnHelp || ({});
  const FIRST_COL_HELP = 'Click an entry to open it.';
  const optionLabel = (f, c) => c === 'All' ? 'All ' + plural(f.label.toLowerCase()) : c;
  const nounText = noun || 'entries';
  const placeholderText = placeholder || 'Filter this reference';
  const rootRef = useRef(null);
  const tablesRef = useRef(null);
  const searchRef = useRef(null);
  const menuRef = useRef({});
  const [q, qRef, setQ] = useLive('');
  const [sel, selRef, setSel] = useLive({});
  const [sortBy, sortRef, setSortBy] = useLive(null);
  const [menuOpen, menuOpenRef, setMenu] = useLive(null);
  const [facetList, setFacetList] = useState([]);
  const [firstHead, setFirstHead] = useState('');
  const [counts, setCounts] = useState({
    shown: 0,
    total: 0
  });
  const [disabled, setDisabled] = useState(false);
  const menuBtn = name => menuRef.current[name] ? menuRef.current[name].querySelector(':scope > button') : null;
  const menuList = name => menuRef.current[name] ? menuRef.current[name].querySelector('[role="listbox"]') : null;
  const closeMenu = name => {
    setMenu(null);
    const btn = menuBtn(name);
    if (btn) btn.focus();
  };
  const focusSelected = name => {
    const list = menuList(name);
    if (!list) return;
    const btn = list.querySelector('button[aria-selected="true"]') || list.querySelector('button');
    if (btn) btn.focus();
  };
  const setFacet = (name, value) => {
    setSel(Object.assign({}, selRef.current, {
      [name]: value
    }));
    apply(qRef.current);
    closeMenu(name);
  };
  const sortTables = by => {
    (tablesRef.current || []).forEach(tab => {
      const t = tab.el;
      const idx = tab.heads.indexOf(by);
      const body = t.querySelector('tbody');
      if (idx < 0 || !body) return;
      const rows = [...body.querySelectorAll('tr')];
      const keyOf = r => r.children[idx] ? r.children[idx].textContent.trim().toLowerCase() : '';
      const cmp = cmpValues(by);
      rows.map((r, i) => ({
        r,
        i: Number(r.dataset.sfIndex !== undefined ? r.dataset.sfIndex : i),
        k: keyOf(r)
      })).sort((a, b) => cmp(a.k, b.k) || a.i - b.i).forEach(x => body.appendChild(x.r));
      [...t.querySelectorAll('thead th')].forEach((h, i) => {
        const sortable = tab.heads[i] === tab.heads[0] || facetNames.indexOf(tab.heads[i]) > -1;
        if (sortable) h.setAttribute('aria-sort', i === idx ? 'ascending' : 'none'); else h.removeAttribute('aria-sort');
      });
    });
  };
  const scan = () => {
    const tables = [];
    let el = rootRef.current ? rootRef.current.nextElementSibling : null;
    while (el) {
      if (el.tagName === 'H2' || el.querySelector(':scope > h2')) break;
      const found = el.tagName === 'TABLE' ? [el] : [...el.querySelectorAll('table')];
      found.forEach(t => {
        const headCells = [...t.querySelectorAll('thead th, thead td')];
        const heads = headCells.map(h => h.textContent.trim().toLowerCase());
        if (heads.length === 0) return;
        const facetIdx = {};
        heads.forEach((h, i) => {
          if (facetNames.indexOf(h) > -1) facetIdx[h] = i;
        });
        if (!t.dataset.sfDecorated) {
          t.dataset.sfDecorated = '1';
          headCells.forEach((h, i) => {
            const text = i === 0 ? help[heads[0]] || FIRST_COL_HELP : help[heads[i]];
            if (text) h.title = text;
          });
        }
        const rows = [...t.querySelectorAll('tbody tr')].map((r, i) => {
          if (r.dataset.sfIndex === undefined) r.dataset.sfIndex = String(i);
          const cells = r.querySelectorAll('td');
          const fv = {};
          Object.keys(facetIdx).forEach(h => {
            fv[h] = cells[facetIdx[h]] ? cells[facetIdx[h]].textContent.trim() : '';
          });
          return {
            el: r,
            text: [...cells].map(c => c.textContent).join(' ').toLowerCase(),
            facets: fv,
            anchors: [...r.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1)),
            ids: [...r.querySelectorAll('[id]')].map(n => n.id)
          };
        });
        tables.push({
          el: t,
          box: t.closest('[data-table-wrapper]') || t,
          rows,
          heads
        });
      });
      el = el.nextElementSibling;
    }
    tablesRef.current = tables;
    if (sortRef.current) sortTables(sortRef.current);
    return tables;
  };
  const apply = query => {
    let tables = tablesRef.current || scan();
    if (tables.some(t => !t.el.isConnected)) tables = scan();
    const needle = query.trim().toLowerCase();
    const sel = selRef.current;
    const activeFacets = Object.keys(sel).filter(h => sel[h] && sel[h] !== 'All');
    const show = (el, on) => {
      const want = on ? '' : 'none';
      if (el.style.display !== want) el.style.display = want;
    };
    let total = 0;
    let shown = 0;
    const visibleTargets = new Set();
    tables.forEach(t => {
      let tableVisible = 0;
      t.rows.forEach(row => {
        total += 1;
        const catOk = activeFacets.every(h => {
          const v = row.facets[h];
          return v === sel[h] || v === '' || v === undefined;
        });
        const match = catOk && (needle === '' || row.text.includes(needle));
        show(row.el, match);
        if (match) {
          tableVisible += 1;
          row.anchors.forEach(a => visibleTargets.add(a));
        }
      });
      show(t.box, !(t.rows.length > 0 && tableVisible === 0));
      shown += tableVisible;
    });
    if (shown < total && visibleTargets.size > 0) {
      tables.forEach(t => {
        t.rows.forEach(row => {
          if (row.el.style.display === 'none' && row.ids.some(id => visibleTargets.has(id))) {
            show(row.el, true);
            show(t.box, true);
            shown += 1;
          }
        });
      });
    }
    setCounts({
      shown,
      total
    });
    return total;
  };
  const deriveFacets = tables => {
    const seen = {};
    tables.forEach(t => t.rows.forEach(r => {
      Object.keys(r.facets).forEach(h => {
        if (!seen[h]) seen[h] = [];
        if (r.facets[h] && seen[h].indexOf(r.facets[h]) === -1) seen[h].push(r.facets[h]);
      });
    }));
    const list = facetNames.filter(h => seen[h] && seen[h].length > 0).map(h => ({
      name: h,
      label: cap(h),
      values: seen[h].sort(cmpValues(h))
    }));
    setFacetList(list);
    const first = tables[0] ? tables[0].heads[0] : '';
    setFirstHead(first);
    if (!sortRef.current && first) {
      setSortBy(first);
      sortTables(first);
    }
    const init = {};
    list.forEach(f => {
      init[f.name] = selRef.current[f.name] || 'All';
    });
    setSel(init);
  };
  const onChange = value => {
    setQ(value);
    apply(value);
  };
  const clearAll = () => {
    const next = {};
    Object.keys(selRef.current).forEach(k => {
      next[k] = 'All';
    });
    setSel(next);
    setQ('');
    apply('');
    if (searchRef.current) searchRef.current.focus();
  };
  useEffect(() => {
    const tables = scan();
    deriveFacets(tables);
    const total = apply('');
    let retryTimer;
    if (total === 0) {
      retryTimer = setTimeout(() => {
        tablesRef.current = null;
        if (apply(qRef.current) > 0) deriveFacets(tablesRef.current); else setDisabled(true);
      }, 500);
    }
    const onKey = e => {
      if (e.key === 'Escape' && menuOpenRef.current !== null) closeMenu(menuOpenRef.current);
      if (!searchRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const tag = active && active.tagName;
      const editable = active && active.isContentEditable;
      const interactive = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || editable || active && active.getAttribute && active.getAttribute('role');
      if (e.key === '/' && !interactive) {
        const r = rootRef.current ? rootRef.current.getBoundingClientRect() : null;
        if (r && r.bottom > 0 && r.top < (window.innerHeight || 0)) {
          e.preventDefault();
          setMenu(null);
          searchRef.current.focus();
        }
      }
      if (e.key === 'Escape' && menuOpenRef.current === null && active === searchRef.current) {
        onChange('');
        searchRef.current.blur();
      }
    };
    const onDocClick = e => {
      const open = menuOpenRef.current;
      if (open !== null && menuRef.current[open] && !menuRef.current[open].contains(e.target)) setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
      (tablesRef.current || []).forEach(t => {
        t.box.style.display = '';
        t.rows.forEach(row => {
          row.el.style.display = '';
        });
      });
    };
  }, []);
  useEffect(() => {
    if (menuOpen !== null) focusSelected(menuOpen);
  }, [menuOpen]);
  if (disabled) return null;
  const facetActive = Object.keys(sel).some(h => sel[h] && sel[h] !== 'All');
  const sortOptions = [firstHead].concat(facetList.map(f => f.name)).filter((h, i, a) => h && a.indexOf(h) === i);
  return <>
      <style>{`
        .sf-root {
          --sf-accent: #D97757;
          --sf-bg: #fff;
          --sf-border: #E8E6DC;
          --sf-text: #141413;
          --sf-text-3: #73726C;
          --sf-text-4: #9C9A92;
        }
        .dark .sf-root {
          --sf-bg: #1a1918;
          --sf-border: #3a3936;
          --sf-text: #e8e6dc;
          --sf-text-3: #9c9a92;
          --sf-text-4: #73726c;
        }
        .sf-root .sf-end {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
        }
        .sf-root .sf-x {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--sf-text-3);
          font-size: 14px;
          padding: 2px 4px;
          line-height: 1;
        }
      `}</style>
      <div ref={rootRef} className="sf-root" style={{
    margin: '16px 0 8px'
  }}>
        <div style={{
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    alignItems: 'center'
  }}>
        <div style={{
    position: 'relative',
    flex: '1 1 260px',
    maxWidth: '480px'
  }}>
          <input ref={searchRef} value={q} onChange={e => onChange(e.target.value)} placeholder={placeholderText} aria-label={placeholderText} style={{
    width: '100%',
    padding: '8px 56px 8px 12px',
    borderRadius: '8px',
    border: '1px solid var(--sf-border)',
    background: 'var(--sf-bg)',
    color: 'var(--sf-text)',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box'
  }} />
          {q ? <button type="button" onClick={() => {
    onChange('');
    if (searchRef.current) searchRef.current.focus();
  }} aria-label="Clear text" className="sf-end sf-x">
              ×
            </button> : <span className="sf-end" style={{
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '11px',
    color: 'var(--sf-text-4)',
    border: '1px solid var(--sf-border)',
    borderRadius: '3px',
    padding: '0 5px',
    pointerEvents: 'none'
  }}>
              /
            </span>}
        </div>
        {facetList.map(f => {
    const cur = sel[f.name] || 'All';
    const isOpen = menuOpen === f.name;
    return <div key={f.name} ref={el => {
      menuRef.current[f.name] = el;
    }} style={{
      position: 'relative'
    }}>
            <button type="button" onClick={() => setMenu(isOpen ? null : f.name)} onKeyDown={e => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) setMenu(f.name); else focusSelected(f.name);
      }
    }} aria-haspopup="listbox" aria-expanded={isOpen} style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: cur !== 'All' ? '8px 30px 8px 12px' : '8px 12px',
      borderRadius: '8px',
      border: '1px solid ' + (cur !== 'All' ? 'var(--sf-accent)' : 'var(--sf-border)'),
      background: 'var(--sf-bg)',
      color: cur === 'All' ? 'var(--sf-text-3)' : 'var(--sf-text)',
      fontSize: '13.5px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      maxWidth: '260px'
    }}>
              <span style={{
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }}>
                {f.label + ': ' + optionLabel(f, cur)}
              </span>
              <span aria-hidden="true" style={{
      fontSize: '9px',
      color: 'var(--sf-text-4)',
      transform: isOpen ? 'rotate(180deg)' : 'none',
      transition: 'transform 120ms'
    }}>
                ▼
              </span>
            </button>
            {cur !== 'All' && <button type="button" onClick={() => setFacet(f.name, 'All')} aria-label={'Clear ' + f.label + ' filter'} title={'Clear ' + f.label + ' filter'} className="sf-end sf-x">
                ×
              </button>}
            {isOpen && <div role="listbox" aria-label={f.label} onKeyDown={e => {
      const items = [...e.currentTarget.querySelectorAll('button')];
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (items[idx + 1] || items[0]).focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (items[idx - 1] || items[items.length - 1]).focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (items[0]) items[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        if (items[items.length - 1]) items[items.length - 1].focus();
      } else if (e.key === 'Tab') {
        closeMenu(f.name);
      }
    }} style={{
      position: 'absolute',
      top: 'calc(100% + 6px)',
      left: 0,
      zIndex: 1000,
      minWidth: '260px',
      maxHeight: '340px',
      overflowY: 'auto',
      background: 'var(--sf-bg)',
      border: '1px solid var(--sf-border)',
      borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      padding: '5px'
    }}>
                {['All'].concat(f.values).map(c => {
      const selected = cur === c;
      return <button key={c} role="option" aria-selected={selected} tabIndex={-1} onClick={() => setFacet(f.name, c)} style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: selected ? 'var(--sf-accent)' : 'var(--sf-text)',
        fontWeight: selected ? 600 : 400,
        fontSize: '13.5px',
        cursor: 'pointer'
      }}>
                      <span aria-hidden="true" style={{
        width: '14px',
        color: 'var(--sf-accent)',
        flexShrink: 0
      }}>
                        {selected ? '✓' : ''}
                      </span>
                      {optionLabel(f, c)}
                    </button>;
    })}
              </div>}
          </div>;
  })}
        {sortOptions.length > 1 && <div role="group" aria-label="Sort by" style={{
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '13px',
    color: 'var(--sf-text-3)',
    whiteSpace: 'nowrap'
  }}>
            <span style={{
    marginRight: '4px'
  }}>Sort by</span>
            {sortOptions.map(o => {
    const on = sortBy === o;
    return <button key={o} type="button" aria-pressed={on} onClick={() => {
      setSortBy(o);
      sortTables(o);
    }} style={{
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid ' + (on ? 'var(--sf-accent)' : 'var(--sf-border)'),
      background: 'var(--sf-bg)',
      color: on ? 'var(--sf-text)' : 'var(--sf-text-3)',
      fontSize: '13px',
      cursor: 'pointer'
    }}>
                  {o.charAt(0).toUpperCase() + o.slice(1)}
                </button>;
  })}
          </div>}
        </div>
        <div aria-live="polite" style={{
    margin: '8px 0 0',
    fontSize: '13px',
    color: 'var(--sf-text-3)',
    minHeight: '1px'
  }}>
          {q.trim() === '' && !facetActive ? <>{counts.total} {nounText}</> : counts.shown === 0 ? <>
                {q.trim() === '' ? 'No ' + nounText + ' match the selected filters.' : facetActive ? 'No ' + nounText + ' match \u201c' + q + '\u201d with the selected filters.' : 'No ' + nounText + ' match \u201c' + q + '\u201d.'}{' '}
                <button type="button" onClick={clearAll} style={{
    background: 'none',
    border: 'none',
    padding: 0,
    color: 'var(--sf-accent)',
    cursor: 'pointer',
    font: 'inherit',
    textDecoration: 'underline'
  }}>
                  Clear filters
                </button>
                {children ? <> {children}</> : null}
              </> : <>
                Showing {counts.shown} of {counts.total} {nounText}
              </>}
        </div>
      </div>
    </>;
};

<BackToIndex href="#all-settings" label="Back to index" />

This reference page lists each key Claude Code reads from a settings file, plus the [short group of keys](#global-config-settings) it keeps in `~/.claude.json` instead. To pick a file, or check precedence, start with [Claude Code settings](/docs/en/settings).

<span id="available-settings" />

<span id="scopes" />

## All settings

Every key below links to its entry. Scope lists the [files](/docs/en/settings#settings-files-and-who-they-affect) it can go in: `User` is `~/.claude/settings.json`, `Project` is `.claude/settings.json`, `Local` is `.claude/settings.local.json`, and `Managed` is [what your organization deploys](/docs/en/managed-settings). `Any file` means all four, and `Global config` means [`~/.claude.json`](#global-config-settings).

<ReferenceFilter
  noun="settings"
  placeholder="Filter settings by key or purpose"
  facetOrder={{ scope: ["Any file", "User, local, or managed", "User or managed", "Managed", "Global config"] }}
  columnHelp={{
topic: "The section of this page that holds the entry. Use Sort by to group the table by topic.",
scope: "Which settings files can set the key: user (~/.claude/settings.json), project (.claude/settings.json), local (.claude/settings.local.json), or managed (deployed by your organization). Global config keys are in ~/.claude.json instead.",
}}
/>

| Key                                                                                             | Description                                                                                                                                                                                                                 | Topic                              | Scope                   |
| :---------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------- | :---------------------- |
| [`advisorModel`](#advisormodel)                                                                 | Pick which model answers when Claude asks the [advisor tool](/docs/en/advisor)                                                                                                                                                   | Model and responses                | Any file                |
| [`agent`](#agent)                                                                               | Start every session as a named [subagent](/docs/en/sub-agents) with its prompt, tools, and model                                                                                                                                 | Agents, sessions, and worktrees    | Any file                |
| [`agentPushNotifEnabled`](#agentpushnotifenabled)                                               | Let Claude send a [push notification to your phone](/docs/en/remote-control#mobile-push-notifications) when it decides to                                                                                                        | Remote, desktop, and notifications | Any file                |
| [`allowAllClaudeAiMcps`](#allowallclaudeaimcps)                                                 | Load the [claude.ai connectors](/docs/en/mcp) Claude Code fetches itself alongside a deployed [`managed-mcp.json`](/docs/en/managed-mcp#exclusive-control-with-managed-mcp-json)                                                      | MCP                                | Managed                 |
| [`allowedChannelPlugins`](#allowedchannelplugins)                                               | Replace the default allowlist of [channel plugins](/docs/en/channels#restrict-which-channel-plugins-can-run) that can push messages                                                                                              | Plugins and skills                 | Managed                 |
| [`allowedHttpHookUrls`](#allowedhttphookurls)                                                   | Limit which URLs [HTTP hooks](/docs/en/hooks) can target                                                                                                                                                                         | Hooks and automation               | Any file                |
| [`allowedMcpServers`](#allowedmcpservers)                                                       | Allowlist which [MCP servers](/docs/en/mcp) people can use                                                                                                                                                                       | MCP                                | Any file                |
| [`allowManagedHooksOnly`](#allowmanagedhooksonly)                                               | Run only the [hooks](/docs/en/hooks) your organization deploys                                                                                                                                                                   | Hooks and automation               | Managed                 |
| [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly)                                     | Make the managed [MCP](/docs/en/mcp) allowlist the only one that applies                                                                                                                                                         | MCP                                | Managed                 |
| [`allowManagedPermissionRulesOnly`](#allowmanagedpermissionrulesonly)                           | Make [managed settings](/docs/en/managed-settings) the only source of [permission rules](/docs/en/permissions#managed-settings)                                                                                                       | Permission settings                | Managed                 |
| [`alwaysThinkingEnabled`](#alwaysthinkingenabled)                                               | Turn [extended thinking](/docs/en/model-config#extended-thinking) off for every session                                                                                                                                          | Model and responses                | Any file                |
| [`apiKeyHelper`](#apikeyhelper)                                                                 | Generate the [API credential](/docs/en/authentication#credential-management) with your own command                                                                                                                               | Authentication and providers       | Any file                |
| [`askUserQuestionTimeout`](#askuserquestiontimeout)                                             | Let an unanswered question [auto-continue](/docs/en/tools-reference#question-auto-continue-timeout) after idle time                                                                                                              | Interface and terminal             | User or managed         |
| [`attribution`](#attribution)                                                                   | Customize the attribution Claude Code adds to commits and pull requests                                                                                                                                                     | Git and attribution                | Any file                |
| [`attribution.commit`](#attribution-commit)                                                     | Change or hide the trailer Claude Code adds to commits                                                                                                                                                                      | Git and attribution                | Any file                |
| [`attribution.pr`](#attribution-pr)                                                             | Change or hide the attribution line in pull request descriptions                                                                                                                                                            | Git and attribution                | Any file                |
| [`attribution.sessionUrl`](#attribution-sessionurl)                                             | Omit the claude.ai session link from [cloud](/docs/en/claude-code-on-the-web) and [Remote Control](/docs/en/remote-control) commits                                                                                                   | Git and attribution                | Any file                |
| [`autoCompactEnabled`](#autocompactenabled)                                                     | Turn [automatic compaction](/docs/en/context-window) off or on                                                                                                                                                                   | Memory and context                 | Any file                |
| [`autoCompactWindow`](#autocompactwindow)                                                       | Set how full the context gets before Claude Code [compacts](/docs/en/context-window)                                                                                                                                             | Memory and context                 | Any file                |
| [`autoConnectIde`](#autoconnectide)                                                             | Connect to a running [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#from-external-terminals) IDE automatically from an external terminal                                                                               | Global config settings             | Global config           |
| [`autoContinueAtUsageLimit`](#autocontinueatusagelimit)                                         | Wait in the open session and [continue the task automatically](/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset) after a claude.ai usage limit resets                                                                   | Interface and terminal             | User or managed         |
| [`autoInstallIdeExtension`](#autoinstallideextension)                                           | Turn off automatic install of the [IDE extension](/docs/en/vs-code#install-the-extension) from a VS Code terminal                                                                                                                | Global config settings             | Global config           |
| [`autoMemoryDirectory`](#automemorydirectory)                                                   | Store [auto memory](/docs/en/memory#auto-memory) in a directory you choose                                                                                                                                                       | Memory and context                 | Any file                |
| [`autoMemoryEnabled`](#automemoryenabled)                                                       | Turn [auto memory](/docs/en/memory#auto-memory) off or on                                                                                                                                                                        | Memory and context                 | Any file                |
| [`autoMode`](#automode)                                                                         | Add your own allow and deny rules to the [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) classifier                                                                                                      | Permission settings                | User or managed         |
| [`autoMode.classifyAllShell`](#automode-classifyallshell)                                       | Send every shell command through the [auto mode classifier](/docs/en/permission-modes#what-the-classifier-blocks-by-default), even ones a narrow allow rule matches                                                              | Permission settings                | User or managed         |
| [`autoScrollEnabled`](#autoscrollenabled)                                                       | [Follow new output](/docs/en/fullscreen#auto-follow) to the bottom in fullscreen rendering                                                                                                                                       | Interface and terminal             | Any file                |
| [`autoUpdatesChannel`](#autoupdateschannel)                                                     | Follow the stable [release channel](/docs/en/setup#configure-release-channel) instead of latest                                                                                                                                  | Updates and versioning             | Any file                |
| [`availableModels`](#availablemodels)                                                           | [Restrict which models](/docs/en/model-config#restrict-model-selection) people can pick                                                                                                                                          | Model and responses                | Any file                |
| [`awaySummaryEnabled`](#awaysummaryenabled)                                                     | Turn off the [session recap](/docs/en/interactive-mode#session-recap) shown when you come back to the terminal                                                                                                                   | Remote, desktop, and notifications | Any file                |
| [`awsAuthRefresh`](#awsauthrefresh)                                                             | Refresh expired [Bedrock credentials](/docs/en/amazon-bedrock#advanced-credential-configuration) in `.aws` with your own command                                                                                                 | Authentication and providers       | Any file                |
| [`awsCredentialExport`](#awscredentialexport)                                                   | Supply [Bedrock credentials](/docs/en/amazon-bedrock#advanced-credential-configuration) as JSON from your own command                                                                                                            | Authentication and providers       | Any file                |
| [`axScreenReader`](#axscreenreader)                                                             | Render [screen-reader friendly output](/docs/en/accessibility)                                                                                                                                                                   | Interface and terminal             | Any file                |
| [`blockedMarketplaces`](#blockedmarketplaces)                                                   | Block [plugin marketplace](/docs/en/plugin-marketplaces) sources for your organization                                                                                                                                           | Plugins and skills                 | Managed                 |
| [`browserExternalPageTools`](#browserexternalpagetools)                                         | Keep Claude's tools off external pages in the [desktop](/docs/en/desktop) Browser pane                                                                                                                                           | Tools                              | Managed                 |
| [`channelsEnabled`](#channelsenabled)                                                           | Allow [channels](/docs/en/channels#enable-channels-for-your-organization) for your organization                                                                                                                                  | Plugins and skills                 | Managed                 |
| [`claudeMd`](#claudemd)                                                                         | Inject organization-wide [CLAUDE.md](/docs/en/memory#deploy-organization-wide-claude-md) instructions from managed settings                                                                                                      | Memory and context                 | Managed                 |
| [`claudeMdExcludes`](#claudemdexcludes)                                                         | Skip specific [CLAUDE.md](/docs/en/memory#exclude-specific-claude-md-files) files when memory loads                                                                                                                              | Memory and context                 | Any file                |
| [`cleanupPeriodDays`](#cleanupperioddays)                                                       | Choose how many days Claude Code keeps [transcripts](/docs/en/data-usage#data-retention) before deleting them                                                                                                                    | Privacy and telemetry              | Any file                |
| [`companyAnnouncements`](#companyannouncements)                                                 | Show your organization's announcements at startup                                                                                                                                                                           | Interface and terminal             | Any file                |
| [`crossSessionInbound`](#crosssessioninbound)                                                   | Choose whether Claude Code delivers [messages from your other sessions](/docs/en/cross-session-messaging#control-inbound-messages), shows a notice without delivering them, or refuses them                                      | Agents, sessions, and worktrees    | Any file                |
| [`defaultShell`](#defaultshell)                                                                 | Choose whether Bash or PowerShell runs the shell commands you type with the [`!` prefix](/docs/en/interactive-mode#shell-mode-with-prefix)                                                                                       | Interface and terminal             | Any file                |
| [`deniedMcpServers`](#deniedmcpservers)                                                         | Block specific [MCP servers](/docs/en/mcp) by URL, command, or name                                                                                                                                                              | MCP                                | Any file                |
| [`desktopSessionCleanupPeriodDays`](#desktopsessioncleanupperioddays)                           | Set an age limit in days for [Claude Desktop and Cowork transcripts](/docs/en/claude-directory#cleaned-up-automatically)                                                                                                         | Privacy and telemetry              | User or managed         |
| [`dialogExpiry`](#dialogexpiry)                                                                 | Set how long Claude Code waits for [Remote Control](/docs/en/remote-control) or an SDK host to answer a forwarded dialog before it cancels the dialog                                                                            | Interface and terminal             | User or managed         |
| [`diffTool`](#difftool)                                                                         | Choose whether Claude's proposed file changes open in the [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#features) diff viewer or stay in the terminal                                                                 | Global config settings             | Global config           |
| [`disableAgentView`](#disableagentview)                                                         | Turn off background agents and [agent view](/docs/en/agent-view)                                                                                                                                                                 | Agents, sessions, and worktrees    | Any file                |
| [`disableAllHooks`](#disableallhooks)                                                           | Turn off [hooks](/docs/en/hooks), a custom [status line](/docs/en/statusline), and a custom [`@` file suggestion](/docs/en/interactive-mode#quick-commands) command at once                                                                | Hooks and automation               | Any file                |
| [`disableArtifact`](#disableartifact)                                                           | Deprecated; use `enableArtifact` to turn the [Artifact tool](/docs/en/artifacts) off                                                                                                                                             | Remote, desktop, and notifications | Any file                |
| [`disableAutoMode`](#disableautomode)                                                           | Remove [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) from the permission mode cycle                                                                                                                    | Permission settings                | Any file                |
| [`disableBrowserExternalNavigation`](#disablebrowserexternalnavigation)                         | Limit the [desktop](/docs/en/desktop) Browser pane to localhost for people and Claude                                                                                                                                            | Tools                              | Managed                 |
| [`disableBundledSkills`](#disablebundledskills)                                                 | Turn off the [skills](/docs/en/skills#bundled-skills) and [workflows](/docs/en/workflows) included with Claude Code                                                                                                                   | Plugins and skills                 | Any file                |
| [`disableClaudeAiConnectors`](#disableclaudeaiconnectors)                                       | Turn off [claude.ai connectors](/docs/en/mcp#disable-claude-ai-connectors) so Claude Code doesn't fetch them                                                                                                                     | MCP                                | Any file                |
| [`disableCommandPluginSources`](#disablecommandpluginsources)                                   | Block [plugins](/docs/en/plugins) that install by running a marketplace-declared command                                                                                                                                         | Plugins and skills                 | Managed                 |
| [`disableDeepLinkRegistration`](#disabledeeplinkregistration)                                   | Stop Claude Code from registering the [`claude-cli://` handler](/docs/en/deep-links)                                                                                                                                             | Remote, desktop, and notifications | Any file                |
| [`disableDesktopLocalSessions`](#disabledesktoplocalsessions)                                   | Turn off [Desktop Code sessions](/docs/en/desktop#local-sessions-on-managed-devices) that run on the device, leaving SSH to other hosts and cloud                                                                                | Remote, desktop, and notifications | Managed                 |
| [`disabledMcpjsonServers`](#disabledmcpjsonservers)                                             | Reject specific servers from a project's [`.mcp.json`](/docs/en/mcp#project-scope)                                                                                                                                               | MCP                                | Any file                |
| [`disableMobileSimulatorTools`](#disablemobilesimulatortools)                                   | Block Claude's tools in the [desktop](/docs/en/desktop) iOS Simulator pane                                                                                                                                                       | Tools                              | Managed                 |
| [`disableRemoteControl`](#disableremotecontrol)                                                 | Turn off [Remote Control](/docs/en/remote-control) everywhere it can start                                                                                                                                                       | Remote, desktop, and notifications | Any file                |
| [`disableSideloadFlags`](#disablesideloadflags)                                                 | Reject the CLI flags that sideload [plugins](/docs/en/plugins), [subagents](/docs/en/sub-agents), and [MCP servers](/docs/en/mcp)                                                                                                          | Enterprise and managed settings    | Managed                 |
| [`disableSkillShellExecution`](#disableskillshellexecution)                                     | Stop [skills](/docs/en/skills) and custom commands from running inline shell                                                                                                                                                     | Plugins and skills                 | Any file                |
| [`disableWorkflows`](#disableworkflows)                                                         | Turn [dynamic workflows](/docs/en/workflows) off for everyone; use `enableWorkflows` for yourself                                                                                                                                | Hooks and automation               | Any file                |
| [`editorMode`](#editormode)                                                                     | Use [vim key bindings](/docs/en/interactive-mode#vim-editor-mode) in the input prompt                                                                                                                                            | Interface and terminal             | Any file                |
| [`effortLevel`](#effortlevel)                                                                   | Save the [`/effort` level](/docs/en/model-config#adjust-effort-level) so future sessions reason more or less deeply                                                                                                              | Model and responses                | Any file                |
| [`emojiCompletionEnabled`](#emojicompletionenabled)                                             | Turn off [`:shortcode:` emoji suggestions and replacement](/docs/en/interactive-mode#emoji-shortcodes) in the prompt input                                                                                                       | Interface and terminal             | Any file                |
| [`enableAllProjectMcpServers`](#enableallprojectmcpservers)                                     | Approve every server in project [`.mcp.json`](/docs/en/mcp#project-server-approvals-and-workspace-trust) files without a prompt                                                                                                  | MCP                                | Any file                |
| [`enableArtifact`](#enableartifact)                                                             | Turn the [Artifact tool](/docs/en/artifacts) off with a `false` in any file; no file can turn it back on                                                                                                                         | Remote, desktop, and notifications | Any file                |
| [`enabledMcpjsonServers`](#enabledmcpjsonservers)                                               | Approve specific servers from a project's [`.mcp.json`](/docs/en/mcp#project-server-approvals-and-workspace-trust)                                                                                                               | MCP                                | Any file                |
| [`enabledPlugins`](#enabledplugins)                                                             | Turn individual [plugins](/docs/en/plugins) on or off per scope                                                                                                                                                                  | Plugins and skills                 | Any file                |
| [`enableWorkflows`](#enableworkflows)                                                           | Turn [dynamic workflows](/docs/en/workflows) on or off against your plan's default                                                                                                                                               | Hooks and automation               | Any file                |
| [`enforceAvailableModels`](#enforceavailablemodels)                                             | Keep the [`/model` Default choice](/docs/en/model-config#enforce-the-allowlist-for-the-default-model) inside your `availableModels` allowlist                                                                                    | Model and responses                | Any file                |
| [`env`](#env)                                                                                   | Set [environment variables](/docs/en/env-vars#in-settings-files) for every session and its subprocesses                                                                                                                          | Memory and context                 | Any file                |
| [`externalEditorContext`](#externaleditorcontext)                                               | Show Claude's last response as comments when you press [Ctrl+G](/docs/en/interactive-mode#general-controls) to edit                                                                                                              | Global config settings             | Global config           |
| [`extraKnownMarketplaces`](#extraknownmarketplaces)                                             | Register [marketplaces](/docs/en/plugin-marketplaces) for a repository or an organization                                                                                                                                        | Plugins and skills                 | Any file                |
| [`fallbackModel`](#fallbackmodel)                                                               | Name [backup models](/docs/en/model-config#fallback-model-chains) for when the primary is overloaded                                                                                                                             | Model and responses                | Any file                |
| [`fastMode`](#fastmode)                                                                         | Turn [fast mode](/docs/en/fast-mode) on for sessions where it's available                                                                                                                                                        | Model and responses                | Any file                |
| [`fastModePerSessionOptIn`](#fastmodepersessionoptin)                                           | Require people to turn [fast mode](/docs/en/fast-mode) on each session                                                                                                                                                           | Model and responses                | Any file                |
| [`feedbackDrafts`](#feedbackdrafts)                                                             | Control whether Claude queues [feedback drafts](/docs/en/tools-reference#sendfeedback-tool-behavior) for you to review                                                                                                           | Privacy and telemetry              | User or managed         |
| [`feedbackSurveyRate`](#feedbacksurveyrate)                                                     | Change how often the [session quality survey](/docs/en/data-usage#session-quality-surveys) appears                                                                                                                               | Privacy and telemetry              | Any file                |
| [`fileCheckpointingEnabled`](#filecheckpointingenabled)                                         | Turn off or on the file snapshots that [`/rewind`](/docs/en/checkpointing) restores                                                                                                                                              | Memory and context                 | Any file                |
| [`fileSuggestion`](#filesuggestion)                                                             | Supply [`@` file autocomplete](/docs/en/interactive-mode#quick-commands) from your own command                                                                                                                                   | Interface and terminal             | Any file                |
| [`footerLinksRegexes`](#footerlinksregexes)                                                     | Make issue or review IDs in output into [clickable links](/docs/en/statusline#clickable-links) below the input box                                                                                                               | Interface and terminal             | User or managed         |
| [`forceLoginGatewayUrl`](#forcelogingatewayurl)                                                 | Set the [gateway URL](/docs/en/claude-apps-gateway#set-the-gateway-url) the login screen connects to                                                                                                                             | Authentication and providers       | Managed                 |
| [`forceLoginMethod`](#forceloginmethod)                                                         | [Restrict login](/docs/en/authentication#restrict-login-to-your-organization) to claude.ai, Claude Console, or a [cloud gateway](/docs/en/claude-apps-gateway)                                                                        | Authentication and providers       | Any file                |
| [`forceLoginOrgUUID`](#forceloginorguuid)                                                       | [Pin claude.ai logins to your organization](/docs/en/authentication#restrict-login-to-your-organization); only a managed source enforces it                                                                                      | Authentication and providers       | Any file                |
| [`forceRemoteSettingsRefresh`](#forceremotesettingsrefresh)                                     | Block startup until [server-managed settings](/docs/en/server-managed-settings) are freshly fetched                                                                                                                              | Enterprise and managed settings    | Managed                 |
| [`gcpAuthRefresh`](#gcpauthrefresh)                                                             | Refresh [Google Cloud credentials](/docs/en/google-vertex-ai#advanced-credential-configuration) with your own command                                                                                                            | Authentication and providers       | Any file                |
| [`hooks`](#hooks)                                                                               | Run your own commands as [hooks](/docs/en/hooks) at points in Claude Code's lifecycle                                                                                                                                            | Hooks and automation               | Any file                |
| [`httpHookAllowedEnvVars`](#httphookallowedenvvars)                                             | Limit which env vars [HTTP hooks](/docs/en/hooks) can put in headers                                                                                                                                                             | Hooks and automation               | Any file                |
| [`includeCoAuthoredBy`](#includecoauthoredby)                                                   | Deprecated; use `attribution` to hide or change commit and PR attribution                                                                                                                                                   | Git and attribution                | Any file                |
| [`includeGitInstructions`](#includegitinstructions)                                             | Remove the built-in commit and PR instructions from the [system prompt](/docs/en/sub-agents#what-loads-at-startup)                                                                                                               | Git and attribution                | Any file                |
| [`inputNeededNotifEnabled`](#inputneedednotifenabled)                                           | Get a [push notification](/docs/en/remote-control#mobile-push-notifications) when Claude is waiting on you                                                                                                                       | Remote, desktop, and notifications | Any file                |
| [`isolatePeerMachines`](#isolatepeermachines)                                                   | Ask you before Claude [messages one of your sessions on another machine](/docs/en/cross-session-messaging#require-approval-for-cross-machine-messages)                                                                           | Agents, sessions, and worktrees    | Any file                |
| [`keybindingFlavor`](#keybindingflavor)                                                         | Make `Ctrl+W` [delete back to the previous whitespace](/docs/en/interactive-mode#make-ctrl-w-delete-back-to-whitespace), as Bash does                                                                                            | Interface and terminal             | Any file                |
| [`language`](#language)                                                                         | Have Claude respond in a language other than English                                                                                                                                                                        | Model and responses                | Any file                |
| [`managedSourcesBehavior`](#managedsourcesbehavior)                                             | Compose every [managed source](/docs/en/managed-settings#how-claude-code-combines-managed-sources) you deploy instead of using the highest-priority one alone                                                                    | Enterprise and managed settings    | Managed                 |
| [`minimumVersion`](#minimumversion)                                                             | Keep [auto-updates](/docs/en/setup#pin-a-minimum-version) from installing anything below a version                                                                                                                               | Updates and versioning             | Any file                |
| [`model`](#model)                                                                               | Change the [model](/docs/en/model-config#set-a-default-model-for-new-sessions) Claude Code starts with                                                                                                                           | Model and responses                | Any file                |
| [`modelOverrides`](#modeloverrides)                                                             | [Map model IDs](/docs/en/model-config#override-model-ids-per-version) to your provider's IDs, such as Bedrock ARNs                                                                                                               | Model and responses                | Any file                |
| [`modelPicker`](#modelpicker)                                                                   | Choose which models the [`/model` picker](/docs/en/model-config#available-models) lists, in your own order and with your own labels                                                                                              | Model and responses                | User or managed         |
| [`modelPricing`](#modelpricing)                                                                 | Report spend at your organization's contracted rates instead of list price                                                                                                                                                  | Model and responses                | Managed                 |
| [`otelHeadersHelper`](#otelheadershelper)                                                       | Generate rotating [OpenTelemetry](/docs/en/monitoring-usage#dynamic-headers) headers with your own command                                                                                                                       | Authentication and providers       | Any file                |
| [`outputStyle`](#outputstyle)                                                                   | Change Claude's role, tone, and output format with an [output style](/docs/en/output-styles)                                                                                                                                     | Model and responses                | Any file                |
| [`parentSettingsBehavior`](#parentsettingsbehavior)                                             | Apply or drop restrictions an [SDK or IDE host](/docs/en/managed-settings#let-an-embedding-host-add-policy) passes when you deploy [managed settings](/docs/en/managed-settings)                                                      | Enterprise and managed settings    | Managed                 |
| [`permissionExplainerEnabled`](#permissionexplainerenabled)                                     | Turn off the Ctrl+E command explanation on shell [permission prompts](/docs/en/permissions#permission-system)                                                                                                                    | Global config settings             | Global config           |
| [`permissions`](#permissions)                                                                   | Set allow, ask, and deny rules and the starting [permission mode](/docs/en/permission-modes)                                                                                                                                     | Permission settings                | Any file                |
| [`permissions.additionalDirectories`](#permissions-additionaldirectories)                       | Give Claude file access to [directories outside the current one](/docs/en/permissions#working-directories)                                                                                                                       | Permission settings                | Any file                |
| [`permissions.allow`](#permissions-allow)                                                       | Approve listed [tool uses](/docs/en/permissions#permission-rule-syntax) without a prompt                                                                                                                                         | Permission settings                | Any file                |
| [`permissions.ask`](#permissions-ask)                                                           | Always prompt before listed [tool uses](/docs/en/permissions#permission-rule-syntax)                                                                                                                                             | Permission settings                | Any file                |
| [`permissions.defaultMode`](#permissions-defaultmode)                                           | Set the [permission mode](/docs/en/permission-modes#which-mode-a-session-starts-in) new sessions start in                                                                                                                        | Permission settings                | Any file                |
| [`permissions.deny`](#permissions-deny)                                                         | Block listed [tool uses](/docs/en/permissions#permission-rule-syntax), including reads of files that hold secrets                                                                                                                | Permission settings                | Any file                |
| [`permissions.disableBypassPermissionsMode`](#permissions-disablebypasspermissionsmode)         | Prevent anyone from entering [bypassPermissions mode](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode)                                                                                                     | Permission settings                | Any file                |
| [`plansDirectory`](#plansdirectory)                                                             | Choose where [plan mode](/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode) writes plan files                                                                                                                     | Memory and context                 | Any file                |
| [`pluginConfigs`](#pluginconfigs)                                                               | Store the answers you gave a [plugin](/docs/en/plugins)'s configuration dialog                                                                                                                                                   | Plugins and skills                 | User or managed         |
| [`pluginSuggestionMarketplaces`](#pluginsuggestionmarketplaces)                                 | Choose which [marketplaces](/docs/en/plugin-marketplaces#managed-marketplace-restrictions) can surface plugin install suggestions in `/plugin`                                                                                   | Plugins and skills                 | Managed                 |
| [`pluginTrustMessage`](#plugintrustmessage)                                                     | Add your own text to the [plugin](/docs/en/plugins) trust warning                                                                                                                                                                | Plugins and skills                 | Managed                 |
| [`policyHelper`](#policyhelper)                                                                 | Run an executable that computes [managed settings](/docs/en/managed-settings#compute-the-policy-with-a-helper-program) at startup                                                                                                | Enterprise and managed settings    | Managed                 |
| [`policyHelper.path`](#policyhelper-path)                                                       | Name the [helper executable](/docs/en/managed-settings#compute-the-policy-with-a-helper-program) Claude Code runs                                                                                                                | Enterprise and managed settings    | Managed                 |
| [`policyHelper.refreshIntervalMs`](#policyhelper-refreshintervalms)                             | Re-run the [helper](/docs/en/managed-settings#compute-the-policy-with-a-helper-program) in the background on an interval                                                                                                         | Enterprise and managed settings    | Managed                 |
| [`policyHelper.timeoutMs`](#policyhelper-timeoutms)                                             | Set how long Claude Code waits for the [helper](/docs/en/managed-settings#compute-the-policy-with-a-helper-program)                                                                                                              | Enterprise and managed settings    | Managed                 |
| [`preferredNotifChannel`](#preferrednotifchannel)                                               | Choose a [terminal bell or desktop notification](/docs/en/terminal-config#get-a-terminal-bell-or-notification) for task completion                                                                                               | Remote, desktop, and notifications | Any file                |
| [`prefersReducedMotion`](#prefersreducedmotion)                                                 | [Reduce or turn off](/docs/en/accessibility#accessibility-settings) spinner, shimmer, and flash animations                                                                                                                       | Interface and terminal             | Any file                |
| [`processWrapper`](#processwrapper)                                                             | Run Claude Code's background processes through a [corporate launcher](/docs/en/corporate-launcher) on macOS and Linux                                                                                                            | Agents, sessions, and worktrees    | User or managed         |
| [`promptCacheTtl`](#promptcachettl)                                                             | Choose the [prompt cache lifetime](/docs/en/prompt-caching#cache-lifetime) for the main conversation                                                                                                                             | Model and responses                | Any file                |
| [`promptSuggestionEnabled`](#promptsuggestionenabled)                                           | Hide the grayed-out [prompt suggestions](/docs/en/interactive-mode#prompt-suggestions) in the input box                                                                                                                          | Interface and terminal             | Any file                |
| [`prUrlTemplate`](#prurltemplate)                                                               | Point PR links at an internal code-review tool instead of github.com                                                                                                                                                        | Git and attribution                | Any file                |
| [`remote.defaultEnvironmentId`](#remote-defaultenvironmentid)                                   | Pick the default [cloud environment](/docs/en/cloud-environments) for `claude --cloud`; a self-hosted `ccpool_` ID is read only from user and managed settings and `--settings`                                                  | Remote, desktop, and notifications | Any file                |
| [`remoteControlAtStartup`](#remotecontrolatstartup)                                             | Connect [Remote Control](/docs/en/remote-control#enable-remote-control-for-all-sessions) automatically when a session starts                                                                                                     | Remote, desktop, and notifications | Any file                |
| [`requiredMaximumVersion`](#requiredmaximumversion)                                             | [Refuse to start](/docs/en/setup#pin-a-minimum-version) on a version newer than your organization allows                                                                                                                         | Updates and versioning             | Managed                 |
| [`requiredMinimumVersion`](#requiredminimumversion)                                             | [Refuse to start](/docs/en/setup#pin-a-minimum-version) on a version older than your organization requires                                                                                                                       | Updates and versioning             | Managed                 |
| [`respectGitignore`](#respectgitignore)                                                         | Keep gitignored files out of the [`@` file picker](/docs/en/interactive-mode#quick-commands)                                                                                                                                     | Interface and terminal             | Any file                |
| [`respondToBashCommands`](#respondtobashcommands)                                               | Stop Claude from responding after a [`!` shell command](/docs/en/interactive-mode#shell-mode-with-prefix) runs                                                                                                                   | Interface and terminal             | Any file                |
| [`sandbox`](#sandbox)                                                                           | [Isolate Bash commands](/docs/en/sandboxing) from your filesystem and network on macOS, Linux, and WSL2                                                                                                                          | Sandbox settings                   | Any file                |
| [`sandbox.allowAppleEvents`](#sandbox-allowappleevents)                                         | Let [sandboxed](/docs/en/sandboxing) commands send Apple Events on macOS                                                                                                                                                         | Sandbox settings                   | User or managed         |
| [`sandbox.allowUnsandboxedCommands`](#sandbox-allowunsandboxedcommands)                         | Let Claude retry a blocked command outside the [sandbox](/docs/en/sandboxing#the-unsandboxed-retry-escape-hatch), or forbid it                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.autoAllowBashIfSandboxed`](#sandbox-autoallowbashifsandboxed)                         | Run [sandboxed](/docs/en/sandboxing#auto-allow-mode) commands without a permission prompt                                                                                                                                        | Sandbox settings                   | Any file                |
| [`sandbox.bwrapPath`](#sandbox-bwrappath)                                                       | Point the [sandbox](/docs/en/sandboxing) at a bubblewrap binary outside `PATH`                                                                                                                                                   | Sandbox settings                   | Managed                 |
| [`sandbox.credentials`](#sandbox-credentials)                                                   | Hide or mask credential files and variables inside the [sandbox](/docs/en/sandboxing#protect-credentials)                                                                                                                        | Sandbox settings                   | Any file                |
| [`sandbox.credentials.allowPlaintextInject`](#sandbox-credentials-allowplaintextinject)         | Let [masked credentials](/docs/en/sandboxing#mask-credentials) reach plain HTTP services on trusted test networks                                                                                                                | Sandbox settings                   | User or managed         |
| [`sandbox.credentials.awsPairs`](#sandbox-credentials-awspairs)                                 | Link custom-named AWS key variables into one credential for [re-signing](/docs/en/sandboxing#re-sign-aws-requests)                                                                                                               | Sandbox settings                   | User or managed         |
| [`sandbox.credentials.envVars`](#sandbox-credentials-envvars)                                   | Unset or mask an environment variable inside the [sandbox](/docs/en/sandboxing#mask-environment-variables)                                                                                                                       | Sandbox settings                   | Any file                |
| [`sandbox.credentials.files`](#sandbox-credentials-files)                                       | Block or mask reads of a credential file inside the [sandbox](/docs/en/sandboxing#mask-credential-files)                                                                                                                         | Sandbox settings                   | Any file                |
| [`sandbox.credentials.sigv4`](#sandbox-credentials-sigv4)                                       | Choose whether streaming, presigned, or [SigV4A AWS requests](/docs/en/sandboxing#re-sign-aws-requests) fail or pass through                                                                                                     | Sandbox settings                   | User or managed         |
| [`sandbox.enabled`](#sandbox-enabled)                                                           | Turn on [Bash sandboxing](/docs/en/sandboxing#get-started) on macOS, Linux, and WSL2                                                                                                                                             | Sandbox settings                   | Any file                |
| [`sandbox.enableWeakerNestedSandbox`](#sandbox-enableweakernestedsandbox)                       | Run the Linux [sandbox](/docs/en/sandboxing) inside an unprivileged container                                                                                                                                                    | Sandbox settings                   | Any file                |
| [`sandbox.enableWeakerNetworkIsolation`](#sandbox-enableweakernetworkisolation)                 | Let `gh`, `gcloud`, and `terraform` verify TLS behind a MITM proxy inside the [sandbox](/docs/en/sandboxing#troubleshooting) on macOS                                                                                            | Sandbox settings                   | Any file                |
| [`sandbox.excludedCommands`](#sandbox-excludedcommands)                                         | Name commands that always run outside the [sandbox](/docs/en/sandboxing)                                                                                                                                                         | Sandbox settings                   | Any file                |
| [`sandbox.failIfUnavailable`](#sandbox-failifunavailable)                                       | Refuse to start when the [sandbox](/docs/en/sandboxing) can't, instead of running unsandboxed                                                                                                                                    | Sandbox settings                   | Any file                |
| [`sandbox.filesystem`](#sandbox-filesystem)                                                     | Control which paths [sandboxed](/docs/en/sandboxing#filesystem-isolation) commands can read and write                                                                                                                            | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.allowManagedReadPathsOnly`](#sandbox-filesystem-allowmanagedreadpathsonly) | Stop developers from re-opening [read paths your organization blocked](/docs/en/sandboxing#keep-developers-from-widening-the-policy)                                                                                             | Sandbox settings                   | Managed                 |
| [`sandbox.filesystem.allowRead`](#sandbox-filesystem-allowread)                                 | Re-open reading inside a region [`denyRead`](#sandbox-filesystem-denyread) blocks                                                                                                                                           | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.allowWrite`](#sandbox-filesystem-allowwrite)                               | Add paths [sandboxed](/docs/en/sandboxing) commands can write to                                                                                                                                                                 | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.denyRead`](#sandbox-filesystem-denyread)                                   | Block [sandboxed](/docs/en/sandboxing) commands from reading specific paths                                                                                                                                                      | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.denyWrite`](#sandbox-filesystem-denywrite)                                 | Block [sandboxed](/docs/en/sandboxing) commands from writing to specific paths                                                                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.filesystem.disabled`](#sandbox-filesystem-disabled)                                   | [Turn off filesystem isolation](/docs/en/sandboxing#disable-filesystem-isolation) while keeping network isolation                                                                                                                | Sandbox settings                   | User or managed         |
| [`sandbox.ignoreViolations`](#sandbox-ignoreviolations)                                         | Silence violation reports for paths a command is expected to probe                                                                                                                                                          | Sandbox settings                   | Any file                |
| [`sandbox.network`](#sandbox-network)                                                           | Control which hosts, ports, and sockets [sandboxed](/docs/en/sandboxing#network-isolation) commands reach                                                                                                                        | Sandbox settings                   | Any file                |
| [`sandbox.network.allowAllUnixSockets`](#sandbox-network-allowallunixsockets)                   | Let [sandboxed](/docs/en/sandboxing) commands connect to every Unix socket                                                                                                                                                       | Sandbox settings                   | Any file                |
| [`sandbox.network.allowedDomains`](#sandbox-network-alloweddomains)                             | Pre-allow domains so [sandboxed](/docs/en/sandboxing) commands don't prompt for them                                                                                                                                             | Sandbox settings                   | Any file                |
| [`sandbox.network.allowLocalBinding`](#sandbox-network-allowlocalbinding)                       | Let [sandboxed](/docs/en/sandboxing) commands bind to localhost ports on macOS                                                                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.network.allowMachLookup`](#sandbox-network-allowmachlookup)                           | Let macOS [sandboxed](/docs/en/sandboxing) tools like the iOS Simulator or Playwright reach their XPC services                                                                                                                   | Sandbox settings                   | Any file                |
| [`sandbox.network.allowManagedDomainsOnly`](#sandbox-network-allowmanageddomainsonly)           | Lock the network allowlist to [managed settings](/docs/en/sandboxing#keep-developers-from-widening-the-policy)                                                                                                                   | Sandbox settings                   | Managed                 |
| [`sandbox.network.allowUnixSockets`](#sandbox-network-allowunixsockets)                         | List Unix socket paths [sandboxed](/docs/en/sandboxing) commands can use on macOS                                                                                                                                                | Sandbox settings                   | Any file                |
| [`sandbox.network.deniedDomains`](#sandbox-network-denieddomains)                               | Block domains for [sandboxed](/docs/en/sandboxing) commands, even inside an allowed wildcard                                                                                                                                     | Sandbox settings                   | Any file                |
| [`sandbox.network.httpProxyPort`](#sandbox-network-httpproxyport)                               | Route [sandbox](/docs/en/sandboxing#custom-proxy-configuration) HTTP traffic through your own proxy                                                                                                                              | Sandbox settings                   | Any file                |
| [`sandbox.network.socksProxyPort`](#sandbox-network-socksproxyport)                             | Route [sandbox](/docs/en/sandboxing#custom-proxy-configuration) SOCKS traffic through your own proxy                                                                                                                             | Sandbox settings                   | Any file                |
| [`sandbox.network.strictAllowlist`](#sandbox-network-strictallowlist)                           | Deny hosts outside the [allowlist](/docs/en/sandboxing#network-isolation) instead of prompting                                                                                                                                   | Sandbox settings                   | User or managed         |
| [`sandbox.network.tlsTerminate`](#sandbox-network-tlsterminate)                                 | Have the [sandbox](/docs/en/sandboxing#network-isolation) proxy terminate TLS so it can read HTTPS requests                                                                                                                      | Sandbox settings                   | User or managed         |
| [`sandbox.ripgrep`](#sandbox-ripgrep)                                                           | Use your own ripgrep binary inside the [sandbox](/docs/en/sandboxing)                                                                                                                                                            | Sandbox settings                   | User or managed         |
| [`sandbox.socatPath`](#sandbox-socatpath)                                                       | Point the [sandbox](/docs/en/sandboxing) proxy at a `socat` binary outside `PATH`                                                                                                                                                | Sandbox settings                   | Managed                 |
| [`showClearContextOnPlanAccept`](#showclearcontextonplanaccept)                                 | Show a "clear context" option on the [plan accept screen](/docs/en/permission-modes#review-and-approve-a-plan)                                                                                                                   | Interface and terminal             | Any file                |
| [`showThinkingSummaries`](#showthinkingsummaries)                                               | See summaries of Claude's [thinking](/docs/en/model-config#extended-thinking) instead of a collapsed stub                                                                                                                        | Model and responses                | Any file                |
| [`showTurnDuration`](#showturnduration)                                                         | Hide the "Cooked for" duration after each response                                                                                                                                                                          | Interface and terminal             | Any file                |
| [`skillListingBudgetFraction`](#skilllistingbudgetfraction)                                     | Reserve more or less context for the [skill listing](/docs/en/skills#skill-descriptions-are-cut-short)                                                                                                                           | Memory and context                 | Any file                |
| [`skillListingMaxDescChars`](#skilllistingmaxdescchars)                                         | Cap each skill's description length in the [skill listing](/docs/en/skills#skill-descriptions-are-cut-short)                                                                                                                     | Memory and context                 | Any file                |
| [`skillOverrides`](#skilloverrides)                                                             | [Hide or collapse a skill](/docs/en/skills#override-skill-visibility-from-settings) without editing its SKILL.md                                                                                                                 | Plugins and skills                 | Any file                |
| [`skipAutoPermissionPrompt`](#skipautopermissionprompt)                                         | Skip the one-time notice Claude Code shows when you first enter [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) yourself rather than through the built-in default                                        | Permission settings                | User or managed         |
| [`skipDangerousModePermissionPrompt`](#skipdangerousmodepermissionprompt)                       | Skip the confirmation dialog before [bypassPermissions mode](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode)                                                                                              | Permission settings                | User, local, or managed |
| [`skipWebFetchPreflight`](#skipwebfetchpreflight)                                               | Skip the [WebFetch hostname check](/docs/en/tools-reference#webfetch-tool-behavior) when Anthropic is unreachable                                                                                                                | Privacy and telemetry              | Any file                |
| [`spellcheck`](#spellcheck)                                                                     | Underline misspelled words in the prompt input with a [spell checker](/docs/en/interactive-mode#check-spelling-as-you-type) you install                                                                                          | Interface and terminal             | User or managed         |
| [`spinnerTipsEnabled`](#spinnertipsenabled)                                                     | Hide tips in the spinner while Claude works                                                                                                                                                                                 | Interface and terminal             | Any file                |
| [`spinnerTipsOverride`](#spinnertipsoverride)                                                   | Add your own tips to the spinner rotation, or replace the built-in tips                                                                                                                                                     | Interface and terminal             | Any file                |
| [`spinnerVerbs`](#spinnerverbs)                                                                 | Add or replace the verbs shown while a turn runs                                                                                                                                                                            | Interface and terminal             | Any file                |
| [`sshConfigs`](#sshconfigs)                                                                     | Add [SSH connections](/docs/en/desktop#pre-configure-ssh-connections-for-your-team) to the Desktop environment dropdown                                                                                                          | Remote, desktop, and notifications | User or managed         |
| [`sshHostAllowlist`](#sshhostallowlist)                                                         | Limit which hosts [Desktop SSH sessions](/docs/en/desktop#restrict-which-ssh-hosts-users-can-connect-to) can reach                                                                                                               | Remote, desktop, and notifications | Managed                 |
| [`statusLine`](#statusline)                                                                     | Run your own command to render a [status line](/docs/en/statusline) below the prompt                                                                                                                                             | Interface and terminal             | Any file                |
| [`strictKnownMarketplaces`](#strictknownmarketplaces)                                           | Allowlist the [marketplace](/docs/en/plugin-marketplaces) sources users can add and install from                                                                                                                                 | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization`](#strictpluginonlycustomization)                               | Block [skills](/docs/en/skills), [agents](/docs/en/sub-agents), [hooks](/docs/en/hooks), and [MCP servers](/docs/en/mcp) from user and project sources                                                                                          | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.agents`](#strictpluginonlycustomization-agents)                 | Lock [agents](/docs/en/sub-agents) to plugin and managed sources                                                                                                                                                                 | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.hooks`](#strictpluginonlycustomization-hooks)                   | Lock [hooks](/docs/en/hooks) to plugin and managed sources                                                                                                                                                                       | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.mcp`](#strictpluginonlycustomization-mcp)                       | Lock [MCP servers](/docs/en/mcp) to plugin and managed sources                                                                                                                                                                   | Plugins and skills                 | Managed                 |
| [`strictPluginOnlyCustomization.skills`](#strictpluginonlycustomization-skills)                 | Lock [skills](/docs/en/skills) to plugin and managed sources                                                                                                                                                                     | Plugins and skills                 | Managed                 |
| [`subagentPromptCacheTtl`](#subagentpromptcachettl)                                             | Choose the [prompt cache lifetime](/docs/en/prompt-caching#cache-lifetime) for subagents and other requests outside the main conversation                                                                                        | Model and responses                | Any file                |
| [`subagentStatusLine`](#subagentstatusline)                                                     | Rewrite rows in the [subagent](/docs/en/sub-agents) task display with your own command                                                                                                                                           | Interface and terminal             | Any file                |
| [`switchModelsOnFlag`](#switchmodelsonflag)                                                     | Switch models automatically or pause when a [safety classifier](/docs/en/model-config#ask-before-switching) flags a request                                                                                                      | Model and responses                | Any file                |
| [`syncClaudeAiSkills`](#syncclaudeaiskills)                                                     | Stop downloading the [skills enabled on your claude.ai account](/docs/en/skills#how-synced-skills-behave) and hide the ones already synced                                                                                       | Plugins and skills                 | User, local, or managed |
| [`syntaxHighlightingDisabled`](#syntaxhighlightingdisabled)                                     | Turn off syntax highlighting in diffs and code blocks                                                                                                                                                                       | Interface and terminal             | Any file                |
| [`teammateDefaultModel`](#teammatedefaultmodel)                                                 | Removed in v2.1.234; [teammates](/docs/en/agent-teams#specify-teammates-and-models) follow the lead's model                                                                                                                      | Global config settings             | Global config           |
| [`teammateMode`](#teammatemode)                                                                 | Choose how [agent team teammates display](/docs/en/agent-teams#choose-a-display-mode)                                                                                                                                            | Agents, sessions, and worktrees    | Any file                |
| [`terminalProgressBarEnabled`](#terminalprogressbarenabled)                                     | Hide the terminal progress bar in terminals that support it                                                                                                                                                                 | Interface and terminal             | Any file                |
| [`terminalTitleFromRename`](#terminaltitlefromrename)                                           | Stop [`/rename`](/docs/en/sessions#name-your-sessions) and `--name` from changing the terminal tab title                                                                                                                         | Interface and terminal             | Any file                |
| [`theme`](#theme)                                                                               | Pick the interface [color theme](/docs/en/terminal-config#match-the-color-theme), built-in or custom                                                                                                                             | Interface and terminal             | Any file                |
| [`tui`](#tui)                                                                                   | Choose the [fullscreen](/docs/en/fullscreen) or classic terminal renderer                                                                                                                                                        | Interface and terminal             | Any file                |
| [`ultracode`](#ultracode)                                                                       | Have Claude plan a [workflow](/docs/en/workflows#let-claude-decide-with-ultracode) for each substantive task without being asked                                                                                                 | Model and responses                | Any file                |
| [`useAutoModeDuringPlan`](#useautomodeduringplan)                                               | Let the [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) classifier review shell commands in [plan mode](/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode); set `false` to get prompts instead | Permission settings                | User, local, or managed |
| [`verbose`](#verbose)                                                                           | Show [full tool output](/docs/en/cli-reference#cli-flags) instead of truncated summaries; `viewMode` takes precedence when both are set                                                                                          | Interface and terminal             | Any file                |
| [`viewMode`](#viewmode)                                                                         | Start every session in [default, verbose, or focus view](/docs/en/cli-reference#cli-flags)                                                                                                                                       | Interface and terminal             | Any file                |
| [`vimInsertModeRemaps`](#viminsertmoderemaps)                                                   | Map a two-key [INSERT-mode sequence](/docs/en/interactive-mode#remap-insert-mode-key-sequences) such as `jj` to Escape                                                                                                           | Interface and terminal             | User or managed         |
| [`voice`](#voice)                                                                               | Turn on [voice dictation](/docs/en/voice-dictation) and pick hold or tap mode                                                                                                                                                    | Interface and terminal             | Any file                |
| [`voiceEnabled`](#voiceenabled)                                                                 | Turn on [voice dictation](/docs/en/voice-dictation) with the older single-key form                                                                                                                                               | Interface and terminal             | Any file                |
| [`wheelScrollAccelerationEnabled`](#wheelscrollaccelerationenabled)                             | Turn off [mouse-wheel acceleration](/docs/en/fullscreen#mouse-wheel-scrolling) in fullscreen rendering                                                                                                                           | Interface and terminal             | Any file                |
| [`workflowKeywordTriggerEnabled`](#workflowkeywordtriggerenabled)                               | Let the word `ultracode` in a prompt start a [workflow](/docs/en/workflows); set `false` to type it without starting one                                                                                                         | Hooks and automation               | Any file                |
| [`workflowSizeGuideline`](#workflowsizeguideline)                                               | Set the agent count Claude aims for in [dynamic workflows](/docs/en/workflows)                                                                                                                                                   | Hooks and automation               | Any file                |
| [`worktree`](#worktree)                                                                         | Configure how Claude Code creates git [worktrees](/docs/en/worktrees)                                                                                                                                                            | Agents, sessions, and worktrees    | Any file                |
| [`worktree.baseRef`](#worktree-baseref)                                                         | Branch new [worktrees](/docs/en/worktrees) from the remote default branch or your local HEAD                                                                                                                                     | Agents, sessions, and worktrees    | Any file                |
| [`worktree.bgIsolation`](#worktree-bgisolation)                                                 | Let background sessions edit the working copy without a [worktree](/docs/en/worktrees)                                                                                                                                           | Agents, sessions, and worktrees    | Any file                |
| [`worktree.sparsePaths`](#worktree-sparsepaths)                                                 | Check out only the directories you need in each [worktree](/docs/en/worktrees)                                                                                                                                                   | Agents, sessions, and worktrees    | Any file                |
| [`worktree.symlinkDirectories`](#worktree-symlinkdirectories)                                   | Symlink large directories into each [worktree](/docs/en/worktrees) instead of duplicating them                                                                                                                                   | Agents, sessions, and worktrees    | Any file                |
| [`wslInheritsWindowsSettings`](#wslinheritswindowssettings)                                     | Have WSL read [managed settings](/docs/en/managed-settings) from the Windows policy chain                                                                                                                                        | Enterprise and managed settings    | Managed                 |

## Model and responses

Choose which models Claude Code uses and how it responds. For how these settings interact with the `/model` command and environment variables, see [Model configuration](/docs/en/model-config).

### `advisorModel`

Pick which model answers when Claude calls the server-side [advisor tool](/docs/en/advisor). Unset it to turn the advisor off. The advisor must be at least as capable as your main model; when it isn't, Claude Code sends requests without the advisor. See [Choose an advisor model](/docs/en/advisor#choose-an-advisor-model).

You don't usually edit this key by hand. Run `/advisor` to open a picker that shows the current choice, the models that can advise, and **No advisor**. Claude Code saves your pick to this key in `~/.claude/settings.json`. In a session attached to a remote worker, the pick applies to that session only.

To pick Fable, first accept the [usage-credits consent](/docs/en/advisor#fable-advisor-and-usage-credits) by running `/model fable`. Until you do, picking Fable in `/advisor` saves nothing and Claude Code tells you to run `/model fable` first.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of the aliases `"fable"`, `"opus"`, or `"sonnet"`, which resolve to Claude Code's current default version of that model family, or a full model ID such as `"claude-opus-5"`
* **Default**: unset, so the advisor is off
* **Per-session overrides**: `--advisor` takes precedence over this key for one session. [`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`](/docs/en/env-vars) turns the advisor off, and this key can't turn it back on

```json settings.json theme={null}
{
  "advisorModel": "opus"
}
```

The key has no effect on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry. `"fable"` requires [Fable 5 access](/docs/en/advisor#choose-an-advisor-model).

### `alwaysThinkingEnabled`

Turn [extended thinking](/docs/en/model-config#extended-thinking) off for every session by setting this to `false`. Thinking is on by default, so `true` changes nothing. Most people set this through `/config` rather than by editing the file.

On models that always think, such as Fable 5, `false` has no effect. On [third-party providers](/docs/en/third-party-integrations) Claude Code omits the `thinking` parameter instead of turning thinking off, so adaptive-reasoning models may still think. With thinking turned off on the Anthropic API, Claude Code sends effort `high` instead of a higher level to models it knows [don't accept that combination](/docs/en/errors#effort-isnt-available-with-thinking-turned-off), such as Opus 5.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: no effect; thinking is already on
  * `false`: Claude Code turns extended thinking off for every session
* **Default**: unset, so thinking is on for models that support it
* **Per-session overrides**: [`MAX_THINKING_TOKENS`](/docs/en/env-vars) takes precedence over this key for one session: `0` turns thinking off, under the same model and provider limits as `false`, and a positive value turns thinking on even when this key is `false`. On adaptive-reasoning models the number itself is ignored

```json settings.json theme={null}
{
  "alwaysThinkingEnabled": false
}
```

### `availableModels`

Restrict which models people can select for the main session, [subagents](/docs/en/sub-agents), [skills](/docs/en/skills), and the [advisor](/docs/en/advisor). A managed list constrains `/model`, `--model`, and the `model` key in a developer's own files; a model outside it can't be selected. On its own this doesn't touch the Default option; pair it with [`enforceAvailableModels`](#enforceavailablemodels) for that.

* **Scope**: [`Any file`](#scopes). Deploy it in managed settings to enforce it for an organization.
* **Type**: array of model aliases or IDs
* **Default**: unset, so every model is available

This example lets people select only Sonnet and Haiku models:

```json settings.json theme={null}
{
  "availableModels": ["sonnet", "haiku"]
}
```

See [Restrict model selection](/docs/en/model-config#restrict-model-selection).

### `effortLevel`

Keep an [effort level](/docs/en/model-config#adjust-effort-level) across sessions. Lower levels are faster and cheaper on straightforward tasks, and higher levels reason more deeply on complex problems. Claude Code writes this key to your user settings when you run `/effort low`, `medium`, `high`, or `xhigh` in an interactive session on your machine. In a `-p` run, the Agent SDK, or a session attached to a remote worker, `/effort` applies to that session only. The message `/effort` prints says which happened.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"low"`: the least reasoning, for short, scoped, latency-sensitive tasks that aren't intelligence-sensitive
  * `"medium"`: reduces token usage for cost-sensitive work that can trade off some intelligence
  * `"high"`: balances token usage and intelligence
  * `"xhigh"`: deeper reasoning at higher token spend
* **Default**: unset
* **Per-session overrides**: `--effort` takes precedence over this key for one session, and [`CLAUDE_CODE_EFFORT_LEVEL`](/docs/en/env-vars) takes precedence over both

```json settings.json theme={null}
{
  "effortLevel": "xhigh"
}
```

On Opus 4.7, Opus 4.8, and Fable 5, Claude Code holds that model's default effort until you change effort once with `/effort`, `--effort`, or the `/model` picker. After that, it reads this key. See [Adjust effort level](/docs/en/model-config#adjust-effort-level).

### `enforceAvailableModels`

The `/model` picker has a **Default** option that resolves to your [organization default model](/docs/en/model-config#organization-default-model) when one applies, and otherwise to your account type's default. An [`availableModels`](#availablemodels) allowlist limits the models you can name, but on its own it leaves **Default** alone, so **Default** can still resolve to a model outside the list. This key closes that gap. Requires Claude Code v2.1.175 or later.

When your organization deploys any managed settings, Claude Code reads this key from the managed source alone and ignores it in your other files.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: when **Default** would resolve to a model outside `availableModels`, Claude Code resolves it to the first available model in the list
  * `false`: **Default** resolves as usual, even to a model outside `availableModels`
* **Default**: `false`

This example restricts named selections to Sonnet and Haiku models and makes **Default** resolve to the first of them that is available:

```json settings.json theme={null}
{
  "availableModels": ["sonnet", "haiku"],
  "enforceAvailableModels": true
}
```

This key has no effect when `availableModels` is unset or empty. See [Enforce the allowlist for the Default model](/docs/en/model-config#enforce-the-allowlist-for-the-default-model). Requires Claude Code v2.1.175 or later.

### `fallbackModel`

Name backup models for Claude Code to try, in order, when your primary model is overloaded or unavailable. Claude Code switches to the next available model in the chain for the rest of the turn and shows a notice. Without a chain, Claude Code retries the same model and then surfaces the server's error, and you retry or switch models yourself.

A switch means one turn with a cold [prompt cache](/docs/en/prompt-caching#switching-models) on the fallback model; your next message tries the primary model first again.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of model aliases or IDs; `"default"` expands to the default model
* **Default**: unset, so a failed request isn't retried on another model
* **Per-session overrides**: `--fallback-model` takes precedence over this key for one session

This example tries Sonnet 5 first, then Haiku 4.5, when your primary model fails:

```json settings.json theme={null}
{
  "fallbackModel": ["claude-sonnet-5", "claude-haiku-4-5"]
}
```

Unlike most array settings, this key doesn't merge across settings files: the highest-precedence file that defines it supplies the whole chain. If your project file sets `["claude-sonnet-5"]` and your user file sets `["claude-haiku-4-5"]`, the chain is `["claude-sonnet-5"]` only. Claude Code keeps at most three distinct allowed models from the list and ignores the rest. See [Fallback model chains](/docs/en/model-config#fallback-model-chains).

### `fastMode`

Turn [fast mode](/docs/en/fast-mode) on for sessions where it's available, for interactive work like rapid iteration or live debugging where you want speed at a higher cost per token. You don't usually edit this key by hand: running `/fast` writes `fastMode: true` to `~/.claude/settings.json`, and running it again to turn fast mode off removes the key. Fast mode runs only on Opus 5 and Opus 4.8: turning it on from another model switches you to Opus, and switching to an unsupported model turns it off. See [Switch models while fast mode is on](/docs/en/fast-mode#switch-models-while-fast-mode-is-on).

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns fast mode on for sessions where it's available
  * `false`: fast mode stays off
* **Default**: unset, so fast mode is off
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_FAST_MODE`](/docs/en/env-vars) turns fast mode off for one session, and this key can't turn it back on

```json settings.json theme={null}
{
  "fastMode": true
}
```

### `fastModePerSessionOptIn`

Normally, running `/fast` saves [`fastMode`](#fastmode) to a person's user settings, so fast mode is on at the start of every later session. Set this key to `true` to stop that: a saved `fastMode: true` no longer turns fast mode on at session start, and each person has to run `/fast` in each session they want it. Claude Code leaves the `fastMode` key in their file, so turning this key off restores the old behavior. Owners on Team or Enterprise plans can deploy it organization-wide through [server-managed settings](/docs/en/server-managed-settings).

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: a saved `fastMode: true` no longer turns fast mode on at session start, so each person runs `/fast` in each session they want it; a `fastMode: true` passed with `--settings` still counts for that session unless managed settings set this key
  * `false`: a saved `fastMode: true` turns fast mode on at the start of every later session
* **Default**: `false`

```json settings.json theme={null}
{
  "fastModePerSessionOptIn": true
}
```

See [Require per-session opt-in](/docs/en/fast-mode#require-per-session-opt-in).

### `language`

Have Claude respond in a language other than English by default. There is no fixed list for responses: Claude Code adds the value verbatim to the system prompt as an instruction to always respond in that language, so any language name Claude can read works. Claude Code doesn't check the value, so a misspelled name reaches Claude as written rather than producing an error. The same value sets the language for [voice dictation](/docs/en/voice-dictation#change-the-dictation-language), which does have a fixed list of [supported dictation languages](/docs/en/voice-dictation#change-the-dictation-language), and for auto-generated session titles.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, any language name, such as `"japanese"`, `"spanish"`, or `"french"`; Claude Code doesn't validate it
* **Default**: unset; session titles then match the language of your conversation

```json settings.json theme={null}
{
  "language": "japanese"
}
```

### `model`

Set the model every new session uses, so you don't have to pick one with `/model` each time. Setting it here doesn't stop you from switching mid-session. If your admin set an [organization default model](/docs/en/model-config#organization-default-model) to override user selection, you get that model even when you set this key in user, project, or local settings.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a model alias or full model ID
* **Default**: unset, so Claude Code uses your account's default model
* **Per-session overrides**: `--model` takes precedence over [`ANTHROPIC_MODEL`](/docs/en/env-vars), and both take precedence over this key for one session, including over a managed `model`; an [`availableModels`](#availablemodels) list still applies to the pick

```json settings.json theme={null}
{
  "model": "claude-sonnet-5"
}
```

A value here outranks [`ANTHROPIC_DEFAULT_MODEL`](/docs/en/model-config#set-a-default-model-for-new-sessions), which Claude Code uses only when nothing else selects a model.

### `modelOverrides`

Map Anthropic model IDs to provider-specific model IDs, such as Amazon Bedrock inference profile ARNs. Each model picker entry then uses its mapped value when calling the provider API. Administrators use this on [Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry](/docs/en/model-config#override-model-ids-per-version) to route each model version to a specific inference profile, version name, or deployment for governance, cost allocation, or regional routing.

* **Scope**: [`Any file`](#scopes)
* **Type**: object mapping model ID to provider model ID
* **Default**: unset

This example routes every call for Opus 4.6 to the named Bedrock inference profile:

```json settings.json theme={null}
{
  "modelOverrides": {
    "claude-opus-4-6": "arn:aws:bedrock:us-east-1:123456789012:inference-profile/example"
  }
}
```

See [Override model IDs per version](/docs/en/model-config#override-model-ids-per-version).

### `modelPicker`

List the models the `/model` picker offers, in the order you write them and under labels you choose, so the picker lists the models your organization runs, after the built-in lineup or instead of it. Each row's `model` is taken verbatim, so it accepts anything `--model` accepts: an alias such as `opus`, an Anthropic model ID, or a provider-format ID for Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, or an LLM gateway. Requires Claude Code v2.1.242 or later.

* **Scope**: [`User or managed`](#scopes). Claude Code reads the key from managed settings, `--settings`, and user settings, and ignores it in project and local settings so a repository you clone can't relabel the picker. The highest of those three that sets the key supplies the whole lineup, and Claude Code never combines lineups from two sources.
* **Type**: object with an `options` array of rows and an optional `replaceBuiltInOptions` Boolean
* **Default**: unset, so the picker shows the built-in lineup

This example adds two Bedrock deployments after the built-in lineup, under names your team recognizes:

```json managed-settings.json theme={null}
{
  "modelPicker": {
    "options": [
      { "model": "us.anthropic.claude-opus-4-8", "label": "Opus (production)" },
      {
        "model": "us.anthropic.claude-sonnet-4-6",
        "label": "Sonnet (production)",
        "description": "Day-to-day work"
      }
    ]
  }
}
```

<span id="modelpicker-options" />

<span id="modelpicker-replacebuiltinoptions" />

#### Fields for `modelPicker`

The key takes two fields, one for the rows themselves and one for whether they replace the built-in lineup or add to it.

| Field                   | Type                                                                                  | What it does                                                                                                                                                                                                                                                                  |
| :---------------------- | :------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options`               | array of rows, each with a required `model` and an optional `label` and `description` | The rows the picker shows, in this order, except that a grayed-out row moves to the bottom. Without a `label`, Claude Code titles the row with the built-in name for a model it knows, or the model ID otherwise, and without a `description` it writes a generic second line |
| `replaceBuiltInOptions` | Boolean, default `false`                                                              | Set it to `true` to show only these rows, **Default**, and a row for the model the session is already using. Leave it unset to add these rows after the built-in lineup                                                                                                       |

With `replaceBuiltInOptions` on, Claude Code hides every other row: the built-in lineup, the rows it adds for [`availableModels`](#availablemodels) entries, the models [gateway discovery](/docs/en/llm-gateway-protocol#model-discovery) found, and [`ANTHROPIC_CUSTOM_MODEL_OPTION`](/docs/en/model-config#add-a-custom-model-option). With it off, Claude Code skips a listed model that the built-in lineup already covers. A label changes what the picker shows, not which model Claude Code runs.

An [`availableModels`](#availablemodels) allowlist still applies to these rows. Before you add a listed model to the allowlist, read [Merge behavior](/docs/en/model-config#merge-behavior): a specific model ID narrows its family's wildcard entry. Claude Code also checks each row against the session before it shows the picker:

* **Dropped**: a row Claude Code can't serve, such as a retired model or a model your organization has no access to
* **Grayed out**: a row you can't select yet, shown with the reason
* **No row survives**: Claude Code keeps the built-in lineup, filtered by the allowlist as usual

Claude Code drops a row it can't parse and keeps the rest. See [Fix a broken settings file](/docs/en/settings#fix-a-broken-settings-file).

### `modelPricing`

Report spend at the rates your organization pays instead of list price. Set it when your organization has contracted rates, so the dollar figures developers see match your bill. Claude Code applies the rates in `/usage`, the [status line](/docs/en/statusline), the Agent SDK's `total_cost_usd`, the [`--max-budget-usd`](/docs/en/cli-reference) limit, and the [OpenTelemetry](/docs/en/monitoring-usage) cost metric and events. You supply the rates: Claude Code doesn't read them from your contract or the Claude Console. Requires Claude Code v2.1.242 or later.

* **Scope**: [`Managed`](#scopes). Deploy the key through server-managed settings, an MDM policy, a `managed-settings.json` file, or a [policy helper](/docs/en/managed-settings#compute-the-policy-with-a-helper-program). Claude Code ignores it in user, project, and local settings, in `--settings`, and on Windows in the user-writable [HKCU registry](/docs/en/managed-settings#where-each-mechanism-stores-the-policy). With server-managed settings, each session reports costs at list price until that session's [settings fetch](/docs/en/server-managed-settings#fetch-and-caching-behavior) has confirmed the setting. A host application that embeds Claude Code and sets [`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`](/docs/en/env-vars) can supply a table of its own through the SDK [`managedSettings`](/docs/en/agent-sdk/typescript#options) option, which Claude Code uses only when no managed source sets the key and only in Claude Code v2.1.246 or later.
* **Type**: object with an optional `multiplier` and an optional `overrides` map
* **Default**: unset, so Claude Code reports list price unless a host application supplies a table

This example sets contracted rates for Sonnet 4.6 and then reduces every figure, the Sonnet row included, by 15%. Set `multiplier` alone for a flat discount, `overrides` alone for per-model rates, or both:

```json managed-settings.json theme={null}
{
  "modelPricing": {
    "multiplier": 0.85,
    "overrides": {
      "claude-sonnet-4-6": {
        "input": 2.4,
        "output": 12,
        "cacheRead": 0.24,
        "cacheWrite": 3
      }
    }
  }
}
```

For the steps, including how to confirm the rates are in effect, see [Report spend at your contracted rates](/docs/en/costs#report-spend-at-your-contracted-rates).

<span id="modelpricing-multiplier" />

<span id="modelpricing-overrides" />

#### Fields for `modelPricing`

| Field        | Type                                                                                                    | What it does                                                                                                                                                                                                        |
| :----------- | :------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `multiplier` | number greater than 0 and at most 1                                                                     | Scales every cost Claude Code computes, whether or not an `overrides` row covers it                                                                                                                                 |
| `overrides`  | map of model ID to a rate object with `input`, `output`, `cacheRead`, and `cacheWrite`, each 0 to 10000 | The USD-per-million-token rates for that model, all four required. `cacheWrite` covers both five-minute and one-hour cache writes. See [Which models a row applies to](#which-models-a-modelpricing-row-applies-to) |

Claude Code uses a row's rates exactly as you wrote them, without adding the fast-mode surcharge or the [US-only-inference rate](https://platform.claude.com/docs/en/about-claude/pricing). If you also set `multiplier`, Claude Code applies it on top of the row's rates. Claude Code drops a row with a rate it can't parse, or a `multiplier` it can't parse, and keeps the rest; see [Fix a broken settings file](/docs/en/settings#fix-a-broken-settings-file).

#### Which models a `modelPricing` row applies to

Claude Code decides which models a row applies to from the row's key:

* **A built-in model's ID**: a key Claude Code itself uses for a built-in model, whether that key is the model's own ID, such as `claude-sonnet-4-6`, or its Bedrock, Agent Platform, or Foundry ID. Claude Code applies the row to every dated snapshot ID and provider-specific ID of that model.
* **Any other key**: a key that isn't a built-in model's ID, such as a gateway model alias. Claude Code applies the row to that one ID only. When a model ID matches one of your keys exactly and also falls under a row keyed by a built-in model's ID, Claude Code uses the exact match.
* **A Bedrock application inference profile**: once Claude Code has resolved the profile to the model it routes to, through your [`modelOverrides`](#modeloverrides) map or the [`bedrock:GetInferenceProfile` lookup](/docs/en/amazon-bedrock#iam-configuration), Claude Code applies that model's row to the profile.

### `outputStyle`

Select an [output style](/docs/en/output-styles) by name. An output style is a saved set of instructions that Claude Code adds to the system prompt to change Claude's role, tone, and output format, such as the built-in Explanatory and Learning styles or one you wrote yourself.

Claude Code builds the style into the system prompt once per conversation. An edit to this key takes effect after you run `/clear` or start a new session.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, the name of a [built-in](/docs/en/output-styles#built-in-output-styles) or [custom](/docs/en/output-styles#create-a-custom-output-style) output style
* **Default**: unset, so Claude Code uses the default style

This example selects the built-in Explanatory style, which adds educational insights between tasks:

```json settings.json theme={null}
{
  "outputStyle": "Explanatory"
}
```

### `promptCacheTtl`

Choose how long the [prompt cache](/docs/en/prompt-caching) holds the main conversation. This key applies to your interactive, `-p`, and Agent SDK turns, together with the helpers Claude Code runs inline with them. The one-hour lifetime keeps the cache warm across longer breaks, and the API [bills each cache write at a higher rate](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) than at the five-minute lifetime. Requires Claude Code v2.1.242 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"5m"`: the cache holds for five minutes
  * `"1h"`: the cache holds for an hour
* **Default**: unset, so each main-conversation request gets [its default lifetime](/docs/en/prompt-caching#which-ttl-each-request-gets)
* **Per-session overrides**: [`FORCE_PROMPT_CACHING_5M`](/docs/en/env-vars) takes precedence over everything else, then [`CLAUDE_CODE_PROMPT_CACHE_TTL`](/docs/en/env-vars), then this key, and last [`ENABLE_PROMPT_CACHING_1H`](/docs/en/env-vars)

This example keeps the main conversation on the one-hour lifetime and leaves subagents on five minutes:

```json settings.json theme={null}
{
  "promptCacheTtl": "1h",
  "subagentPromptCacheTtl": "5m"
}
```

For what each lifetime costs, see [Cache lifetime](/docs/en/prompt-caching#cache-lifetime).

### `showThinkingSummaries`

See summaries of Claude's [extended thinking](/docs/en/model-config#extended-thinking) in interactive sessions. Set it if you want the full summaries when you expand thinking with `Ctrl+O`. When unset or `false`, the Anthropic API redacts thinking blocks and Claude Code shows a collapsed stub; third-party providers don't redact.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: you see full thinking summaries when you expand thinking with `Ctrl+O`
  * `false`: the Anthropic API redacts thinking blocks and Claude Code shows a collapsed stub
* **Default**: `false`

```json settings.json theme={null}
{
  "showThinkingSummaries": true
}
```

Redaction only changes what you see, not what the model generates: to reduce thinking spend, [lower the budget or disable thinking](/docs/en/model-config#extended-thinking) instead. This setting has no effect in non-interactive mode (`-p`), the Agent SDK, or IDE extensions such as VS Code.

### `subagentPromptCacheTtl`

Choose how long the [prompt cache](/docs/en/prompt-caching) holds the requests Claude Code makes outside the main conversation. This key applies to [subagents](/docs/en/sub-agents), [workflows](/docs/en/workflows), and Claude Code's own background and helper requests, such as compaction and session titles. The one-hour lifetime keeps the cache warm across longer breaks, and the API [bills each cache write at a higher rate](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing) than at the five-minute lifetime. Requires Claude Code v2.1.242 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"5m"`: the cache holds for five minutes
  * `"1h"`: the cache holds for an hour
* **Default**: unset, so each of these requests gets [its default lifetime](/docs/en/prompt-caching#which-ttl-each-request-gets)
* **Per-session overrides**: [`FORCE_PROMPT_CACHING_5M`](/docs/en/env-vars) takes precedence over everything else, then [`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`](/docs/en/env-vars), then this key, then [`ENABLE_PROMPT_CACHING_1H`](/docs/en/env-vars), which asks for the one-hour lifetime on every request. For where a subagent's own frontmatter value ranks, see [Choose the TTL yourself](/docs/en/prompt-caching#choose-the-ttl-yourself)

This example gives subagents and the other requests outside the main conversation the one-hour lifetime:

```json settings.json theme={null}
{
  "subagentPromptCacheTtl": "1h"
}
```

This key covers the requests [`promptCacheTtl`](#promptcachettl) doesn't, so set both to choose a lifetime for every request Claude Code makes. For how a subagent's cache differs from the main conversation's, see [Subagents and the cache](/docs/en/prompt-caching#subagents-and-the-cache).

### `switchModelsOnFlag`

Choose what happens when a [safety classifier flags a request](/docs/en/model-config#automatic-model-fallback): switch to the fallback model and continue, or pause so you can choose between switching and editing the prompt.

* **Scope**: [`Any file`](#scopes). Appears in `/config` as **Switch models when a message is flagged**.
* **Type**: Boolean
  * `true`: Claude Code switches to the fallback model and continues
  * `false`: in an interactive session Claude Code pauses so you can choose between switching and editing the prompt; where no dialog can show, such as a `-p` run, the flagged request ends as an error
* **Default**: `true`, switch automatically

```json settings.json theme={null}
{
  "switchModelsOnFlag": false
}
```

See [Ask before switching](/docs/en/model-config#ask-before-switching). Requires Claude Code v2.1.170 or later.

### `ultracode`

Start sessions with [ultracode](/docs/en/workflows#let-claude-decide-with-ultracode) on. With it on, Claude plans a workflow for each substantive task instead of waiting for you to ask. Claude plans workflows only when [dynamic workflows](/docs/en/workflows) are enabled for you and your model supports `xhigh` effort. Either way, `ultracode: true` runs the session at `xhigh` effort. Claude Code reads this key but never writes it: `/effort ultracode` turns ultracode on for the current session only.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: sessions start at `xhigh` effort, with ultracode on when dynamic workflows are enabled for you and your model supports `xhigh`
  * `false`: sessions start with ultracode off
* **Default**: unset, so ultracode is off
* **Per-session overrides**: `/effort ultracode` turns ultracode on for one session without this key. So does `--effort ultracode`, which requires Claude Code v2.1.203 or later

```json settings.json theme={null}
{
  "ultracode": true
}
```

Ultracode runs the session at `xhigh` effort and takes precedence over `effortLevel`. An Agent SDK `apply_flag_settings` control request also accepts the key.

## Permission settings

Decide what Claude can do without asking, which permission mode a session starts in, and what auto mode's classifier allows. For rule syntax and the permission model, see [Configure permissions](/docs/en/permissions).

### `allowManagedPermissionRulesOnly`

Make managed settings the only source of `allow`, `ask`, and `deny` permission rules. Claude Code then ignores rules in user, project, local, and `--settings` files, ignores `--allowedTools`, hides the always-allow choices in permission prompts, and stops saving new rules. When [parent settings from an embedding host](/docs/en/managed-settings#let-an-embedding-host-add-policy) apply, Claude Code treats them as part of the managed tier: it keeps their `deny` and `ask` rules and drops their `allow` rules and `additionalDirectories`.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: managed settings are the only source of `allow`, `ask`, and `deny` rules; Claude Code ignores rules from other files and `--allowedTools`, drops the `allow` rules and `additionalDirectories` of any host-supplied parent settings that apply while keeping their `deny` and `ask` rules, hides always-allow choices, and stops saving new rules
  * `false`: Claude Code applies permission rules from user, project, local, and `--settings` files in addition to the managed ones
* **Default**: unset, so Claude Code applies permission rules from user, project, and local settings and from `--settings`, in addition to the managed ones

```json managed-settings.json theme={null}
{
  "allowManagedPermissionRulesOnly": true
}
```

This key doesn't lock down the MCP server allowlist; for that, set [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly). See [Managed-only settings](/docs/en/managed-settings#managed-only-settings).

### `autoMode`

Add your own rules to what the [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) classifier blocks and allows. Use it to tell the classifier which repos, buckets, and domains your organization trusts, so it stops blocking routine internal operations. The classifier ships with [built-in allow and deny rules](/docs/en/auto-mode-config#inspect-the-defaults-and-your-effective-config). Include the literal string `"$defaults"` in an array to keep those built-in rules at that position and add yours around them; leave it out to replace them with yours.

* **Scope**: [`User or managed`](#scopes)
* **Type**: object with `environment`, `allow`, `soft_deny`, and `hard_deny` arrays of prose rules, plus the [`classifyAllShell`](#automode-classifyallshell) Boolean
* **Default**: unset, so the classifier uses only its [built-in rules](/docs/en/auto-mode-config#inspect-the-defaults-and-your-effective-config)

This example keeps the built-in `soft_deny` rules, through `"$defaults"`, and adds one more that blocks `terraform apply`:

```json settings.json theme={null}
{
  "autoMode": {
    "soft_deny": ["$defaults", "Never run terraform apply"]
  }
}
```

When more than one of those files sets the same array, Claude Code concatenates the entries. For the rule format and how each array is applied, see [Configure auto mode](/docs/en/auto-mode-config).

### `autoMode.classifyAllShell`

Send every Bash and PowerShell command through the auto mode classifier while auto mode is active. By default, auto mode suspends only allow rules that could run arbitrary code: tool-wide and wildcard rules such as `Bash(*)`, and interpreter or shell-wrapper prefixes such as `Bash(python *)`. A command that any other allow rule matches, such as `Bash(npm test)`, skips the classifier, and a destructive argument the rule's prefix didn't anticipate can get through unseen. Setting this key suspends every shell allow rule for the session so the classifier sees every command. Requires Claude Code v2.1.193 or later.

* **Scope**: [`User or managed`](#scopes). Read wherever [`autoMode`](#automode) is read.
* **Type**: Boolean
  * `true`: while auto mode is active, Claude Code sends every Bash and PowerShell command through the classifier and suspends your shell allow rules; outside auto mode the rules still apply
  * `false`: auto mode suspends only allow rules that could run arbitrary code, such as `Bash(*)` and `Bash(python *)`; a command that any other allow rule matches skips the classifier, and every other shell command goes through it
* **Default**: `false`

```json settings.json theme={null}
{
  "autoMode": {
    "classifyAllShell": true
  }
}
```

See [Route all shell commands through the classifier](/docs/en/auto-mode-config#route-all-shell-commands-through-the-classifier). Requires Claude Code v2.1.193 or later.

### `disableAutoMode`

Remove [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) from the `Shift+Tab` cycle. Any session that would otherwise [start in auto mode](/docs/en/permission-modes#which-mode-a-session-starts-in), whether from `--permission-mode auto`, a settings file, or the built-in default, starts in `default` instead. Administrators set it in managed settings to prevent developers in their organization from using auto mode.

* **Scope**: [`Any file`](#scopes). Most useful in [managed settings](/docs/en/managed-settings), where users can't override it. Also accepted under `permissions` as `permissions.disableAutoMode`.
* **Type**: the string `"disable"`
* **Default**: unset

```json settings.json theme={null}
{
  "disableAutoMode": "disable"
}
```

### `permissions`

Control which tools Claude can use without asking, which ones always prompt, and which ones are blocked, and set the [permission mode](/docs/en/permission-modes) a session starts in. Every `permissions.*` key below nests under this object.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `allow`, `ask`, `deny`, `additionalDirectories`, `defaultMode`, `disableBypassPermissionsMode`, and `disableAutoMode`
* **Default**: unset

This example approves `npm run` commands without asking, prompts before `git push`, blocks reads of `.env`, and starts sessions in `acceptEdits`:

```json settings.json theme={null}
{
  "permissions": {
    "allow": ["Bash(npm run *)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./.env)"],
    "defaultMode": "acceptEdits"
  }
}
```

The three rule arrays share one syntax; see [Permission rule syntax](#permission-rule-syntax) under `permissions.allow`. For how permission rules from different files combine, see [how permission rules merge across scopes](/docs/en/permissions#settings-precedence); for how settings keys in general combine, see [Settings precedence](/docs/en/settings#settings-precedence) on the settings guide.

### `useAutoModeDuringPlan`

Choose whether Claude Code uses the auto mode classifier to review shell commands in plan mode. With the default `true`, the classifier reviews each command during planning when auto mode is available and you see no prompt. Set `false` to get a permission prompt for every command outside the built-in read-only set. Appears in `/config` as **Use auto mode during plan**.

* **Scope**: [`User, local, or managed`](#scopes). A repository can't turn it off for you.
* **Type**: Boolean
  * `true`: the same as unset; when auto mode is available, the classifier reviews each shell command during planning instead of prompting you for it. A `false` in any of these files still turns it off
  * `false`: you get a permission prompt for every command outside the built-in read-only set
* **Default**: `true`

```json settings.json theme={null}
{
  "useAutoModeDuringPlan": false
}
```

### `permissions.allow`

List the tool uses Claude Code approves without asking you. In an MCP rule, `*` can appear only in the tool name after the `mcp__<server>__` prefix, such as `mcp__github__get_*`; it can't appear in the server name.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of permission rule strings
* **Default**: unset
* **Per-session overrides**: `--allowedTools` adds allow rules for one session, and a deny rule from any settings file still blocks a tool it names

This example approves `git diff` and lets Claude Code read your `.zshrc` without asking:

```json settings.json theme={null}
{
  "permissions": {
    "allow": ["Bash(git diff *)", "Read(~/.zshrc)"]
  }
}
```

Claude Code applies `allow` rules from a project's `.claude/settings.json` only after you accept the [workspace trust dialog](/docs/en/permissions#project-allow-rules-and-workspace-trust) for that folder.

#### Permission rule syntax

Permission rules follow the format `Tool` or `Tool(specifier)`. Claude Code evaluates `deny` rules first, then `ask`, then `allow`, and the first match decides regardless of how specific each rule is; see the [permission rule evaluation order](/docs/en/permissions#manage-permissions).

Each row shows one rule shape and what it matches.

| Rule                           | What it matches                  |
| :----------------------------- | :------------------------------- |
| `Bash`                         | Every Bash command               |
| `Bash(npm run *)`              | Commands starting with `npm run` |
| `Read(./.env)`                 | Reads of the `.env` file         |
| `WebFetch(domain:example.com)` | Fetch requests to example.com    |

For the complete rule syntax, including wildcard behavior, tool-specific patterns for Read, Edit, WebFetch, MCP, and Agent rules, and the security limitations of Bash patterns, see [Permission rule syntax](/docs/en/permissions#permission-rule-syntax).

### `permissions.ask`

List the tool uses that prompt you for confirmation even in a permission mode that would otherwise approve them, such as `acceptEdits` or `bypassPermissions`. In `dontAsk` mode Claude Code denies a matching tool use instead of prompting.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of permission rule strings
* **Default**: unset

```json settings.json theme={null}
{
  "permissions": {
    "ask": ["Bash(git push *)"]
  }
}
```

<span id="exclude-sensitive-files" />

### `permissions.deny`

List the tool uses Claude Code blocks. Use it for files that hold API keys, secrets, or environment values: Claude Code excludes matching files from file discovery and search results, denies reads of them, and blocks the [Edit and Write tools](/docs/en/permissions#read-and-edit) on the matching paths. Read and Edit deny rules apply to Claude's built-in file tools and to file commands Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, and `sed`; they don't apply to arbitrary subprocesses, so for OS-level enforcement [enable the sandbox](/docs/en/sandboxing).

* **Scope**: [`Any file`](#scopes)
* **Type**: array of permission rule strings
* **Default**: unset
* **Per-session overrides**: `--disallowedTools` adds deny rules for one session alongside this key

This example denies reads of `.env` files, the `secrets` directory, and a credentials file, and blocks `curl` commands:

```json settings.json theme={null}
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Read(./config/credentials.json)",
      "Bash(curl *)"
    ]
  }
}
```

Tool names accept glob patterns, so `"*"` denies every tool and `"mcp__*"` denies every MCP tool. Claude Code ignores a deny rule for the [`EndConversation`](/docs/en/tools-reference#endconversation-tool-behavior) tool as long as any other tool is still available to Claude. For what a `Bash` deny rule can and can't catch, see [Bash permission limitations](/docs/en/permissions#tool-specific-permission-rules). This key replaces the deprecated `ignorePatterns` configuration.

### `permissions.additionalDirectories`

Give Claude file access to directories outside the one you started in, as additional [working directories](/docs/en/permissions#working-directories). Most `.claude/` configuration is [not discovered](/docs/en/permissions#additional-directories-grant-file-access-not-configuration) from these directories.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of directory paths
* **Default**: unset
* **Per-session overrides**: `--add-dir` and `/add-dir` add directories for one session alongside this key

```json settings.json theme={null}
{
  "permissions": {
    "additionalDirectories": ["../docs/"]
  }
}
```

Like `allow` rules, entries in a project's `.claude/settings.json` take effect only after you accept the [workspace trust dialog](/docs/en/permissions#project-allow-rules-and-workspace-trust) for that folder.

### `permissions.defaultMode`

Set the [permission mode](/docs/en/permission-modes) new sessions start in. When you leave it unset, sessions start in the [built-in default](/docs/en/permission-modes#which-mode-a-session-starts-in) for your plan and surface.

* **Scope**: [`Any file`](#scopes). `auto` doesn't take effect from project or local settings, so set it in `~/.claude/settings.json` instead. Conversations the VS Code extension starts read only user, managed, and `--settings` values.
* **Type**: string, one of:
  * `"default"`: Claude Code runs only reads without asking
  * `"acceptEdits"`: Claude Code also runs file edits and common filesystem commands such as `mkdir` and `mv` without asking
  * `"plan"`: Claude Code reads and plans but blocks edits until you approve a plan
  * `"auto"`: Claude Code runs everything, with background safety checks
  * `"dontAsk"`: Claude Code runs only pre-approved tools and auto-denies every call that would otherwise prompt
  * `"bypassPermissions"`: Claude Code runs everything without asking
  * `"manual"`: an alias for `"default"`, in Claude Code v2.1.200 or later
* **Default**: unset
* **Per-session overrides**: `--permission-mode`, and its equivalent `--dangerously-skip-permissions` for `bypassPermissions`, take precedence over this key for one session

```json settings.json theme={null}
{
  "permissions": {
    "defaultMode": "acceptEdits"
  }
}
```

Permission rules layer on top of every mode: `deny` rules block in every mode, including `bypassPermissions`. See [Permission modes](/docs/en/permission-modes). `manual` names the permission mode labeled Manual in the CLI and the VS Code extension; the alias requires Claude Code v2.1.200 or later. In Claude Code on the web, Claude Code honors only `acceptEdits`, `plan`, `default`, and `auto` from this key. For conversations the VS Code extension starts, see [which setting the extension reads for the starting permission mode](/docs/en/permission-modes#switch-permission-modes).

### `permissions.disableBypassPermissionsMode`

Prevent anyone from entering `bypassPermissions` mode. Claude Code then rejects the `--dangerously-skip-permissions` flag, and ignores an [agent definition's](/docs/en/sub-agents#permission-modes) `permissionMode: bypassPermissions`, so the subagent runs with the parent session's permission mode.

* **Scope**: [`Any file`](#scopes). Typically set in [managed settings](/docs/en/managed-settings) to enforce organizational policy.
* **Type**: the string `"disable"`
* **Default**: unset
* **Per-session overrides**: this key takes precedence over `--dangerously-skip-permissions`, which Claude Code rejects while the key is set

```json settings.json theme={null}
{
  "permissions": {
    "disableBypassPermissionsMode": "disable"
  }
}
```

Before v2.1.223, Claude Code applied the frontmatter permission mode even with bypass disabled.

### `skipAutoPermissionPrompt`

Skip the one-time notice describing [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) that Claude Code shows when you first enter auto mode yourself, for example through your own settings or the mode selector, rather than when the built-in default starts a session in it. Claude Code shows that notice once and then records that it was shown, so this key only matters where the notice hasn't appeared yet.

* **Scope**: [`User or managed`](#scopes). A repository can't set it for you.
* **Type**: Boolean
  * `true`: Claude Code skips the notice
  * `false`: the same as unset; the notice appears once unless another of these files sets `true`
* **Default**: unset, so the notice appears once

```json settings.json theme={null}
{
  "skipAutoPermissionPrompt": true
}
```

### `skipDangerousModePermissionPrompt`

Skip the confirmation dialog Claude Code shows before a session enters `bypassPermissions` mode, whether from `--dangerously-skip-permissions` or from `defaultMode: "bypassPermissions"`. Claude Code writes `true` here in your user settings when you accept that dialog once.

* **Scope**: [`User, local, or managed`](#scopes). An untrusted repository can't skip the dialog for you.
* **Type**: Boolean
  * `true`: Claude Code skips the confirmation dialog before a session enters `bypassPermissions` mode
  * `false`: the same as unset; the dialog appears unless another of these files sets `true`
* **Default**: unset, so the dialog appears

```json settings.json theme={null}
{
  "skipDangerousModePermissionPrompt": true
}
```

## Sandbox settings

Isolate the commands Claude runs from your filesystem, your network, and your credentials. For how sandboxing works and platform requirements, see [Sandboxing](/docs/en/sandboxing).

### `sandbox`

Isolate the Bash commands Claude runs from your filesystem and network with [sandboxing](/docs/en/sandboxing). Turn the sandbox on with `enabled`, then narrow or widen what sandboxed commands can touch with the `filesystem`, `network`, and `credentials` sub-objects. The sandbox runs on macOS, Linux, and WSL2.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `excludedCommands`, `allowUnsandboxedCommands`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `bwrapPath`, `socatPath`, `ignoreViolations`, and `ripgrep`, plus the `filesystem`, `network`, and `credentials` objects
* **Default**: unset, so Claude Code runs commands without a sandbox

This turns the sandbox on, skips permission prompts for sandboxed commands, runs `docker` outside the sandbox, opens two extra write paths, hides your AWS credentials file, and pre-allows GitHub and npm:

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": ["docker *"],
    "filesystem": {
      "allowWrite": ["/tmp/build", "~/.kube"],
      "denyRead": ["~/.aws/credentials"]
    },
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

Claude Code takes a Boolean key's value from the highest-precedence settings file that sets it, so a managed `enabled` or `failIfUnavailable` overrides anything a developer sets. It merges array keys across every settings file the session loads, so a developer can append entries; see [Keep developers from widening the policy](/docs/en/sandboxing#keep-developers-from-widening-the-policy) for the managed-only locks. To require the sandbox for an organization, see [Enforce sandboxing with managed settings](/docs/en/sandboxing#enforce-sandboxing-with-managed-settings).

### `sandbox.enabled`

Turn on [sandboxing](/docs/en/sandboxing) for Bash commands. When you pick a mode in the `/sandbox` panel, Claude Code writes this key to `.claude/settings.local.json` for the current project; set it in `~/.claude/settings.json` to sandbox every project.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code sandboxes Bash commands
  * `false`: Bash commands run unsandboxed
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true
  }
}
```

On Linux and WSL2 the sandbox needs `bubblewrap` and `socat`; see [Set up Linux and WSL2](/docs/en/sandboxing#set-up-linux-and-wsl2). When the sandbox can't start, Claude Code shows a warning and runs commands unsandboxed unless you also set [`failIfUnavailable`](#sandbox-failifunavailable).

### `sandbox.failIfUnavailable`

Make Claude Code exit with an error at startup when `sandbox.enabled` is `true` but the sandbox can't start, because a dependency is missing or the platform is unsupported. Without it, Claude Code shows a warning and runs commands unsandboxed. Use it in managed settings when your organization requires sandboxing as a hard gate.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code exits with an error at startup when `sandbox.enabled` is `true` but the sandbox can't start
  * `false`: Claude Code shows a warning and runs commands unsandboxed
* **Default**: `false`

This makes every managed machine sandbox commands or refuse to start:

```json managed-settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true
  }
}
```

See [Enforce sandboxing with managed settings](/docs/en/sandboxing#enforce-sandboxing-with-managed-settings).

### `sandbox.autoAllowBashIfSandboxed`

Let Claude Code run sandboxed Bash commands without a permission prompt. Commands that can't run in the sandbox still go through the regular permission flow, and `deny` rules and content-scoped `ask` rules such as `Bash(git push *)` still apply; a bare `Bash` ask rule is skipped for sandboxed commands. Set it to `false` to send sandboxed commands through the regular permission flow too, which the `/sandbox` **Mode** tab calls regular permissions mode.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code runs sandboxed Bash commands without a permission prompt, subject to `deny` rules and content-scoped `ask` rules; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` turns auto-allow off
  * `false`: sandboxed commands go through the regular permission flow, so your allow rules and permission mode decide. The `/sandbox` **Mode** tab calls this regular permissions mode
* **Default**: `true`

This keeps the sandbox on and sends sandboxed commands through the regular permission flow:

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": false
  }
}
```

See [Sandbox modes](/docs/en/sandboxing#sandbox-modes) for what auto-allow mode still prompts on and how it behaves in plan mode.

### `sandbox.excludedCommands`

Name commands that Claude Code always runs outside the sandbox, such as tools that don't work under it. Each entry uses the same syntax as the content of a `Bash(...)` [permission rule](/docs/en/permissions#permission-rule-syntax): an exact command, a prefix such as `docker *`, or a wildcard pattern. When any part of a compound command matches an entry, Claude Code runs the whole command unsandboxed.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of command patterns
* **Default**: unset, so every command Claude Code can sandbox runs sandboxed

```json settings.json theme={null}
{
  "sandbox": {
    "excludedCommands": ["docker *"]
  }
}
```

Excluded commands still go through the regular permission flow. Exclusion is a convenience, not a security boundary: prefer [`filesystem.allowWrite`](#sandbox-filesystem-allowwrite) when a tool only needs to write somewhere specific. Claude Code merges entries across every settings file the session loads, and there is no managed-only lock for this list, so keep a managed list narrow.

### `sandbox.allowUnsandboxedCommands`

Let Claude retry a command outside the sandbox with the `dangerouslyDisableSandbox` parameter after the sandbox blocks it. Set it to `false` so Claude Code ignores that parameter completely and every command must run sandboxed or appear in [`excludedCommands`](#sandbox-excludedcommands), which the `/sandbox` **Overrides** tab shows as **Strict sandbox mode**. Use `false` in managed settings for policies that require strict sandboxing.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude can retry a command outside the sandbox with the `dangerouslyDisableSandbox` parameter after the sandbox blocks it
  * `false`: Claude Code ignores that parameter, so every command runs sandboxed or appears in `excludedCommands`
* **Default**: `true`

This enforces strict sandbox mode for everyone the managed settings cover:

```json managed-settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false
  }
}
```

An unsandboxed retry goes through the regular permission flow: a prompt in Manual mode, the classifier in auto mode. See [The unsandboxed retry escape hatch](/docs/en/sandboxing#the-unsandboxed-retry-escape-hatch).

### `sandbox.filesystem`

Control which paths sandboxed commands can read and write. By default they can write to the working directory, the session temp directory, and directories you add with `--add-dir`, `/add-dir`, or `permissions.additionalDirectories`, and can read the rest of the filesystem, including credential files. Widen or narrow that with the four path lists, or switch the filesystem layer off with `disabled`. See [Filesystem isolation](/docs/en/sandboxing#filesystem-isolation) for the default boundaries.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `allowWrite`, `denyWrite`, `denyRead`, and `allowRead` arrays, plus the `allowManagedReadPathsOnly` and `disabled` Booleans
* **Default**: unset, so the default read and write boundaries apply

This lets sandboxed commands write to a build directory and your kubeconfig, and hides your AWS credentials file:

```json settings.json theme={null}
{
  "sandbox": {
    "filesystem": {
      "allowWrite": ["/tmp/build", "~/.kube"],
      "denyRead": ["~/.aws/credentials"]
    }
  }
}
```

Claude Code enforces these lists at the OS sandbox boundary, so they apply to every subprocess a sandboxed command starts, such as `kubectl`, `terraform`, or `npm`, not only to Claude's file tools. Claude Code adds your [permission rules](/docs/en/sandboxing#permission-rules) to the same lists: `Edit` allow and deny rules to `allowWrite` and `denyWrite`, `Read` deny rules to `denyRead`, and `WebFetch(domain:...)` allow and deny rules to the [`network`](#sandbox-network) domain lists.

Unless a managed-only lock is set, Claude Code merges every list across the settings files the session loads. [`allowManagedReadPathsOnly`](#sandbox-filesystem-allowmanagedreadpathsonly) limits `allowRead` to entries from managed settings, and [`allowManagedDomainsOnly`](#sandbox-network-allowmanageddomainsonly) does the same for allowed domains.

[Configure sandboxing](/docs/en/sandboxing#configure-sandboxing) covers sources you exclude with `--setting-sources`. When you edit a list during a session, Claude Code [applies the change to the running session](/docs/en/settings#when-edits-take-effect).

#### Sandbox path prefixes

Paths in `allowWrite`, `denyWrite`, `denyRead`, `allowRead`, and [`credentials.files`](#sandbox-credentials-files) resolve by their prefix:

| Prefix            | Meaning                                                                                | Example                                                                   |
| :---------------- | :------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| `/`               | Absolute path from filesystem root                                                     | `/tmp/build` stays `/tmp/build`                                           |
| `~/`              | Relative to home directory                                                             | `~/.kube` becomes `$HOME/.kube`                                           |
| `./` or no prefix | Relative to the project root for project settings, or to `~/.claude` for user settings | `./output` in `.claude/settings.json` resolves to `<project-root>/output` |

The `//path` prefix for absolute paths also works. If you use single-slash `/path` expecting project-relative resolution, switch to `./path`. This syntax differs from [Read and Edit permission rules](/docs/en/permissions#read-and-edit), which use `//path` for absolute and `/path` for project-relative: sandbox filesystem paths use standard conventions, so `/tmp/build` is an absolute path.

Claude Code strips a trailing slash from a directory path, so `~/.aws` and `~/.aws/` match the same directory. Before v2.1.224, Claude Code passed the trailing slash through to the sandbox, and Claude could still read or write paths under a `denyRead` or `denyWrite` entry written with one.

Claude Code also removes a trailing `/**`, so `~/build/**` and `~/build` cover the same directory. Whether a wildcard such as `*` works depends on which list the entry is in and on the platform:

* **`allowWrite` and `denyWrite`**: on macOS, wildcards work. On Linux and WSL2, the sandbox mounts concrete paths, so Claude Code skips an entry that contains `*`, `?`, or `[` once the trailing `/**` is removed, and that entry has no effect. Claude Code adds the paths from your `Edit` permission rules to these lists, so the same limit applies to them, and the **Config** tab of `/sandbox` warns about `Edit` and `Read` permission rules that contain wildcards.
* **`denyRead` and `allowRead`**: wildcards work on every platform. On Linux and WSL2, Claude Code expands a read entry to the concrete paths it matches, which it doesn't do for the write lists.

### `sandbox.filesystem.allowWrite`

Add paths where sandboxed commands can write, beyond the working directory, the session temp directory, and the directories you've added with `--add-dir`, `/add-dir`, or `permissions.additionalDirectories`. Use it when a subprocess such as `kubectl` or a build tool needs to write outside the project.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of path strings, using the [sandbox path prefixes](#sandbox-path-prefixes)
* **Default**: unset, so sandboxed commands can write to the working directory, the session temp directory, directories you've added with `--add-dir` or `/add-dir`, and directories in [`permissions.additionalDirectories`](#permissions-additionaldirectories)

This lets a build write under `/tmp/build` and lets `kubectl` update your kubeconfig:

```json settings.json theme={null}
{
  "sandbox": {
    "filesystem": {
      "allowWrite": ["/tmp/build", "~/.kube"]
    }
  }
}
```

Claude Code merges entries across every settings file the session loads: user, project, local, and managed paths combine rather than replace each other, and Claude Code adds the paths from your `Edit(...)` allow permission rules. An `allowWrite` entry can't lift a [protected path](/docs/en/sandboxing#protected-paths).

### `sandbox.filesystem.denyWrite`

Block sandboxed commands from writing to specific paths, including paths inside a directory that is otherwise writable.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of path strings, using the [sandbox path prefixes](#sandbox-path-prefixes)
* **Default**: unset

This keeps sandboxed commands from changing system configuration or installing binaries:

```json settings.json theme={null}
{
  "sandbox": {
    "filesystem": {
      "denyWrite": ["/etc", "/usr/local/bin"]
    }
  }
}
```

Claude Code merges entries across every settings file the session loads, and adds the paths from your `Edit(...)` deny permission rules.

### `sandbox.filesystem.denyRead`

Block sandboxed commands from reading specific paths, such as credential files that the default read policy would otherwise expose. To protect a credential file and keep it usable through the sandbox proxy, see [`sandbox.credentials`](#sandbox-credentials) instead.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of path strings, using the [sandbox path prefixes](#sandbox-path-prefixes)
* **Default**: unset, so sandboxed commands keep the [default read access](/docs/en/sandboxing#filesystem-isolation), which includes credential files such as `~/.aws/credentials`

```json settings.json theme={null}
{
  "sandbox": {
    "filesystem": {
      "denyRead": ["~/.aws/credentials"]
    }
  }
}
```

Claude Code merges entries across every settings file the session loads, and adds the paths from your `Read(...)` deny permission rules. When [`filesystem.disabled`](#sandbox-filesystem-disabled) is `true`, Claude Code doesn't enforce these entries.

### `sandbox.filesystem.allowRead`

Re-open reading for specific paths inside a region that [`denyRead`](#sandbox-filesystem-denyread) blocks, to build workspace-only read access. An exact or wildcard `denyRead` entry stays blocked inside a broader `allowRead`, as the [overlap table](/docs/en/sandboxing#configure-sandboxing) shows. When a wildcard `denyRead` entry such as `~/**/.env` matches a directory, Claude Code blocks reads of its contents as well. Before v2.1.236 on macOS, Claude Code re-opened the paths a wildcard `denyRead` entry matched wherever a broader `allowRead` entry covered them, and left a matched directory's contents readable.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of path strings, using the [sandbox path prefixes](#sandbox-path-prefixes)
* **Default**: unset

This blocks reads of your home directory except the project itself:

```json settings.json theme={null}
{
  "sandbox": {
    "filesystem": {
      "denyRead": ["~/"],
      "allowRead": ["."]
    }
  }
}
```

Place a `.` entry in project settings: it resolves to the project root there and to `~/.claude` in user settings. Claude Code merges entries across every settings file the session loads unless [`allowManagedReadPathsOnly`](#sandbox-filesystem-allowmanagedreadpathsonly) is set.

### `sandbox.filesystem.allowManagedReadPathsOnly`

Honor only the [`allowRead`](#sandbox-filesystem-allowread) entries that come from managed settings, so developers can't re-open read access to paths your organization blocked. Claude Code still merges `denyRead` entries from every settings file the session loads.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code honors only the `allowRead` entries from managed settings
  * `false`: `allowRead` entries merge from every settings file the session loads
* **Default**: `false`

This blocks reads of the home directory, re-opens `~/work`, and stops developers from re-opening anything else:

```json managed-settings.json theme={null}
{
  "sandbox": {
    "filesystem": {
      "denyRead": ["~/"],
      "allowRead": ["~/work"],
      "allowManagedReadPathsOnly": true
    }
  }
}
```

See [Keep developers from widening the policy](/docs/en/sandboxing#keep-developers-from-widening-the-policy).

### `sandbox.filesystem.disabled`

Skip filesystem isolation while keeping network isolation. Sandboxed commands get unrestricted read and write access to the host filesystem, and their network egress stays confined to [`network.allowedDomains`](#sandbox-network-alloweddomains). Use it when you sandbox to control where commands connect rather than what they write. Requires Claude Code v2.1.216 or later.

* **Scope**: [`User or managed`](#scopes). When managed settings configure `sandbox.filesystem` at all, or list a `sandbox.credentials.files` entry with `"mode": "deny"`, only managed settings can set it.
* **Type**: Boolean
  * `true`: Claude Code skips filesystem isolation and keeps network isolation
  * `false`: filesystem isolation stays on
* **Default**: `false`, so filesystem isolation stays on

This leaves the filesystem open and confines network egress to GitHub and npm:

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "disabled": true
    },
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

With the layer off, Claude Code doesn't enforce `denyRead` or `credentials.files` `deny` entries, while `credentials.envVars` entries and applied `mask` entries keep working. [`autoAllowBashIfSandboxed`](#sandbox-autoallowbashifsandboxed) still defaults to `true`, so set it to `false` to keep prompting. See [Disable filesystem isolation](/docs/en/sandboxing#disable-filesystem-isolation) for the full list of sources that can set it and what changes when isolation is off. Requires Claude Code v2.1.216 or later.

### `sandbox.ignoreViolations`

Silence sandbox violation reports for paths you expect a command to probe and be refused, such as a tool that checks `/etc/hosts` on startup, so those denials don't show up as violations or in what Claude sees. The sandbox still blocks the access; only the report is suppressed. Keys are substrings to match against the command, with `*` matching every command, and values are substrings of the violation to ignore for that command, such as a filesystem path.

* **Scope**: [`Any file`](#scopes)
* **Type**: object mapping a command substring to an array of violation substrings, usually paths
* **Default**: unset, so every violation is reported

```json settings.json theme={null}
{
  "sandbox": {
    "ignoreViolations": {
      "*": ["/etc/hosts"]
    }
  }
}
```

### `sandbox.enableWeakerNestedSandbox`

Run the Linux sandbox inside an unprivileged Docker container, where bubblewrap can't mount a fresh `/proc`. Instead the inner sandbox bind-mounts the container's existing `/proc`, which exposes process information that a fresh mount would hide. This reduces security; use it only when the outer container already provides the isolation you need.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: the inner sandbox bind-mounts the container's existing `/proc` instead of mounting a fresh one
  * `false`: the sandbox mounts a fresh `/proc`, which doesn't work in an unprivileged Docker container
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "enableWeakerNestedSandbox": true
  }
}
```

Linux and WSL2 only. See [Bubblewrap fails to start inside a container](/docs/en/sandboxing#troubleshooting).

### `sandbox.enableWeakerNetworkIsolation`

Let sandboxed commands on macOS reach the system TLS trust service, `com.apple.trustd.agent`. Go-based tools such as `gh`, `gcloud`, and `terraform` need it to verify TLS certificates when you use [`network.httpProxyPort`](#sandbox-network-httpproxyport) with a MITM proxy and a custom CA. This reduces security by opening a potential data exfiltration path through the trust service.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: sandboxed commands on macOS can reach `com.apple.trustd.agent`
  * `false`: sandboxed commands on macOS can't reach the system TLS trust service
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "enableWeakerNetworkIsolation": true
  }
}
```

If you don't use a MITM proxy, list the failing tools in [`excludedCommands`](#sandbox-excludedcommands) instead; see [Go-based CLIs fail TLS verification on macOS](/docs/en/sandboxing#troubleshooting).

### `sandbox.allowAppleEvents`

Let sandboxed commands on macOS send Apple Events, which `open`, `osascript`, and tools that open URLs in a browser need; without it they fail with error `-600`. This removes code-execution isolation: sandboxed commands can launch other applications unsandboxed with no user prompt, and can send AppleScript commands to running applications such as Terminal, subject to the per-app macOS automation-consent prompt (TCC).

* **Scope**: [`User or managed`](#scopes)
* **Type**: Boolean
  * `true`: sandboxed commands on macOS can send Apple Events
  * `false`: sandboxed commands on macOS can't send Apple Events, so `open` and `osascript` fail with error `-600`
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "allowAppleEvents": true
  }
}
```

To keep isolation and still run one such tool, add it to [`excludedCommands`](#sandbox-excludedcommands) instead. See [Apple Events on macOS](/docs/en/sandboxing#security-limitations).

### `sandbox.ripgrep`

Point the sandbox at a ripgrep binary of your own instead of the one Claude Code uses, for example when your platform needs a differently built `rg`.

* **Scope**: [`User or managed`](#scopes)
* **Type**: object with `command`, the path to the ripgrep binary, and optional `args`, an array of arguments to prepend
* **Default**: unset, so the sandbox uses the same ripgrep binary as Claude Code. That is the bundled binary unless you set [`USE_BUILTIN_RIPGREP`](/docs/en/env-vars) to `0`

```json settings.json theme={null}
{
  "sandbox": {
    "ripgrep": {
      "command": "/usr/local/bin/rg"
    }
  }
}
```

### `sandbox.bwrapPath`

Point the sandbox at a bubblewrap binary installed outside `PATH`, such as a vendored copy on an air-gapped host. Claude Code uses the path both for the startup dependency check and when it wraps each sandboxed command.

* **Scope**: [`Managed`](#scopes). Claude Code reads it only from managed settings so that a user, project, or local file can't point the sandbox at a different binary.
* **Type**: string, an absolute path; Claude Code drops a relative path and falls back to `PATH` lookup
* **Default**: unset, so Claude Code finds `bwrap` on `PATH`

```json managed-settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "bwrapPath": "/opt/admin/bwrap"
  }
}
```

Linux and WSL2 only.

### `sandbox.socatPath`

Point the sandbox network proxy at a `socat` binary installed outside `PATH`.

* **Scope**: [`Managed`](#scopes)
* **Type**: string, an absolute path; Claude Code drops a relative path and falls back to `PATH` lookup
* **Default**: unset, so Claude Code finds `socat` on `PATH`

```json managed-settings.json theme={null}
{
  "sandbox": {
    "enabled": true,
    "socatPath": "/opt/admin/socat"
  }
}
```

Linux and WSL2 only.

### `sandbox.credentials`

Declare the credential files and environment variables to [protect from sandboxed commands](/docs/en/sandboxing#protect-credentials). Each entry names a file `path` or a variable `name` and a `mode`: `deny` hides the credential inside the sandbox, and `mask` shows sandboxed commands a placeholder while the [sandbox proxy](/docs/en/sandboxing#mask-credentials) substitutes the real value on outbound requests. Claude Code protects only the entries you list; there is no built-in credential deny list. Requires Claude Code v2.1.187 or later.

* **Scope**: [`Any file`](#scopes). Claude Code honors `mask` entries, `allowPlaintextInject`, `awsPairs`, and `sigv4` only from user settings, managed settings, and the `--settings` flag.
* **Type**: object with `files`, `envVars`, `allowPlaintextInject`, `awsPairs`, and `sigv4`
* **Default**: unset, so no credentials are protected

This hides your AWS credentials file and removes `GITHUB_TOKEN` from sandboxed commands:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "files": [{ "path": "~/.aws/credentials", "mode": "deny" }],
      "envVars": [{ "name": "GITHUB_TOKEN", "mode": "deny" }]
    }
  }
}
```

The `deny` file protection is part of the filesystem layer, so it doesn't apply when you [disable filesystem isolation](/docs/en/sandboxing#disable-filesystem-isolation); the environment variable protection still does. Requires Claude Code v2.1.187 or later.

#### Invalid credential entries in managed settings

When a managed `sandbox.credentials` entry fails validation, Claude Code keeps protecting the credential where it can:

* An entry in `files` or `envVars` that still has a valid `path` or `name` and a `mode` of `mask` or `deny`, such as one whose `extract` pattern has no capturing group, is degraded to `mode: "deny"` with a warning, so the credential stays blocked, not masked, until you fix the entry. A degraded `files` entry pins [`filesystem.disabled`](/docs/en/sandboxing#disable-filesystem-isolation) like an explicit `deny` entry, and the warning notes that its read block isn't enforced if managed settings turn filesystem isolation off.
* An entry with an unknown `mode` or an invalid `path` or `name` is stripped.
* Each case warns; whether an entry is degraded or stripped, the remaining valid entries are still enforced, and a wholly invalid `credentials` value is dropped while the rest of `sandbox` still applies.

Applies in v2.1.191 and later; before v2.1.221, every invalid entry was stripped. For the other managed keys with per-field handling, see [Invalid entries in managed settings](/docs/en/managed-settings#invalid-entries-in-managed-settings).

### `sandbox.credentials.files`

Protect credential files or directories from sandboxed commands. With `"mode": "deny"`, Claude Code blocks reads of the path inside the sandbox, the same read block as [`sandbox.filesystem.denyRead`](#sandbox-filesystem-denyread). With `"mode": "mask"`, sandboxed commands on Linux and WSL2 read a sentinel copy of the file, and the sandbox proxy substitutes the real value on outbound requests to that entry's `injectHosts`; on macOS the file is unreadable inside the sandbox instead. Requires Claude Code v2.1.187 or later, and `"mode": "mask"` requires v2.1.221 or later.

* **Scope**: [`Any file`](#scopes). Claude Code drops `mask` entries from project `.claude/settings.json` and local `.claude/settings.local.json`.
* **Type**: array of objects, each with `path` and a `mode` of `"deny"` or `"mask"`, plus the optional [mask fields for files](#mask-fields-for-files)
* **Default**: unset, so no credential files are protected

This hides your AWS credentials file and masks the `gh` hosts file, substituting the real value only on requests to `api.github.com`:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "files": [
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.config/gh/hosts.yml", "mode": "mask", "injectHosts": ["api.github.com"] }
      ]
    }
  }
}
```

Paths use the same [prefixes](#sandbox-path-prefixes) as the `sandbox.filesystem.*` settings, and Claude Code merges the arrays from every settings scope the session loads. [Protect credentials](/docs/en/sandboxing#protect-credentials) covers what still applies from sources you exclude with `--setting-sources`. Requires Claude Code v2.1.187 or later; `mask` entries require v2.1.221 or later.

`mask` substitution runs only through the sandbox proxy, so set [`sandbox.network.tlsTerminate`](#sandbox-network-tlsterminate), or [`allowPlaintextInject`](#sandbox-credentials-allowplaintextinject) for plain-HTTP test networks. `mask` applies to a single file, so list each credential file individually. Claude Code accepts but ignores the `mask` fields on a `deny` entry. [Mask credential files](/docs/en/sandboxing#mask-credential-files) covers which settings sources are honored and when an entry falls back to `deny`.

<span id="sandbox-credentials-files-extract" />

<span id="sandbox-credentials-files-onextractnomatch" />

<span id="sandbox-credentials-files-decode" />

<span id="sandbox-credentials-files-maskclaims" />

<span id="sandbox-credentials-files-maskduplicates" />

<span id="sandbox-credentials-files-injecthosts" />

#### Mask fields for files

A `mask` entry accepts these optional fields. Without `extract` or `decode`, Claude Code replaces the entire file content with one sentinel. On macOS with filesystem isolation on, Claude Code applies a `mask` entry as `deny` before `extract` or `decode` runs; see [Mask credential files](/docs/en/sandboxing#mask-credential-files).

| Field              | Type                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :----------------- | :----------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extract`          | string, a regular expression with at least one capturing group                                                     | Mask only the text captured by group 1 of each match, so the rest of the file stays parseable. With `decode` also set, Claude Code checks each capture as a possible JWT instead of replacing it outright. Requires v2.1.221 or later                                                                                                                                                                                                                                                                                                                               |
| `onExtractNoMatch` | `"warn"`, `"deny"`, or `"error"`; default `"warn"`                                                                 | What happens when `extract` or `decode` finds nothing to mask. `warn` leaves the file readable as-is inside the sandbox, `deny` makes it unreadable, and `error` stops sandbox setup until you fix the configuration. Claude Code treats `deny` as `error` when the read block wouldn't be enforced, because you [disable filesystem isolation](/docs/en/sandboxing#disable-filesystem-isolation) or a [`sandbox.filesystem.allowRead`](#sandbox-filesystem-allowread) entry re-opens the path. Requires v2.1.221 or later; the `decode` case requires v2.1.224 or later |
| `decode`           | the string `"jwt"`                                                                                                 | Find JSON Web Tokens (JWTs) in the file, with a built-in pattern or with `extract` when set, verify each candidate, and replace it with a structurally valid fake token, so code inside the sandbox that decodes the token keeps working. When no candidate verifies, `onExtractNoMatch` governs the outcome. Requires v2.1.224 or later                                                                                                                                                                                                                            |
| `maskClaims`       | array of strings, at least one claim name; requires `decode`                                                       | Mask only the named top-level payload claims inside each verified JWT and rebuild the token around the modified payload, so the other claims stay readable. When no named claim matches, `onExtractNoMatch` governs the outcome. Requires v2.1.224 or later                                                                                                                                                                                                                                                                                                         |
| `maskDuplicates`   | Boolean, default `false`                                                                                           | Also replace verbatim copies of each masked value elsewhere in the file, such as a secret pasted into a comment. Claude Code matches raw substrings, so reserve it for long, high-entropy secrets. Consulted only when `extract` or `decode` is set. Requires v2.1.221 or later                                                                                                                                                                                                                                                                                     |
| `injectHosts`      | array of strings, each a host that [`sandbox.network.allowedDomains`](#sandbox-network-alloweddomains) also admits | Narrow the hosts where the sandbox proxy substitutes the real value. When unset, the proxy substitutes it on requests to every host in `sandbox.network.allowedDomains`. Requires v2.1.221 or later                                                                                                                                                                                                                                                                                                                                                                 |

This masks only the `oauth_token` value in the `gh` hosts file, replaces every other copy of it in the file, makes the file unreadable if the pattern matches nothing, and substitutes the real token only on requests to `api.github.com`:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "files": [
        {
          "path": "~/.config/gh/hosts.yml",
          "mode": "mask",
          "extract": "oauth_token:\\s*(\\S+)",
          "maskDuplicates": true,
          "onExtractNoMatch": "deny",
          "injectHosts": ["api.github.com"]
        }
      ]
    }
  }
}
```

### `sandbox.credentials.envVars`

Protect environment variables from sandboxed commands. With `"mode": "deny"`, Claude Code removes the variable from the environment of sandboxed commands. With `"mode": "mask"`, sandboxed commands see a per-session sentinel value, and the sandbox proxy substitutes the real value on outbound requests to that entry's `injectHosts`, so tools such as `gh` and `npm` keep authenticating without ever holding the real credential. Requires Claude Code v2.1.187 or later, and `"mode": "mask"` requires v2.1.199 or later.

* **Scope**: [`Any file`](#scopes). Claude Code drops `mask` entries from project `.claude/settings.json` and local `.claude/settings.local.json`.
* **Type**: array of objects, each with `name` and a `mode` of `"deny"` or `"mask"`, plus the optional [mask fields for environment variables](#mask-fields-for-environment-variables)
* **Default**: unset, so no environment variables are protected

This removes `NPM_TOKEN` from sandboxed commands and masks `GITHUB_TOKEN`, substituting the real value only on requests to `api.github.com`:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "envVars": [
        { "name": "NPM_TOKEN", "mode": "deny" },
        { "name": "GITHUB_TOKEN", "mode": "mask", "injectHosts": ["api.github.com"] }
      ]
    }
  }
}
```

The `name` must start with a letter or underscore and contain only letters, digits, and underscores. Claude Code merges the arrays from every settings scope the session loads, and applies `deny` when the same variable appears with both modes. [Protect credentials](/docs/en/sandboxing#protect-credentials) covers what still applies from sources you exclude with `--setting-sources`. Requires Claude Code v2.1.187 or later; `mask` entries require v2.1.199 or later.

`mask` substitution runs only through the sandbox proxy, so set [`sandbox.network.tlsTerminate`](#sandbox-network-tlsterminate), or [`allowPlaintextInject`](#sandbox-credentials-allowplaintextinject) for plain-HTTP test networks; see [Mask environment variables](/docs/en/sandboxing#mask-environment-variables). Claude Code accepts but ignores the `mask` fields on a `deny` entry.

<span id="sandbox-credentials-envvars-extract" />

<span id="sandbox-credentials-envvars-onextractnomatch" />

<span id="sandbox-credentials-envvars-decode" />

<span id="sandbox-credentials-envvars-maskclaims" />

<span id="sandbox-credentials-envvars-injecthosts" />

#### Mask fields for environment variables

A `mask` entry accepts these optional fields. Without `extract` or `decode`, Claude Code replaces the entire value with one sentinel. `extract` and `decode` can't be combined on the same entry.

| Field              | Type                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                      |
| :----------------- | :----------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extract`          | string, a regular expression with at least one capturing group                                                     | Mask only the text captured by group 1 of each match, such as the password inside a `DATABASE_URL` connection string, so the rest of the value stays parseable. Requires v2.1.224 or later                                                                                                                                                                                                        |
| `onExtractNoMatch` | `"warn"`, `"deny"`, or `"error"`; default `"warn"`. On an entry with `decode`, only `"warn"` is accepted           | What happens when `extract` matches nothing. `warn` passes the variable through unmasked, `deny` unsets it inside the sandbox, and `error` stops sandbox setup until you fix the configuration. Requires v2.1.224 or later                                                                                                                                                                        |
| `decode`           | the string `"jwt"`                                                                                                 | Verify the whole value is a JWT and replace it with a structurally valid fake token, so code inside the sandbox that decodes the token keeps working; the proxy substitutes the whole real token on egress. A value that doesn't verify passes through unmasked with a warning. Requires v2.1.224 or later                                                                                        |
| `maskClaims`       | array of strings, at least one claim name; requires `decode`                                                       | Mask only the named top-level payload claims inside the decoded JWT and rebuild the token around the modified payload, so the other claims stay readable. When no named claim matches, the variable passes through unmasked with a warning. Requires v2.1.224 or later                                                                                                                            |
| `injectHosts`      | array of strings, each a host that [`sandbox.network.allowedDomains`](#sandbox-network-alloweddomains) also admits | Narrow the hosts where the sandbox proxy substitutes the real value. When unset, the proxy substitutes it on requests to every host in `sandbox.network.allowedDomains`. Write an IPv6 destination as the bare compressed address, such as `"::1"`, not the bracketed form; see [IPv6 destinations in `injectHosts`](/docs/en/sandboxing#ipv6-destinations-in-injecthosts). Requires v2.1.199 or later |

This masks only the password inside `DATABASE_URL`, unsets the variable if the pattern matches nothing, and masks a JWT in `SERVICE_JWT` while leaving every claim except `api_key` readable:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "envVars": [
        {
          "name": "DATABASE_URL",
          "mode": "mask",
          "extract": "://[^:]+:([^@]+)@",
          "onExtractNoMatch": "deny"
        },
        {
          "name": "SERVICE_JWT",
          "mode": "mask",
          "decode": "jwt",
          "maskClaims": ["api_key"]
        }
      ]
    }
  }
}
```

### `sandbox.credentials.allowPlaintextInject`

Allow `mask` substitution on plain HTTP requests as well as TLS-terminated HTTPS. On plain HTTP the upstream identity is unverified and the credential travels in cleartext, so leave this off outside trusted test networks. Requires Claude Code v2.1.199 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code allows `mask` substitution on plain HTTP requests as well as TLS-terminated HTTPS
  * `false`: Claude Code allows `mask` substitution only on TLS-terminated HTTPS
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "allowPlaintextInject": true
    }
  }
}
```

Requires Claude Code v2.1.199 or later.

### `sandbox.credentials.awsPairs`

Group masked environment variables that form one AWS credential for [SigV4 re-signing](/docs/en/sandboxing#re-sign-aws-requests) when your credential lives in variables with non-standard names. Claude Code links the conventional `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` trio automatically when you mask their whole values, so you need this key only for other names. Requires Claude Code v2.1.224 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: array of objects, each with `accessKeyIdVar`, `secretAccessKeyVar`, and optionally `sessionTokenVar`, naming `sandbox.credentials.envVars` entries
* **Default**: unset, so only the conventional trio is paired

This links three custom-named variables into one AWS credential for re-signing:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "awsPairs": [
        {
          "accessKeyIdVar": "MY_KEY_ID",
          "secretAccessKeyVar": "MY_SECRET_KEY",
          "sessionTokenVar": "MY_SESSION_TOKEN"
        }
      ]
    }
  }
}
```

Each named variable must be a whole-value `mask` entry in [`sandbox.credentials.envVars`](#sandbox-credentials-envvars), without `extract` or `decode`, and can fill only one slot across all pairs.

### `sandbox.credentials.sigv4`

Choose what the sandbox proxy does with AWS request forms it [can't re-sign](/docs/en/sandboxing#re-sign-aws-requests): `streaming` for aws-chunked streaming uploads, `presigned` for presigned URLs, and `sigv4a` for SigV4A asymmetric signatures. This applies only to requests signed with a masked pair's placeholder access key ID. Requires Claude Code v2.1.224 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: object with `streaming`, `presigned`, and `sigv4a`, each one of:
  * `"deny"`: the proxy fails the request
  * `"passthrough"`: the proxy forwards the request signed with the masked placeholder, so the tool receives AWS's own rejection
* **Default**: unset, so every form is `"deny"`

This forwards streaming uploads instead of failing them at the proxy:

```json settings.json theme={null}
{
  "sandbox": {
    "credentials": {
      "sigv4": {
        "streaming": "passthrough"
      }
    }
  }
}
```

With `deny`, the proxy fails the request. With `passthrough`, the proxy forwards the request with its signature computed from the masked placeholder, so AWS rejects it and the calling tool receives AWS's own response instead of a proxy error.

### `sandbox.network`

Control which hosts, ports, and sockets sandboxed commands can reach. The sandbox routes outbound traffic through a proxy that enforces these lists; see [Network isolation](/docs/en/sandboxing#network-isolation) for how the proxy decides and when it prompts.

* **Scope**: [`Any file`](#scopes). `strictAllowlist`, `allowManagedDomainsOnly`, and `tlsTerminate` are read from fewer sources, as their entries say.
* **Type**: object with the sub-keys below
* **Default**: unset, so no domains are pre-allowed and the sandbox prompts for each new host

This pre-allows GitHub and npm, blocks `uploads.github.com`, and lets commands bind to localhost:

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"],
      "deniedDomains": ["uploads.github.com"],
      "allowLocalBinding": true
    }
  }
}
```

Claude Code merges the array sub-keys across settings scopes and deduplicates them, so a project can add domains to your user list. `WebFetch(domain:...)` allow and deny [permission rules](/docs/en/sandboxing#permission-rules) feed the same allow and deny lists.

### `sandbox.network.allowUnixSockets`

List the Unix socket paths sandboxed commands can connect to on macOS. Claude Code ignores this list on Linux and WSL2, where the seccomp filter can't inspect socket paths; use [`allowAllUnixSockets`](#sandbox-network-allowallunixsockets) there instead.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, each a socket path
* **Default**: unset, so the macOS sandbox blocks every Unix socket

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowUnixSockets": ["~/.ssh/agent-socket"]
    }
  }
}
```

A socket path can grant broad access: allowing `/var/run/docker.sock`, for example, lets a sandboxed command control the Docker daemon. See [Security limitations](/docs/en/sandboxing#security-limitations).

### `sandbox.network.allowAllUnixSockets`

Let sandboxed commands connect to every Unix socket. On Linux and WSL2, the sandbox's [seccomp filter](/docs/en/sandboxing#set-up-linux-and-wsl2) blocks `socket(AF_UNIX, ...)` calls, so this is the only way to permit Unix sockets there. When the filter is missing, which `/sandbox` reports on its Dependencies tab, the sandbox doesn't block Unix-socket calls. See [Set up Linux and WSL2](/docs/en/sandboxing#set-up-linux-and-wsl2) for where the filter comes from.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: sandboxed commands can connect to every Unix socket
  * `false`: the sandbox blocks Unix-socket connections: on macOS except the paths in `allowUnixSockets`, and on Linux and WSL2 through the seccomp filter when it's present
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowAllUnixSockets": true
    }
  }
}
```

On WSL2, `true` also reopens the interop socket that launches Windows binaries such as `cmd.exe` and `powershell.exe`.

### `sandbox.network.allowLocalBinding`

Let sandboxed commands bind to localhost ports on macOS, for example to start a dev server.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: sandboxed commands can bind to localhost ports on macOS
  * `false`: sandboxed commands on macOS can't bind to localhost ports
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowLocalBinding": true
    }
  }
}
```

### `sandbox.network.allowMachLookup`

List additional XPC and Mach service names the macOS sandbox may look up. Tools that communicate over XPC, such as the iOS Simulator or Playwright, need their services listed here.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, each a service name; a single trailing `*` matches a prefix, and `"*"` alone matches every service
* **Default**: unset

This allows every service under the `com.apple.coresimulator.` prefix:

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowMachLookup": ["com.apple.coresimulator.*"]
    }
  }
}
```

### `sandbox.network.allowedDomains`

Pre-allow domains for outbound traffic from sandboxed commands, so the sandbox doesn't prompt for them. Wildcards such as `*.example.com` match subdomains, and an optional `:port` suffix limits an entry to one port; an entry without a port matches every port.

* **Scope**: [`Any file`](#scopes). Only managed settings when [`allowManagedDomainsOnly`](#sandbox-network-allowmanageddomainsonly) is set.
* **Type**: array of strings, each a domain, wildcard pattern, or IP literal, with an optional `:port` suffix
* **Default**: unset, so the sandbox prompts the first time a command reaches a new host

This pre-allows GitHub on every port, every npm subdomain, and one API host on port 443 only:

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org", "api.example.com:443"]
    }
  }
}
```

Write IPv6 literals bracketed, with an optional port: `"[::1]"` allows every port and `"[::1]:443"` one port. The bracketed form requires Claude Code v2.1.229 or later. See [IPv6 addresses in domain lists](/docs/en/sandboxing#ipv6-addresses-in-domain-lists).

### `sandbox.network.deniedDomains`

Block domains for outbound traffic from sandboxed commands, using the same wildcard, port, and IPv6 syntax as [`allowedDomains`](#sandbox-network-alloweddomains). A denied domain stays blocked even when an `allowedDomains` entry matches it too.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, each a domain, wildcard pattern, or IP literal, with an optional `:port` suffix
* **Default**: unset

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "deniedDomains": ["sensitive.cloud.example.com"]
    }
  }
}
```

Claude Code merges this list from every settings source the session loads even when `allowManagedDomainsOnly` is set, so a developer can always tighten the deny list. For IPv6 literals, see [IPv6 addresses in domain lists](/docs/en/sandboxing#ipv6-addresses-in-domain-lists).

### `sandbox.network.strictAllowlist`

Deny sandboxed commands access to hosts outside the allowlist instead of prompting for approval. The allowlist is [`allowedDomains`](#sandbox-network-alloweddomains) plus domains from `WebFetch(domain:...)` allow rules, or only the managed settings entries when [`allowManagedDomainsOnly`](#sandbox-network-allowmanageddomainsonly) is set. Requires Claude Code v2.1.219 or later.

* **Scope**: [`User or managed`](#scopes). A repository can't turn it on or off.
* **Type**: Boolean
  * `true`: Claude Code denies sandboxed commands access to hosts outside the allowlist
  * `false`: unless another trusted settings file sets `true`, Claude Code decides a host outside the allowlist by permission mode instead of denying it outright: it runs the classifier in auto mode, denies in `dontAsk` mode, allows in `bypassPermissions` mode and in plan mode when bypass is available, and otherwise asks you
* **Default**: `false`

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "strictAllowlist": true
    }
  }
}
```

Claude Code enforces this for sandboxed commands only; in-process tools such as `WebFetch` still follow their [permission rules](/docs/en/sandboxing#permission-rules). When any of the honored sources sets it to `true`, it stays on. See [Network isolation](/docs/en/sandboxing#network-isolation). Requires Claude Code v2.1.219 or later.

### `sandbox.network.allowManagedDomainsOnly`

Lock the network allowlist to what managed settings define. Claude Code then honors only `allowedDomains` and `WebFetch(domain:...)` allow rules from managed settings, ignores domains from user, project, local, and `--settings` settings, and blocks a non-allowed domain automatically instead of prompting.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code honors only `allowedDomains` and `WebFetch(domain:...)` allow rules from managed settings and blocks a non-allowed domain instead of prompting
  * `false`: domains from user, project, local, and `--settings` settings merge into the allowlist
* **Default**: `false`

This locks the allowlist to GitHub and npm and ignores any domains developers add:

```json managed-settings.json theme={null}
{
  "sandbox": {
    "network": {
      "allowManagedDomainsOnly": true,
      "allowedDomains": ["github.com", "*.npmjs.org"]
    }
  }
}
```

Denied domains still merge from every source the session loads. See [Keep developers from widening the policy](/docs/en/sandboxing#keep-developers-from-widening-the-policy).

### `sandbox.network.httpProxyPort`

Point the sandbox at your own HTTP proxy instead of the one Claude Code runs. Organizations do this to inspect HTTPS traffic, apply their own filtering rules, or log every request. When unset, Claude Code starts its own proxy for HTTP traffic.

* **Scope**: [`Any file`](#scopes)
* **Type**: number, a local TCP port
* **Default**: unset, so Claude Code runs its own proxy

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "httpProxyPort": 8080
    }
  }
}
```

Set [`socksProxyPort`](#sandbox-network-socksproxyport) too if your proxy should carry SOCKS traffic as well; with only one of the two set, Claude Code still runs its own proxy for the other protocol. See [Custom proxy configuration](/docs/en/sandboxing#custom-proxy-configuration).

### `sandbox.network.socksProxyPort`

Point the sandbox at your own SOCKS5 proxy instead of the one Claude Code runs. When unset, Claude Code starts its own proxy for SOCKS traffic.

* **Scope**: [`Any file`](#scopes)
* **Type**: number, a local TCP port
* **Default**: unset, so Claude Code runs its own proxy

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "socksProxyPort": 8081
    }
  }
}
```

See [Custom proxy configuration](/docs/en/sandboxing#custom-proxy-configuration).

### `sandbox.network.tlsTerminate`

Make the sandbox proxy terminate TLS so it can read the contents of HTTPS requests. This is experimental, and `mask` [credential substitution](/docs/en/sandboxing#mask-credentials) requires it. Set `{}` to generate an ephemeral certificate authority for the session, or set `caCertPath` and `caKeyPath` to use your own.

* **Scope**: [`User or managed`](#scopes). A repository can't switch it on or supply a certificate authority.
* **Type**: object with optional `caCertPath` and `caKeyPath` strings, each a file path
* **Default**: unset, so the proxy doesn't terminate or inspect TLS

```json settings.json theme={null}
{
  "sandbox": {
    "network": {
      "tlsTerminate": {}
    }
  }
}
```

When more than one honored source sets it, Claude Code uses the value from the highest-precedence source: managed settings, then the `--settings` flag, then user settings. Requires Claude Code v2.1.199 or later.

<span id="context-and-memory" />

## Memory and context

Control what Claude Code loads into context, how it compacts, and where it keeps memory and plans. See [Manage context](/docs/en/context-window) and [Memory](/docs/en/memory).

### `autoCompactEnabled`

Have Claude Code [compact the conversation automatically](/docs/en/context-window#when-your-context-fills-up) when context approaches the limit. Appears in `/config` as **Auto-compact**, and toggling it there writes this key to your user settings.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code compacts the conversation automatically when context approaches the limit
  * `false`: Claude Code doesn't compact automatically
* **Default**: `true`
* **Per-session overrides**: [`DISABLE_AUTO_COMPACT`](/docs/en/env-vars) turns auto-compact off for one session; whichever of the two turns it off, the other can't turn it back on

```json settings.json theme={null}
{
  "autoCompactEnabled": false
}
```

The manual `/compact` command keeps working while auto-compact is off.

### `autoCompactWindow`

Set how full the context window gets before Claude Code [compacts automatically](/docs/en/context-window#when-your-context-fills-up).

* **Scope**: [`Any file`](#scopes)
* **Type**: number of tokens, from `100000` to `1000000`. Claude Code caps the value at your model's context window; the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview) lists each model's window
* **Default**: unset, so Claude Code picks a window tuned for your model
* **Per-session overrides**: [`--autocompact`](/docs/en/cli-reference#cli-flags) takes precedence over this key for one session, and [`CLAUDE_CODE_AUTO_COMPACT_WINDOW`](/docs/en/env-vars) takes precedence over both

```json settings.json theme={null}
{
  "autoCompactWindow": 500000
}
```

Set it with the [`/autocompact`](/docs/en/commands#all-commands) command, which writes this key to your user settings. [Set the auto-compact window](/docs/en/model-config#set-the-auto-compact-window) covers how the command, flag, variable, and setting interact.

### `autoMemoryDirectory`

Store [auto memory](/docs/en/memory#storage-location) in a directory of your choice instead of the per-project default.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, an absolute or `~/`-prefixed directory path
* **Default**: unset, so Claude Code uses `~/.claude/projects/<project>/memory/`

```json settings.json theme={null}
{
  "autoMemoryDirectory": "~/my-memory-dir"
}
```

From project or local settings, Claude Code honors this key under the same [workspace trust rule as hooks](/docs/en/permissions#what-runs-before-you-trust-a-folder), since a cloned repository can supply those files.

### `autoMemoryEnabled`

Turn [auto memory](/docs/en/memory#enable-or-disable-auto-memory) on or off. When `false`, Claude doesn't read from or write to the auto memory directory. You can also toggle it with `/memory` during a session, which writes this key to your user settings.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: the same as unset; auto memory stays on unless something that outranks this key turns it off for the session, such as `--bare`, safe mode, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
  * `false`: Claude doesn't read from or write to the auto memory directory
* **Default**: `true`
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_AUTO_MEMORY`](/docs/en/env-vars) takes precedence over this key for one session, in either direction

```json settings.json theme={null}
{
  "autoMemoryEnabled": false
}
```

### `claudeMd`

Inject CLAUDE.md-style instructions as organization-managed memory without deploying a separate file. Claude Code loads the text as a managed memory entry ahead of user and project CLAUDE.md files.

* **Scope**: [`Managed`](#scopes)
* **Type**: string, the text of a CLAUDE.md file; write it as you would the file, Markdown included, with line breaks as `\n`
* **Default**: unset

This example deploys two rules as a short Markdown list:

```json managed-settings.json theme={null}
{
  "claudeMd": "# Engineering rules\n\n- Always run make lint before committing.\n- Never push directly to main."
}
```

See [Deploy organization-wide CLAUDE.md](/docs/en/memory#deploy-organization-wide-claude-md).

### `claudeMdExcludes`

Skip specific `CLAUDE.md` files when Claude Code loads [memory](/docs/en/memory#exclude-specific-claude-md-files). In a large monorepo, use it to skip CLAUDE.md files from other teams that aren't relevant to your work; [Exclude irrelevant CLAUDE.md files](/docs/en/large-codebases#exclude-irrelevant-claude-md-files) in the large-codebases guide walks through that case. Patterns match against absolute file paths.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, each a glob pattern or absolute path
* **Default**: unset, so Claude Code loads every CLAUDE.md it finds

```json settings.json theme={null}
{
  "claudeMdExcludes": ["**/vendor/**/CLAUDE.md"]
}
```

Exclusions apply only to user, project, and local memory files; managed policy CLAUDE.md files can't be excluded.

<span id="environment-variables" />

### `env`

Set environment variables for every session and for the subprocesses Claude Code starts from it. Any variable in the [environment variables reference](/docs/en/env-vars) can go here, which is how you apply one to every session or roll it out to your team.

* **Scope**: [`Any file`](#scopes)
* **Type**: object mapping variable names to string values
* **Default**: unset

This example turns off automatic compaction and routes API requests through a proxy:

```json settings.json theme={null}
{
  "env": {
    "DISABLE_AUTO_COMPACT": "1",
    "ANTHROPIC_BASE_URL": "https://proxy.example.com"
  }
}
```

#### How `env` values interact with your shell

* A value here overwrites the same variable exported in your shell, and when more than one settings file sets a variable, the [highest-precedence](/docs/en/settings#settings-precedence) one applies.
* To cancel a shell export, set the variable to `""`. Claude Code treats an empty value as unset for provider selection, and subprocesses inherit the empty value.
* `NO_COLOR` and `FORCE_COLOR` set here reach only subprocesses. To change Claude Code's own interface colors, set them in your shell before launching `claude`.
* Values here are plain text in the settings file and reach every subprocess Claude Code starts. For an OTLP bearer token that rotates, use [`otelHeadersHelper`](#otelheadershelper); for API credentials, use [`apiKeyHelper`](#apikeyhelper).

#### When Claude Code applies `env` values

* From user settings, `--settings`, and managed settings: at startup, and again in the running session when a saved change alters the merged `env`.
* From project and local settings: after you trust the workspace, or at startup in `-p` mode, which never shows the trust dialog, and again when a saved change alters the merged `env`.
* Variables Claude Code classifies as safe, such as model selection, timeouts and limits, feature toggles, and telemetry settings: at startup from every settings file.
* After you [move the session with `/cd`](/docs/en/permissions#move-the-session-to-another-directory) on v2.1.246 or later: the new directory's project and local `env` values, on top of the previous directory's.

#### Variables Claude Code ignores in `env`

* Project and local settings can't set a few variables, such as `CLAUDE_CODE_PROCESS_WRAPPER`, `CLAUDE_CODE_SYNC_SKILLS`, `CLAUDE_CODE_SYNC_PLUGINS`, `CLAUDE_CODE_PLUGIN_CACHE_DIR`, and `CLAUDE_CODE_PLUGIN_SEED_DIR`; set those in user or managed settings.
* Identity variables that Claude Code's hosting environments own, such as `CLAUDE_CODE_REMOTE` and `CLAUDE_CODE_ACCOUNT_UUID`, are ignored from every file.
* [`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`](/docs/en/env-vars#variables), which Claude Code exports itself, are ignored from every file. Ignoring the socket variable requires Claude Code v2.1.224 or later, and ignoring the token requires v2.1.228 or later.
* [`CLAUDE_CODE_PROJECT_DIR_NAME`](/docs/en/sessions#name-the-project-directory-yourself), which Claude Code reads from the launch environment only, is ignored from every file; requires v2.1.234 or later.
* [`CLAUDE_CODE_RESTRICTED`](/docs/en/env-vars#variables), which Claude Code reads from the launch environment only, is ignored from every file.

### `fileCheckpointingEnabled`

Have Claude Code snapshot files before each edit so [`/rewind`](/docs/en/checkpointing) can restore them. Appears in `/config` as **Rewind code (checkpoints)**, and toggling it there writes this key to your user settings.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code snapshots files before each edit so `/rewind` can restore them
  * `false`: Claude Code doesn't snapshot files, so `/rewind` can't restore them
* **Default**: `true`
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`](/docs/en/env-vars) turns checkpointing off for one session; whichever of the two turns it off, the other can't turn it back on

```json settings.json theme={null}
{
  "fileCheckpointingEnabled": false
}
```

In a `-p` run or an Agent SDK session, Claude Code ignores this key. The SDK turns checkpointing on with its `enableFileCheckpointing` option, and a bare `-p` run needs `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`. See [File checkpointing in the Agent SDK](/docs/en/agent-sdk/file-checkpointing).

### `plansDirectory`

Choose where Claude Code stores the plan files it writes in [plan mode](/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode). Claude Code resolves the path relative to the project root and keeps the default when the path resolves outside it.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a path relative to the project root
* **Default**: unset, so Claude Code uses `~/.claude/plans`

```json settings.json theme={null}
{
  "plansDirectory": "./plans"
}
```

### `skillListingBudgetFraction`

Each turn, Claude sees a [listing of your skills](/docs/en/skills#skill-descriptions-are-cut-short) with their descriptions, and Claude Code caps that listing at a share of the context window. When the listing is over the cap, Claude Code keeps every skill's name but drops the descriptions of the least-used skills, so Claude can still invoke those skills but is less likely to choose one on its own. Raise this key to keep more descriptions visible at the cost of more context per turn.

* **Scope**: [`Any file`](#scopes)
* **Type**: number, a fraction greater than `0` and at most `1`
* **Default**: `0.01`, which reserves 1% of the context window

```json settings.json theme={null}
{
  "skillListingBudgetFraction": 0.02
}
```

To see how much context the listing uses and which skills contribute most, run `/doctor`.

### `skillListingMaxDescChars`

Each turn, Claude sees a [listing of your skills](/docs/en/skills#skill-descriptions-are-cut-short) that shows each skill's `description` and `when_to_use` text. This key caps how many characters of that text Claude Code shows per skill; longer text is cut at the cap.

* **Scope**: [`Any file`](#scopes)
* **Type**: number of characters, a positive integer
* **Default**: `1536`

```json settings.json theme={null}
{
  "skillListingMaxDescChars": 2048
}
```

Raise it to keep long descriptions intact at the cost of more context per turn; lower it to fit more skills under [`skillListingBudgetFraction`](#skilllistingbudgetfraction).

## Interface and terminal

Change how Claude Code looks and behaves in your terminal: theme, editor mode, status line, spinner, notifications inside the session, and accessibility. See [Terminal configuration](/docs/en/terminal-config).

### `askUserQuestionTimeout`

Let an unanswered [`AskUserQuestion`](/docs/en/tools-reference) dialog auto-continue after a period of idle time, submitting whatever options you had already selected. Set it when you step away and want Claude to continue without you. With the default, questions wait until you answer them. Requires Claude Code v2.1.200 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: string, one of `"60s"`, `"5m"`, `"10m"`, or `"never"`
* **Default**: `"never"`
* **Per-session overrides**: [`CLAUDE_AFK_TIMEOUT_MS`](/docs/en/env-vars) takes precedence over this key for one session

```json settings.json theme={null}
{
  "askUserQuestionTimeout": "5m"
}
```

Appears in `/config` as **Question auto-continue timeout**, which writes this key to user settings; Claude Code hides the row while managed settings or the `--settings` flag set the key. Requires Claude Code v2.1.200 or later.

### `autoContinueAtUsageLimit`

After a claude.ai usage limit stops your session, wait in the open session and continue the task automatically after the reset. See [Turn automatic continue off](/docs/en/interactive-mode#turn-automatic-continue-off). Requires Claude Code v2.1.234 or later.

* **Scope**: [`User or managed`](#scopes). Read from user settings, `--settings`, and managed settings only. When none of those sets the key, a project or local settings file that sets it turns the feature off rather than being ignored.
* **Type**: Boolean
  * `true`: after a claude.ai usage limit stops your session, Claude Code waits in the open session and continues the task automatically after the reset
  * `false`: Claude Code doesn't start the wait on its own. You can still [start a wait yourself](/docs/en/interactive-mode#start-a-wait-yourself) from the usage-limit options menu
* **Default**: `true`

```json settings.json theme={null}
{
  "autoContinueAtUsageLimit": false
}
```

Appears in `/config` as **Continue automatically at usage limit**, which writes this key to user settings; Claude Code hides the row while managed settings or the `--settings` flag set the key.

### `autoScrollEnabled`

Follow new output to the bottom of the conversation in [fullscreen rendering](/docs/en/fullscreen). Turn it off to stay where you scrolled while Claude keeps working; permission prompts still scroll into view.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: the conversation follows new output to the bottom
  * `false`: you stay where you scrolled while Claude keeps working; permission prompts still appear below the transcript
* **Default**: `true`

```json settings.json theme={null}
{
  "autoScrollEnabled": false
}
```

Appears in `/config` as **Auto-scroll** when fullscreen rendering is on, which writes this key to user settings.

### `axScreenReader`

Render screen-reader friendly output: flat text without decorative borders or animations. Screen-reader mode uses the classic renderer, so the `tui` setting has no effect while it is active; attached [background sessions](/docs/en/agent-view) still render fullscreen. Requires Claude Code v2.1.181 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code renders flat text without decorative borders or animations, using the classic renderer
  * `false`: Claude Code renders normally
* **Default**: unset, so screen-reader mode is off
* **Per-session overrides**: [`--ax-screen-reader`](/docs/en/cli-reference#cli-flags) takes precedence over [`CLAUDE_AX_SCREEN_READER`](/docs/en/env-vars), and both take precedence over this key for one session

```json settings.json theme={null}
{
  "axScreenReader": true
}
```

Requires Claude Code v2.1.181 or later.

### `companyAnnouncements`

Show your organization's announcements to users at startup. When you list more than one, Claude Code picks one at random for each session; on a person's very first launch it shows the first entry.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings
* **Default**: unset, so no announcement shows

```json settings.json theme={null}
{
  "companyAnnouncements": [
    "Welcome to Acme Corp! Review our code guidelines at docs.example.com"
  ]
}
```

### `defaultShell`

Choose whether Bash or PowerShell runs the shell commands you type with the [`!` prefix](/docs/en/interactive-mode#shell-mode-with-prefix) in the input box, the ones Claude Code runs directly and adds to the session.

`"powershell"` works only while the [PowerShell tool](/docs/en/tools-reference#powershell-tool) is on. The tool is on by default on Windows without Git Bash, and on Windows with Git Bash for claude.ai and Console accounts. In Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry sessions, and on macOS, Linux, and WSL, set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` to turn the tool on. Set that variable to `0` to turn the tool off.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"bash"`: Claude Code runs your `!` commands in Bash
  * `"powershell"`: Claude Code runs your `!` commands in PowerShell
* **Default**: `"bash"`, or `"powershell"` on Windows when Bash isn't available

```json settings.json theme={null}
{
  "defaultShell": "powershell"
}
```

If the shell you name isn't available, Claude Code uses the other one: `"powershell"` falls back to Bash when the PowerShell tool is off, and `"bash"` falls back to PowerShell when Bash isn't installed.

### `dialogExpiry`

Set the deadline for dialogs Claude Code [forwards to a remote client](/docs/en/remote-control#limitations), such as a Remote Control or SDK host, for the approval dialog for a [held cross-session message](/docs/en/cross-session-messaging#control-inbound-messages), and for the mid-session [Fable 5 usage-credits consent prompt](/docs/en/model-config#fable-5-and-usage-credits) in a session that may have nobody at the terminal. When no answer arrives before the deadline, Claude Code cancels the dialog and continues with its no-action default. Requires Claude Code v2.1.224 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: string, one of `"60s"`, `"5m"`, `"10m"`, or `"never"`, which disables the deadline
* **Default**: `"5m"`
* **Per-session overrides**: [`CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`](/docs/en/env-vars) takes precedence over this key for one session

```json settings.json theme={null}
{
  "dialogExpiry": "10m"
}
```

Permission prompts and [`AskUserQuestion`](/docs/en/tools-reference#askuserquestion-tool-behavior) questions use their own flows and aren't governed by this deadline. Appears in `/config` as **Dialog expiry**, which writes this key to user settings; the row requires Claude Code v2.1.232 or later, and Claude Code hides it while managed settings or the `--settings` flag set the key.

### `editorMode`

Choose the key binding mode for the input prompt.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"normal"`: standard key bindings in the prompt input
  * `"vim"`: vim-style editing with NORMAL, INSERT, and VISUAL modes
* **Default**: `"normal"`

```json settings.json theme={null}
{
  "editorMode": "vim"
}
```

Appears in `/config` as **Editor mode**, which writes this key to user settings.

### `emojiCompletionEnabled`

Show emoji suggestions when you type `:` plus a shortcode in the prompt input, and replace a completed shortcode such as `:heart:` with its emoji. Set it to `false` to turn off both.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code shows emoji suggestions after `:` and replaces a completed shortcode with its emoji
  * `false`: Claude Code neither suggests emoji nor replaces shortcodes
* **Default**: `true`

```json settings.json theme={null}
{
  "emojiCompletionEnabled": false
}
```

See [Emoji shortcodes](/docs/en/interactive-mode#emoji-shortcodes). Requires Claude Code v2.1.217 or later.

<span id="file-suggestion-settings" />

### `fileSuggestion`

Run your own command to supply `@` file path autocomplete instead of the built-in file suggestion. The built-in suggestion uses fast filesystem traversal; a large monorepo may do better with project-specific indexing such as a pre-built file index.

* **Scope**: [`Any file`](#scopes). Under the [status line and file suggestion gates](#status-line-and-file-suggestion-gates), Claude Code turns the command off or runs only a managed value, and skips yours without warning.
* **Type**: object with `type`, always `"command"`, and `command`, the shell command to run
* **Default**: unset, so Claude Code uses the built-in file suggestion

```json settings.json theme={null}
{
  "fileSuggestion": {
    "type": "command",
    "command": "~/.claude/file-suggestion.sh"
  }
}
```

After you save this, type `@` followed by part of a path in the prompt: the suggestions come from your command's output.

#### Command input and output

Claude Code runs the command with the same environment variables as [hooks](/docs/en/hooks), including `CLAUDE_PROJECT_DIR`, and stops waiting after five seconds. The command receives JSON on stdin with a `query` field holding what you've typed so far:

```json theme={null}
{"query": "src/comp"}
```

Print newline-separated file paths to stdout. Claude Code shows at most 15:

```text theme={null}
src/components/Button.tsx
src/components/Modal.tsx
src/components/Form.tsx
```

The following script reads the query and hands it to a repository file index:

```bash theme={null}
#!/bin/bash
query=$(cat | jq -r '.query')
# Replace your-repo-file-index with your own file search command
your-repo-file-index --query "$query" | head -20
```

<span id="footer-link-badges" />

### `footerLinksRegexes`

Render extra clickable badges in the footer below the input box when a regex matches turn output: tool results, including file contents and fetched pages, and Claude's own responses. Use it to turn IDs printed by project CLIs, such as review tools and issue trackers, into session links. Requires Claude Code v2.1.176 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: array of objects, each with `type` set to `"regex"`, a `pattern` regex, a `url` template, and an optional `label`; `{name}` placeholders in `url` and `label` are filled from named capture groups in `pattern`
* **Default**: unset, so no badges render

This example matches issue keys such as `PROJ-1234` and builds each link from the captured key:

```json settings.json theme={null}
{
  "footerLinksRegexes": [
    {
      "type": "regex",
      "pattern": "\\b(?<key>PROJ-\\d+)\\b",
      "url": "https://issues.example.com/browse/{key}",
      "label": "{key}"
    }
  ]
}
```

With this configured, when `PROJ-1234` appears in a tool result or in Claude's reply, a `PROJ-1234` badge appears in the footer linking to `https://issues.example.com/browse/PROJ-1234`. Requires Claude Code v2.1.176 or later.

#### Badge constraints

Each entry's URL, label, and badge count are bounded as follows:

| Constraint  | Behavior                                                                                                                                                                                           |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL origin  | Captured values are URL-encoded and the constructed URL must share the template's literal origin. A capture can fill a path segment or query value but can't change where the link points          |
| URL length  | Constructed URLs longer than 2048 characters are dropped                                                                                                                                           |
| URL scheme  | Must be `https`, `http`, or a recognized editor or workspace deep-link scheme: `vscode`, `vscode-insiders`, `cursor`, `windsurf`, `zed`, `jetbrains`, `idea`, `slack`, `linear`, `notion`, `figma` |
| Label       | Defaults to the matched text and is truncated to 28 display columns                                                                                                                                |
| Badge count | At most 5 badges render. The oldest is displaced by newer matches and `/clear` removes them                                                                                                        |

When a turn completes, Claude Code matches each entry's `pattern` regex against the turn output on the main thread, so a slow regex blocks the UI until it finishes. Nested quantifiers such as `(a+)+$` can take exponentially long against certain inputs and freeze the session, so keep each `pattern` linear and avoid nesting `+` or `*`.

Footer badges render alongside a [custom status line](/docs/en/statusline) when one is configured; neither replaces the other. Use a status line for a script-driven row that computes its own content from session data, and footer badges to turn IDs from the conversation into links without a script.

### `keybindingFlavor`

Choose which convention `Ctrl+W` follows in the prompt input. Set it to `"readline"` to make `Ctrl+W` delete back to the previous whitespace, as Bash does, so a path or a `--flag=value` goes in one press. Requires Claude Code v2.1.238 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"classic"`: `Ctrl+W` deletes the previous word
  * `"readline"`: `Ctrl+W` deletes back to the previous whitespace
* **Default**: `"classic"`

```json settings.json theme={null}
{
  "keybindingFlavor": "readline"
}
```

See [Make editing keys follow readline conventions](/docs/en/interactive-mode#make-ctrl-w-delete-back-to-whitespace) for the per-key behavior.

### `prefersReducedMotion`

Reduce or turn off interface animations such as the spinner, shimmer, and flash effects. Appears in `/config` as **Reduce motion**.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code reduces or turns off interface animations such as the spinner, shimmer, and flash effects
  * `false`: the same as unset; Claude Code shows its animations
* **Default**: `false`

```json settings.json theme={null}
{
  "prefersReducedMotion": true
}
```

### `promptSuggestionEnabled`

Show or hide [prompt suggestions](/docs/en/interactive-mode#prompt-suggestions), the grayed-out predictions that appear in your prompt input. Set it to `false`, or turn off **Prompt suggestions** in `/config`, to hide them.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: you see prompt suggestions in your prompt input
  * `false`: Claude Code hides prompt suggestions
* **Default**: `true`
* **Per-session overrides**: [`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`](/docs/en/env-vars) takes precedence over this key for one session

```json settings.json theme={null}
{
  "promptSuggestionEnabled": false
}
```

Prompt suggestions need a claude.ai or Console account with telemetry on. On Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry, or with telemetry turned off, such as by [`DISABLE_TELEMETRY`](/docs/en/env-vars), this key has no effect and only `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` turns them on.

### `respectGitignore`

Control whether the `@` file picker leaves out files that match `.gitignore` patterns. Appears in `/config` as **Respect .gitignore in file picker**.

* **Scope**: [`Any file`](#scopes). When no settings file sets it, Claude Code falls back to `respectGitignore` in `~/.claude.json`, which the `/config` toggle writes.
* **Type**: Boolean
  * `true`: the `@` file picker leaves out files that match `.gitignore` patterns
  * `false`: the `@` file picker includes files that match `.gitignore` patterns
* **Default**: `true`

```json settings.json theme={null}
{
  "respectGitignore": false
}
```

### `respondToBashCommands`

Choose whether Claude responds after you run a shell command with the [`!` prefix](/docs/en/interactive-mode#shell-mode-with-prefix) in the input box. By default, Claude Code adds the command's output to the conversation and Claude replies to it. Set this key to `false` to add the output to context without a reply, so you can run several commands and ask about them together. Requires Claude Code v2.1.186 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code adds the command's output to the conversation and Claude replies to it
  * `false`: Claude Code adds the output to context without a reply
* **Default**: `true`

```json settings.json theme={null}
{
  "respondToBashCommands": false
}
```

See [Shell mode with `!` prefix](/docs/en/interactive-mode#shell-mode-with-prefix). Requires Claude Code v2.1.186 or later.

### `showClearContextOnPlanAccept`

When Claude finishes a plan in [plan mode](/docs/en/permission-modes#review-and-approve-a-plan), it shows an approval menu. Planning can use a lot of context, so this key adds a first option to that menu, **Yes, clear context and …**, that approves the plan, clears the conversation context, and starts implementing from the plan alone. The rest of the label names the permission mode the session continues in, and shows how much of your context the planning used.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: the plan approval menu gets a first option, **Yes, clear context and …**, that approves the plan and clears the conversation context
  * `false`: the plan approval menu shows no clear-context option
* **Default**: `false`

```json settings.json theme={null}
{
  "showClearContextOnPlanAccept": true
}
```

### `showTurnDuration`

Show or hide the turn duration message after each response, such as "Cooked for 1m 6s". Appears in `/config` as **Show turn duration**.

* **Scope**: [`Any file`](#scopes). A value in `~/.claude.json` from an older version applies when no settings file sets it.
* **Type**: Boolean
  * `true`: you see the turn duration message after each response
  * `false`: Claude Code hides the turn duration message
* **Default**: `true`

```json settings.json theme={null}
{
  "showTurnDuration": false
}
```

### `spellcheck`

Underline misspelled words in the prompt input as you type, using a spell checker you install. Claude Code checks only the text in the input box. [Check spelling as you type](/docs/en/interactive-mode#check-spelling-as-you-type) covers installing aspell, hunspell, or ispell and what the checker covers. Requires Claude Code v2.1.235 or later.

* **Scope**: [`User or managed`](#scopes). The block from the highest tier that sets it applies as a whole.
* **Type**: object with `enabled` (Boolean), `checker` (`"aspell"`, `"hunspell"`, `"ispell"`, or `"auto"`), `language` (string, passed to the checker as its dictionary name), and `color` (string, a terminal color name, `#rrggbb`, `rgb(r,g,b)`, `ansi256(n)`, or `ansi:<name>`)
* **Default**: unset, so spell checking is off; `checker` defaults to `"auto"`, the first of the three found on `PATH`; `language` defaults to the checker's own dictionary; `color` defaults to the theme's error color

```json settings.json theme={null}
{
  "spellcheck": { "enabled": true, "language": "en_GB" }
}
```

### `spinnerTipsEnabled`

While Claude works, the spinner line rotates through short tips about Claude Code features, such as "Use Plan Mode to prepare for a complex request before making changes. Press Shift+Tab twice to enable." Set this key to `false` to hide them. Appears in `/config` as **Show tips**.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: you see tips in the spinner while Claude is working
  * `false`: Claude Code hides spinner tips
* **Default**: `true`

```json settings.json theme={null}
{
  "spinnerTipsEnabled": false
}
```

### `spinnerTipsOverride`

Add your own tips to the [spinner tips](#spinnertipsenabled) that Claude Code shows while Claude works, or replace the built-in tips with yours. Claude Code puts your tips in the same rotation as the built-in ones: it picks the tip that has gone unshown the longest, skips tips still in their cooldown, and breaks ties by priority.

If you set [`spinnerTipsEnabled`](#spinnertipsenabled) to `false`, Claude Code hides all tips, yours included.

* **Scope**: [`Any file`](#scopes). Claude Code honors tip objects, `tipsFile`, `label`, and `excludeDefault` from user settings, the `--settings` flag, and managed settings; from project and local settings it reads plain string tips only.
* **Type**: object with `tips`, `tipsFile`, `label`, and `excludeDefault` fields, each optional
* **Default**: unset, so Claude Code shows only the built-in tips

Tip objects, `tipsFile`, `label`, and the Scope line's rule that project and local settings contribute plain strings only require Claude Code v2.1.247 or later. On earlier versions, a project or local file's `excludeDefault` applies too.

Each `tips` entry is a plain string or an object with these fields:

| Field              | Required | Description                                                                                                                                                                                                |
| :----------------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Yes      | Up to 64 letters, digits, `.`, `_`, or `-`. Claude Code keys the tip's show history on it, so the tip's cooldown survives reordering the list. Of two entries with the same id, Claude Code uses the first |
| `text`             | Yes      | The tip, one line of up to 500 characters. Claude Code strips ANSI escapes and control characters and collapses whitespace                                                                                 |
| `cooldownSessions` | No       | Sessions Claude Code waits before showing the tip again, `0` to `1000`, default `0`                                                                                                                        |
| `priority`         | No       | Order among tips that have gone unshown equally long, higher first, `-10` to `10`, default `0`                                                                                                             |

Claude Code reads a plain string as a tip with those defaults and a position-based id, so its show history resets when you reorder the list. Give a tip an `id` to keep its history across edits.

Claude Code reads at most 200 tips across `tips` and `tipsFile`, and drops an invalid entry with a debug warning instead of rejecting the settings file.

Use the remaining fields to name a tips file, set the prefix, and hide the built-in tips:

* `tipsFile`: an absolute or `~/` path to a local JSON file holding an array of the same entries, or an object with a `tips` array, up to 256 KB. Claude Code reads the file once per process, so it loads your edits at the next start. You can't set it through [server-managed settings](/docs/en/server-managed-settings); deploy inline `tips` there, or deploy the path in an on-disk `managed-settings.json`.
* `label`: the prefix Claude Code shows before tips from user, `--settings`, and managed settings, up to 40 characters. The default is `Tip`, the same prefix as the built-in tips, and tips from project and local settings always use it.
* `excludeDefault`: set it to `true` to hide the built-in tips and show only yours. When Claude Code can't load any of your tips, for example because `tipsFile` doesn't exist or every entry is invalid, it keeps the built-in rotation instead of an empty spinner.

When more than one settings file sets the key, Claude Code shows tips from all of them and takes `tipsFile`, `label`, and `excludeDefault` from whichever of managed settings, the `--settings` flag, and user settings is the highest-precedence one that sets each.

This example, in your user settings, adds a plain string tip and an object tip to the rotation under the `Acme tip` prefix:

```json settings.json theme={null}
{
  "spinnerTipsOverride": {
    "label": "Acme tip",
    "tips": [
      "Run /review before opening a PR",
      {
        "id": "gateway-errors",
        "text": "Seeing 5xx errors? Check the gateway status page first",
        "cooldownSessions": 5,
        "priority": 2
      }
    ]
  }
}
```

Each field in the example changes one thing about how Claude Code shows the tips:

* `label`: Claude Code shows both tips as `Acme tip: ...` instead of `Tip: ...`.
* The plain string: Claude Code gives it the defaults, so it can come up again in the very next session.
* `id`: Claude Code keys the second tip's show history on `gateway-errors`, so its cooldown still applies after you add or reorder tips.
* `cooldownSessions`: after Claude Code shows the `gateway-errors` tip, it doesn't show that tip again until five sessions later.
* `priority`: when the `gateway-errors` tip and another tip have gone unshown for the same number of sessions, for example when neither has been shown yet, Claude Code shows `gateway-errors` first. The plain string has the default priority, `0`.

While Claude works, Claude Code shows your tips in the spinner with your prefix, such as `Acme tip: Run /review before opening a PR`.

### `spinnerVerbs`

While a turn is in progress, the spinner shows a rotating verb such as "Accomplishing", "Architecting", or "Baking". Use this key to add your own verbs to that rotation or replace the built-in list with yours.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with a `verbs` array of strings and `mode`, one of:
  * `"append"`: Claude Code adds your verbs to the built-in set
  * `"replace"`: Claude Code shows only your verbs
* **Default**: unset, so Claude Code uses the built-in verbs

This example adds two verbs to the built-in set:

```json settings.json theme={null}
{
  "spinnerVerbs": {
    "mode": "append",
    "verbs": ["Pondering", "Crafting"]
  }
}
```

In `"replace"` mode with an empty `verbs` array, Claude Code keeps the built-in verbs.

### `statusLine`

Run your own command to render a [status line](/docs/en/statusline) below the prompt with context such as the model, cost, or git branch. Optional fields adjust spacing, add periodic re-runs, and hide the built-in vim mode indicator when your script renders `vim.mode` itself.

* **Scope**: [`Any file`](#scopes). When [`allowManagedHooksOnly`](#allowmanagedhooksonly) is on, or [`disableAllHooks`](#disableallhooks) is set outside managed settings, only the managed settings value runs.
* **Type**: object with `type` set to `"command"` and a `command` string, plus optional `padding` as a number of characters, `refreshInterval` as a number of seconds, minimum `1`, and `hideVimModeIndicator` as a Boolean
* **Default**: unset, so no status line

This example prints the model name and context usage, and adds two characters of horizontal spacing:

```json settings.json theme={null}
{
  "statusLine": {
    "type": "command",
    "command": "jq -r '\"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context\"'",
    "padding": 2
  }
}
```

The example needs [`jq`](https://jqlang.org/) installed and runs in a shell. For PowerShell and Git Bash equivalents, see [Windows configuration](/docs/en/statusline#windows-configuration); for the full setup, see [Manually configure a status line](/docs/en/statusline#manually-configure-a-status-line).

### `subagentStatusLine`

When Claude runs [subagents](/docs/en/sub-agents), Claude Code lists them in a task display below the prompt, one row per subagent showing `name · description · token count`. This key lets you run your own command to rewrite those rows, for example to show each subagent's context usage as a percentage. On each refresh, Claude Code sends the visible rows as one JSON object on stdin, with a `tasks` array carrying each subagent's `id`, `name`, `status`, `model`, `tokenCount`, and more, and replaces the row for each `id` you write back as a `{"id", "content"}` line. Rows you don't write back keep the default rendering.

* **Scope**: [`Any file`](#scopes). When [`allowManagedHooksOnly`](#allowmanagedhooksonly) is on, or [`disableAllHooks`](#disableallhooks) is set outside managed settings, only the managed settings value runs.
* **Type**: object with `type` set to `"command"` and a `command` string
* **Default**: unset, so Claude Code renders the default rows

```json settings.json theme={null}
{
  "subagentStatusLine": {
    "type": "command",
    "command": "jq -c '.tasks[] | {id, content: \"\\(.name): \\(.tokenCount) tokens\"}'"
  }
}
```

See [Subagent status lines](/docs/en/statusline#subagent-status-lines).

### `syntaxHighlightingDisabled`

Claude Code colors code by language in the diffs, code blocks, and file previews it shows in the terminal, with its built-in highlighter; no plugin or language server is involved. Set this key to `true` to show them as plain text instead, for example if the colors clash with your terminal theme or slow a screen reader.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns off syntax highlighting in diffs, code blocks, and file previews
  * `false`: Claude Code highlights syntax
* **Default**: `false`

```json settings.json theme={null}
{
  "syntaxHighlightingDisabled": true
}
```

### `terminalProgressBarEnabled`

Some terminals can show a progress indicator on the tab or in the taskbar for the program running in them. While Claude is working, Claude Code reports an in-progress state to the terminal and clears it when the turn ends, so you can see from another tab or window whether Claude is still busy. It does so only in terminals that support the indicator: ConEmu, Ghostty 1.2.0 or later, and iTerm2 3.6.6 or later. Set this key to `false` to stop reporting it. Appears in `/config` as **Terminal progress bar**.

* **Scope**: [`Any file`](#scopes). A value in `~/.claude.json` from an older version applies when no settings file sets it.
* **Type**: Boolean
  * `true`: you see the terminal progress bar in terminals that support it
  * `false`: Claude Code hides the terminal progress bar
* **Default**: `true`

```json settings.json theme={null}
{
  "terminalProgressBarEnabled": false
}
```

### `terminalTitleFromRename`

Claude Code sets your terminal tab's title. By default it uses a title it generates from the conversation, and once you give the session a [name](/docs/en/sessions#name-your-sessions) with `/rename` or `--name`, the tab shows that name instead. Set this key to `false` to keep the generated title on the tab even after you name the session. The name itself still applies, so `/resume <name>` and the session picker find it.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: the terminal tab title shows the session name you set
  * `false`: the tab keeps the title Claude Code generates from your conversation
* **Default**: `true`

```json settings.json theme={null}
{
  "terminalTitleFromRename": false
}
```

To stop Claude Code from updating the terminal title at all, set [`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`](/docs/en/env-vars) to `1` instead.

### `theme`

Pick the color theme for the interface. Appears in `/config` as **Theme**.

* **Scope**: [`Any file`](#scopes). A value in `~/.claude.json` from an older version applies when no settings file sets it.
* **Type**: string, one of:
  * `"auto"`: matches your terminal's light or dark background
  * `"dark"`: the dark theme
  * `"light"`: the light theme
  * `"dark-daltonized"`: the dark theme with colorblind-friendly colors
  * `"light-daltonized"`: the light theme with colorblind-friendly colors
  * `"dark-ansi"`: the dark theme using only your terminal's ANSI color palette
  * `"light-ansi"`: the light theme using only your terminal's ANSI color palette
  * `"custom:<slug>"` or `"custom:<plugin-name>:<slug>"`: a custom theme from `~/.claude/themes/` or a plugin
* **Default**: `"dark"`

```json settings.json theme={null}
{
  "theme": "light-daltonized"
}
```

See [Create a custom theme](/docs/en/terminal-config#create-a-custom-theme).

### `tui`

Choose the terminal UI renderer. Use `"fullscreen"` for the flicker-free [alt-screen renderer](/docs/en/fullscreen) with virtualized scrollback, or `"default"` for the classic main-screen renderer. Running `/tui fullscreen` or `/tui default` writes this key for you.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"default"`: the classic main-screen renderer
  * `"fullscreen"`: the flicker-free alt-screen renderer with virtualized scrollback
* **Default**: unset, so Claude Code [picks the renderer for you](/docs/en/fullscreen#fullscreen-by-default)
* **Per-session overrides**: [`CLAUDE_CODE_NO_FLICKER`](/docs/en/env-vars) and [`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`](/docs/en/env-vars) take precedence over this key for one session: `CLAUDE_CODE_NO_FLICKER=1` turns fullscreen on, and `CLAUDE_CODE_NO_FLICKER=0` or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` turns it off; when both are set, Claude Code turns it off

```json settings.json theme={null}
{
  "tui": "fullscreen"
}
```

Under tmux `-CC` or over SSH to Windows, Claude Code keeps the classic renderer unless you set `CLAUDE_CODE_NO_FLICKER=1`. Background sessions opened from [agent view](/docs/en/agent-view) always use the fullscreen renderer regardless of this setting.

### `verbose`

By default, the transcript collapses each tool call to a short summary, such as the command Claude ran and a line count of its output, and you press `Ctrl+O` to switch the whole transcript to the expanded view when you want the details. Set this key to `true` to show every tool call's full input and output inline as it happens, which is useful when you're debugging a hook, an MCP server, or a long shell command. Appears in `/config` as **Verbose output**.

* **Scope**: [`Any file`](#scopes). A value in `~/.claude.json` from an older version applies when no settings file sets it.
* **Type**: Boolean
  * `true`: you see full tool output
  * `false`: you see truncated summaries of tool output
* **Default**: `false`
* **Per-session overrides**: [`--verbose`](/docs/en/cli-reference#cli-flags) takes precedence over this key for one session

```json settings.json theme={null}
{
  "verbose": true
}
```

A [`viewMode`](#viewmode) value or a sticky `/focus` selection overrides this key every session.

### `viewMode`

Set the transcript view Claude Code starts in: `"default"`, `"verbose"`, or `"focus"`. When set, it overrides both the sticky `/focus` selection and the [`verbose`](#verbose) setting.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"default"`: the normal transcript with truncated tool output
  * `"verbose"`: the transcript with full tool output
  * `"focus"`: only your last prompt, a one-line summary of tool calls with edit diffstats, and the final response. Focus view needs the [fullscreen renderer](#tui)
* **Default**: unset, so the `verbose` setting and your last `/focus` choice apply
* **Per-session overrides**: [`--verbose`](/docs/en/cli-reference#cli-flags) takes precedence over this key for one session

```json settings.json theme={null}
{
  "viewMode": "focus"
}
```

### `vimInsertModeRemaps`

Map two-key INSERT-mode sequences to Escape in [vim editor mode](/docs/en/interactive-mode#vim-editor-mode). Each key is exactly two printable characters typed in sequence, and `"<Esc>"` is the only supported target; Claude Code ignores other entries. Requires Claude Code v2.1.208 or later.

* **Scope**: [`User or managed`](#scopes). A repository can't remap your keystrokes.
* **Type**: object mapping a two-character sequence to `"<Esc>"`
* **Default**: unset

```json settings.json theme={null}
{
  "vimInsertModeRemaps": {
    "jj": "<Esc>"
  }
}
```

Has no effect unless `editorMode` is `"vim"`. See [Remap INSERT-mode key sequences](/docs/en/interactive-mode#remap-insert-mode-key-sequences). Requires Claude Code v2.1.208 or later.

### `voice`

Turn on [voice dictation](/docs/en/voice-dictation) and choose how the dictation key behaves. Claude Code writes this object for you when you run `/voice`.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `enabled` as a Boolean, `autoSubmit` as a Boolean that applies in hold mode only, and `mode`, one of:
  * `"hold"`: you hold the dictation key while speaking and release it to stop
  * `"tap"`: you tap the key once to start recording and again to send
* **Default**: unset, so dictation is off; when `enabled` is `true` and `mode` is unset, Claude Code uses `"hold"`

This example turns dictation on and makes the key tap once to start recording and again to send:

```json settings.json theme={null}
{
  "voice": {
    "enabled": true,
    "mode": "tap"
  }
}
```

`autoSubmit` sends the prompt when you release the key in hold mode. Voice dictation requires a claude.ai account.

### `voiceEnabled`

<Warning>
  Deprecated since v2.1.92, when the [`voice`](#voice) object replaced it. Claude Code still reads it so older settings files keep working, but new configurations should set `voice.enabled`.
</Warning>

Turn voice dictation on with the single Boolean form that predates the `voice` object. When both are set, `voice.enabled` applies.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: voice dictation is on when you're logged in with a claude.ai account and your organization's policy allows voice, unless `voice.enabled` is set
  * `false`: voice dictation is off, unless `voice.enabled` is set
* **Default**: unset

```json settings.json theme={null}
{
  "voiceEnabled": true
}
```

### `wheelScrollAccelerationEnabled`

Accelerate mouse-wheel scroll speed during fast scrolls in [fullscreen rendering](/docs/en/fullscreen#mouse-wheel-scrolling). Set it to `false` for a constant scroll rate per wheel notch. Requires Claude Code v2.1.174 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code accelerates mouse-wheel scroll speed during fast scrolls
  * `false`: Claude Code scrolls at a constant rate per wheel notch
* **Default**: `true`

```json settings.json theme={null}
{
  "wheelScrollAccelerationEnabled": false
}
```

Requires Claude Code v2.1.174 or later.

## Git and attribution

Control the attribution Claude Code adds to commits and pull requests and how it works with git.

<span id="attribution-settings" />

### `attribution`

Customize the attribution Claude Code adds to git commits and pull requests. Commits get a [git trailer](https://git-scm.com/docs/git-interpret-trailers) such as `Co-Authored-By` by default; pull request descriptions get plain text. Set each part separately with the sub-keys below.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `commit` and `pr` strings and a `sessionUrl` Boolean
* **Default**: unset, so Claude Code uses the standard attribution shown under each sub-key

This example replaces the commit attribution, removes pull request attribution, and drops the session link:

```json settings.json theme={null}
{
  "attribution": {
    "commit": "Generated with AI\n\nCo-Authored-By: AI <ai@example.com>",
    "pr": "",
    "sessionUrl": false
  }
}
```

To hide all attribution, set [`commit`](#attribution-commit) and [`pr`](#attribution-pr) to empty strings and [`sessionUrl`](#attribution-sessionurl) to `false`. Once you set `commit` or `pr`, Claude Code ignores the deprecated `includeCoAuthoredBy` setting and uses its default text for whichever of the two you left unset.

### `includeCoAuthoredBy`

<Warning>
  Deprecated since v2.0.62, when [`attribution`](#attribution) replaced it. Claude Code still reads it, but new configurations should set `attribution`.
</Warning>

Use [`attribution`](#attribution) instead, which replaces this key and lets you change or hide the commit trailer, the pull request text, and the session link separately. Claude Code still honors `includeCoAuthoredBy: false` from settings files that predate `attribution`, but ignores it once you set `attribution.commit` or `attribution.pr`.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: the same as unset; Claude Code adds the commit trailer and the pull request attribution text
  * `false`: Claude Code omits both the commit trailer and the pull request attribution text, unless `attribution` sets `commit` or `pr`, in which case the [`attribution`](#attribution) rules apply
* **Default**: `true`

```json settings.json theme={null}
{
  "includeCoAuthoredBy": false
}
```

To hide all attribution today, set [`attribution.commit`](#attribution-commit) and [`attribution.pr`](#attribution-pr) to empty strings and [`attribution.sessionUrl`](#attribution-sessionurl) to `false`.

### `includeGitInstructions`

At session start, Claude Code adds two git-related pieces to Claude's prompt: its built-in instructions for how to write commits and pull requests, in the Bash tool's description, and a git status snapshot of your repository in the system prompt, meaning the current branch, the main branch, `git status` output, and recent commits. Set this key to `false` to leave both out, for example when you use your own git workflow skills.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code includes its built-in commit and pull request workflow instructions and the git status snapshot. Cloud sessions never include the snapshot
  * `false`: Claude Code leaves both out
* **Default**: `true`
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`](/docs/en/env-vars) takes precedence over this key for one session

```json settings.json theme={null}
{
  "includeGitInstructions": false
}
```

### `prUrlTemplate`

Point the PR links Claude Code renders, in the footer badge and in tool-result summaries, at an internal code-review tool instead of `github.com`. Claude Code substitutes `{host}`, `{owner}`, `{repo}`, `{number}`, and `{url}` from the `gh`-reported PR URL. The [GitLab merge request badge](/docs/en/interactive-mode#gitlab-merge-requests) keeps its GitLab URL.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a URL template using any of the five placeholders
* **Default**: unset, so links use the `gh`-reported URL

```json settings.json theme={null}
{
  "prUrlTemplate": "https://reviews.example.com/{owner}/{repo}/pull/{number}"
}
```

Claude Code applies the template only to the links it renders itself; a PR number Claude writes in a message, such as `#123`, stays as Claude wrote it. A URL that doesn't have the `/pull/<number>` shape is left unchanged.

### `attribution.commit`

Set the attribution text Claude Code adds to git commits, including any trailers. Set it to an empty string to hide commit attribution.

* **Scope**: [`Any file`](#scopes)
* **Type**: string
* **Default**: unset, so Claude Code adds `Co-Authored-By: <name> <noreply@anthropic.com>`. The name is the session's active model, such as `Claude Sonnet 5`.
  * When Claude Code recognizes the model as a Claude model but can't confirm its exact version, it writes `Claude` alone.
  * When it can't match the model ID to any Claude model, such as a third-party model served through a custom [`ANTHROPIC_BASE_URL`](/docs/en/env-vars), it writes `Claude Code`.

This example replaces the default trailer with a custom line and a custom `Co-Authored-By` trailer:

```json settings.json theme={null}
{
  "attribution": {
    "commit": "Generated with AI\n\nCo-Authored-By: AI <ai@example.com>"
  }
}
```

### `attribution.pr`

Set the attribution text Claude Code adds to pull request descriptions. Set it to an empty string to hide pull request attribution.

* **Scope**: [`Any file`](#scopes)
* **Type**: string
* **Default**: unset, so Claude Code adds `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

```json settings.json theme={null}
{
  "attribution": {
    "pr": ""
  }
}
```

### `attribution.sessionUrl`

Choose whether Claude Code appends the claude.ai session link when it commits or opens a pull request from a [cloud](/docs/en/claude-code-on-the-web) or [Remote Control](/docs/en/remote-control) session. Claude Code adds the link as a `Claude-Session` trailer on commits and as a link in pull request descriptions. Set it to `false` to omit the link.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code appends the claude.ai session link when it commits or opens a pull request from a cloud or Remote Control session
  * `false`: Claude Code omits the link
* **Default**: `true`

```json settings.json theme={null}
{
  "attribution": {
    "sessionUrl": false
  }
}
```

<span id="hook-configuration" />

<span id="hook-and-skill-settings" />

## Hooks and automation

Register hooks, restrict which hooks run, and control workflows. For hook events and payloads, see the [hooks reference](/docs/en/hooks).

### `allowedHttpHookUrls`

Limit which URLs [HTTP hooks](/docs/en/hooks#http-hook-fields) can target. When you define this key, Claude Code runs an HTTP hook only if its URL matches one of the patterns and blocks the rest without running them; an empty array blocks every HTTP hook.

* **Scope**: [`Any file`](#scopes). Arrays merge across settings files.
* **Type**: array of URL patterns, with `*` as a wildcard
* **Default**: unset, so any URL is allowed

This example allows any URL under `https://hooks.example.com/` and any `http://localhost` URL:

```json settings.json theme={null}
{
  "allowedHttpHookUrls": ["https://hooks.example.com/*", "http://localhost:*"]
}
```

Hostname matching is case-insensitive and treats `hooks.example.com.`, with the trailing dot that marks a fully qualified domain name, the same as `hooks.example.com`, which is how DNS treats them. The allowlist applies to hooks from every source, including managed settings.

### `allowManagedHooksOnly`

Restrict hook execution to hooks your organization deploys.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: only managed hooks run, plus Agent SDK hooks and hooks from plugins your managed settings force-enable. See [What runs under `allowManagedHooksOnly`](#what-runs-under-allowmanagedhooksonly)
  * `false`: hooks from every settings file and plugin run
* **Default**: unset, so hooks from every settings file and plugin run

```json managed-settings.json theme={null}
{
  "allowManagedHooksOnly": true
}
```

#### What runs under `allowManagedHooksOnly`

When you set it to `true`, Claude Code changes which hooks and hook-like commands load:

* **Managed and SDK hooks run**: hooks from managed settings and hooks the [Agent SDK](/docs/en/agent-sdk/overview) registers in process
* **Force-enabled plugin hooks run**: hooks from plugins your managed settings force-enable through [`enabledPlugins`](#enabledplugins). Claude Code matches on the full `plugin@marketplace` ID, so a plugin with the same name from a different marketplace stays blocked. This lets you distribute vetted hooks through an organization marketplace while blocking everything else
* **Everything else is blocked**: user, project, and local hooks, hooks from other plugins, and hooks declared in agent frontmatter
* **Command-sourced plugins are disabled**: Claude Code also disables plugins with a [`command` source](/docs/en/plugin-marketplaces#command-sources), including plugins force-enabled in managed `enabledPlugins`, unless you set [`disableCommandPluginSources`](#disablecommandpluginsources) to `false` explicitly
* **Marketplace `headersHelper` commands are blocked**: Claude Code also blocks marketplace [`headersHelper` commands](/docs/en/plugin-marketplaces#authenticate-archive-downloads) unless [`disableCommandPluginSources`](#disablecommandpluginsources) is explicitly set to `false`, except for a marketplace that managed settings themselves declare. Requires Claude Code v2.1.238 or later
* **Status line and file suggestion narrow to managed settings**: Claude Code reads [`statusLine`](/docs/en/statusline), [`fileSuggestion`](#filesuggestion), and [`subagentStatusLine`](/docs/en/statusline#subagent-status-lines) from managed settings only, following the [status line and file suggestion gates](#status-line-and-file-suggestion-gates)

The [`/goal`](/docs/en/goal) command can't run while this key is set, because it depends on hooks.

### `disableAllHooks`

Turn off [hooks](/docs/en/hooks#disable-or-remove-hooks), any custom [status line](/docs/en/statusline), and any custom [file suggestion](#filesuggestion) command. Use it to turn all of these off temporarily without deleting them from your settings.

* **Scope**: [`Any file`](#scopes). Only managed settings can disable managed hooks.
* **Type**: Boolean
  * `true`: Claude Code turns off hooks, any custom status line, and any custom file suggestion command
  * `false`: hooks, the status line, and the file suggestion command run
* **Default**: unset, so hooks run

```json settings.json theme={null}
{
  "disableAllHooks": true
}
```

The reach depends on which file carries the key:

* **In managed settings**: Claude Code disables every configured hook, including managed ones, and keeps running the hooks the [Agent SDK](/docs/en/agent-sdk/overview) registers in process
* **In any other settings file**: Claude Code disables user, project, local, and plugin hooks; managed hooks, Agent SDK hooks, and hooks from plugins force-enabled in managed [`enabledPlugins`](#enabledplugins) keep running

Keeping Agent SDK hooks running when managed settings set this key requires Claude Code v2.1.242 or later.

The [`/goal`](/docs/en/goal) command can't run while hooks are disabled, and the `/hooks` menu shows a notice instead of your hooks.

#### Status line and file suggestion gates

Claude Code makes two decisions for `statusLine`, `fileSuggestion`, and `subagentStatusLine`, in this order:

* **Off entirely**: when managed settings set `disableAllHooks`, or when the folder isn't trusted under the same [workspace trust rule as hooks in settings files](/docs/en/permissions#what-runs-before-you-trust-a-folder)
* **Narrowed to managed settings**: when [`allowManagedHooksOnly`](#allowmanagedhooksonly) is set, when `disableAllHooks` is `true` outside managed settings after [settings precedence](/docs/en/hooks#disable-or-remove-hooks) applies, or when you start Claude Code with `--safe-mode`

Under narrowing, Claude Code runs a managed value if one is deployed. Otherwise it skips your value without warning: the status line is disabled, and `@` autocomplete falls back to the built-in file suggestion.

### `disableWorkflows`

Turn off [dynamic workflows](/docs/en/workflows#turn-workflows-off) and the bundled workflow commands for everyone your settings reach, such as an organization through managed settings. To turn workflows on or off just for yourself, use [`enableWorkflows`](#enableworkflows) instead, which the **Dynamic workflows** toggle in `/config` writes to your user settings.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns off dynamic workflows and the bundled workflow commands for everyone your settings reach
  * `false`: the same as unset; whether workflows are on then follows [`enableWorkflows`](#enableworkflows) and your plan's default
* **Default**: `false`
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_WORKFLOWS`](/docs/en/env-vars) turns workflows off for one session; whichever of the two turns them off, the other can't turn them back on

```json settings.json theme={null}
{
  "disableWorkflows": true
}
```

### `enableWorkflows`

Turn [dynamic workflows](/docs/en/workflows) on or off for yourself when your plan's default isn't what you want. Appears in `/config` as **Dynamic workflows**, which writes this key to your user settings and removes it again when you toggle back to your plan's default. To turn workflows off for everyone from managed settings, use [`disableWorkflows`](#disableworkflows) instead.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns dynamic workflows on for you
  * `false`: Claude Code turns dynamic workflows off for you
* **Default**: unset, so workflows are on unless you're on the Pro plan, where they're off
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_WORKFLOWS`](/docs/en/env-vars) turns workflows off for one session, and `true` here can't turn them back on while it's set

```json settings.json theme={null}
{
  "enableWorkflows": true
}
```

[`disableWorkflows`](#disableworkflows) and your organization's workflows policy also take precedence: `enableWorkflows: true` can't turn workflows back on while any source turns workflows off. Claude Code hides the `/config` row while a source other than your user settings sets `enableWorkflows`, or sets `disableWorkflows` to `true`.

### `hooks`

Run your own commands, prompts, agents, HTTP requests, or MCP tools as [hooks](/docs/en/hooks) at points in Claude Code's lifecycle, such as before a tool call or when a session starts; the [hooks reference](/docs/en/hooks#hook-events) lists every event, its payload, and its exit codes. Each event maps to a list of matcher groups, and each group lists the handlers to run when the matcher applies.

* **Scope**: [`Any file`](#scopes). Hooks merge across files rather than replacing each other, and hooks from managed settings can't be removed from other files.
* **Type**: object keyed by [hook event](/docs/en/hooks#hook-events); each value is an array of `{ "matcher", "hooks" }` groups whose `hooks` entries have a `type` of `"command"`, `"prompt"`, `"agent"`, `"http"`, or `"mcp_tool"`
* **Default**: unset, so no hooks run

This example runs a script before every Bash tool call:

```json settings.json theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/check-bash.sh" }
        ]
      }
    ]
  }
}
```

For every event, matcher pattern, and handler field, see the [hooks reference](/docs/en/hooks#configuration). To turn hooks off, see [`disableAllHooks`](#disableallhooks); to limit hooks to the ones your organization deploys, see [`allowManagedHooksOnly`](#allowmanagedhooksonly).

### `httpHookAllowedEnvVars`

An [HTTP hook](/docs/en/hooks#http-hook-fields) can put the value of an environment variable into a request header, for example an `Authorization: Bearer $HOOK_TOKEN` header, but only for variables the hook lists in its own `allowedEnvVars`. This key sets an outer limit on that list for every HTTP hook: a hook can use a variable only if both its own `allowedEnvVars` and this key name it. Use it to stop a hook from reading a secret it shouldn't, even when the hook's definition asks for it.

* **Scope**: [`Any file`](#scopes). Arrays merge across settings files.
* **Type**: array of environment variable names
* **Default**: unset, so each hook's own `allowedEnvVars` list applies

This example limits header interpolation to `MY_TOKEN` and `HOOK_SECRET`:

```json settings.json theme={null}
{
  "httpHookAllowedEnvVars": ["MY_TOKEN", "HOOK_SECRET"]
}
```

The allowlist applies to hooks from every source, including managed settings.

### `workflowKeywordTriggerEnabled`

Choose whether typing the keyword `ultracode` in a prompt triggers a [dynamic workflow](/docs/en/workflows#ask-for-a-workflow-in-your-prompt). Set it to `false` to type the word without triggering one. Requires Claude Code v2.1.157 or later.

* **Scope**: [`Any file`](#scopes). Appears in `/config` as **Ultracode keyword trigger**.
* **Type**: Boolean
  * `true`: typing `ultracode` in a prompt triggers a dynamic workflow
  * `false`: you can type the word without triggering one
* **Default**: `true`

```json settings.json theme={null}
{
  "workflowKeywordTriggerEnabled": false
}
```

The `ultracode` effort setting, `/workflows`, and saved workflow commands are unaffected. Requires Claude Code v2.1.157 or later. Before v2.1.160, the trigger keyword was `workflow`.

### `workflowSizeGuideline`

Set the [agent count Claude aims for](/docs/en/workflows#set-a-size-guideline) in the dynamic workflows it writes. Claude Code sends the value to Claude as advice, not an enforced cap: `"small"` asks for fewer than 5 agents, `"medium"` fewer than 15, and `"large"` fewer than 50. Choose `"small"` when you want to bound what a workflow spends. Requires Claude Code v2.1.219 or later.

* **Scope**: [`Any file`](#scopes). A value there takes precedence over the **Dynamic workflow size** choice in `/config`, which Claude Code stores in `~/.claude.json`, and Claude Code hides that row while a settings file sets the key.
* **Type**: string, one of:
  * `"unrestricted"`: no guideline, so Claude sizes the workflow to the task
  * `"small"`: Claude aims for fewer than 5 agents
  * `"medium"`: Claude aims for fewer than 15 agents
  * `"large"`: Claude aims for fewer than 50 agents
* **Default**: `"medium"`

```json settings.json theme={null}
{
  "workflowSizeGuideline": "small"
}
```

Requires Claude Code v2.1.219 or later; on v2.1.202 through v2.1.218, set the guideline in `/config` instead.

<span id="plugin-configuration" />

<span id="manage-plugins" />

<span id="plugin-settings" />

## Plugins and skills

Enable plugins, register marketplaces, restrict which plugin sources an organization allows, and control which skills load. For installing and building plugins, see [Plugins](/docs/en/plugins).

### `disableBundledSkills`

Turn off the [skills](/docs/en/skills) and workflows included with Claude Code. Claude Code removes bundled skills and workflows entirely, while built-in commands such as `/init` stay typable but are hidden from the model.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code removes bundled skills and workflows and hides built-in commands such as `/init` from the model
  * `false`: bundled skills load
* **Default**: unset, so bundled skills load
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`](/docs/en/env-vars) set to `1` turns bundled skills off for one session; whichever of the two turns them off, the other can't turn them back on

```json settings.json theme={null}
{
  "disableBundledSkills": true
}
```

Skills from plugins, `.claude/skills/`, and `.claude/commands/` are unaffected. `/doctor` stays typable like the built-in commands; to hide it, set [`DISABLE_DOCTOR_COMMAND`](/docs/en/env-vars) instead.

### `disableSkillShellExecution`

Turn off inline shell execution for `` !`...` `` and ` ```! ` blocks in [skills](/en/skills) and custom commands from user, project, plugin, or additional-directory sources. Claude Code replaces each command with `[shell command execution disabled by policy]` instead of running it.

* **Scope**: [`Any file`](#scopes). A `true` in managed settings can't be overridden by `false` elsewhere.
* **Type**: Boolean
  * `true`: Claude Code replaces each inline shell command with `[shell command execution disabled by policy]` instead of running it
  * `false`: inline shell runs
* **Default**: unset, so inline shell runs

```json settings.json theme={null}
{
  "disableSkillShellExecution": true
}
```

Bundled skills and skills deployed through managed settings are unaffected.

### `skillOverrides`

Hide or collapse a [skill](/docs/en/skills#override-skill-visibility-from-settings) without editing its `SKILL.md`. Claude Code applies the value under each skill's name to the skill list Claude sees and to your `/` autocomplete.

* **Scope**: [`Any file`](#scopes). The `/skills` menu writes to `.claude/settings.local.json`.
* **Type**: object mapping skill name to one of:
  * `"on"`: Claude sees the skill and you can type `/name`
  * `"name-only"`: Claude sees the skill by name without its description
  * `"user-invocable-only"`: Claude doesn't see the skill, but you can still type `/name`
  * `"off"`: Claude doesn't see the skill and `/name` is hidden from autocomplete
* **Default**: unset, so every skill is `"on"`

This example lists `legacy-context` to Claude by name only and hides `deploy` from Claude and from `/` autocomplete:

```json settings.json theme={null}
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "off"
  }
}
```

`"name-only"` lists the skill to the model without its description, `"user-invocable-only"` hides it from the model but keeps `/name` typable, and `"off"` hides it from both. Overrides don't apply to plugin skills, which you manage through `/plugin`.

### `syncClaudeAiSkills`

Turn off the download of the [skills you enable on claude.ai](/docs/en/skills#how-synced-skills-behave). Claude Code downloads them into `~/.claude/skills/synced/` when you run it in [non-interactive mode](/docs/en/headless) with the `-p` flag and [`CLAUDE_CODE_SYNC_SKILLS`](/docs/en/env-vars#variables) set. Set `false` to stop that download and hide the skills it already synced. Claude Code honors only `false`: `true` is the same as unset and doesn't turn syncing on.

* **Scope**: [`User, local, or managed`](#scopes). A repository can't turn it off for you.
* **Type**: Boolean
  * `false`: Claude Code stops downloading synced skills and hides the ones already in `~/.claude/skills/synced/`. In user or managed settings, it also moves them to `~/.claude/skills/.trash/`
  * `true`: the same as unset
* **Default**: unset, so a non-interactive run with `CLAUDE_CODE_SYNC_SKILLS` set downloads the skills

This example keeps a machine from downloading the account's skills, whatever a session sets in its environment:

```json settings.json theme={null}
{
  "syncClaudeAiSkills": false
}
```

### `allowedChannelPlugins`

Choose which [channel](/docs/en/channels) plugins can push messages into sessions in your organization. When you set it, Claude Code uses your list in place of the default Anthropic allowlist; each entry names a plugin and the marketplace it comes from.

* **Scope**: [`Managed`](#scopes)
* **Type**: array of objects, each with `marketplace` and `plugin` strings
* **Default**: unset, so Claude Code uses the default Anthropic allowlist

This example turns channels on and allows only the Telegram plugin from the official Anthropic marketplace:

```json managed-settings.json theme={null}
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "telegram" }
  ]
}
```

An empty array blocks every channel plugin. This key takes effect once channels pass the [`channelsEnabled`](#channelsenabled) gate for the account: on Team and Enterprise plans, and on Console accounts with managed settings, that means `channelsEnabled: true`. See [Restrict which channel plugins can run](/docs/en/channels#restrict-which-channel-plugins-can-run).

### `blockedMarketplaces`

Block plugin marketplace sources for your organization. Claude Code checks the blocklist on marketplace add and on plugin install, update, refresh, and auto-update, so a marketplace someone added before you set the policy can't be used to fetch plugins either. Blocked sources are checked before download, so they never touch the filesystem.

* **Scope**: [`Managed`](#scopes)
* **Type**: array of marketplace source objects, in the same forms as [`strictKnownMarketplaces`](#allowed-source-types)
* **Default**: unset, so no marketplace is blocked

This example blocks one GitHub repository as a marketplace source:

```json managed-settings.json theme={null}
{
  "blockedMarketplaces": [
    { "source": "github", "repo": "untrusted/plugins" }
  ]
}
```

A `github` entry may use the [owner-wildcard form](#owner-wildcards) `"owner/*"` to block every repository under that GitHub owner, which requires Claude Code v2.1.223 or later. Add `{ "source": "skills-dir" }` to stop Claude Code loading [`@skills-dir` plugins](/docs/en/plugins-reference#skills-directory-plugins) from `~/.claude/skills/` without restricting any marketplace. See [Managed marketplace restrictions](/docs/en/plugin-marketplaces#managed-marketplace-restrictions).

### `channelsEnabled`

Allow [channels](/docs/en/channels) for your organization. On claude.ai Team and Enterprise plans, Claude Code blocks channels until you set this to `true`. For [Anthropic Console](/docs/en/authentication#claude-console-authentication) accounts that authenticate with an API key, channels are allowed by default. If your organization deploys managed settings, Claude Code blocks channels on those accounts too until you set this key to `true`.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code allows channels for your organization
  * `false`: the same as unset; whether channels are blocked depends on your plan, as the Default says
* **Default**: unset; channels are blocked on Team and Enterprise plans and on Console accounts with managed settings, and allowed on Pro and Max plans and on Console accounts without managed settings

```json managed-settings.json theme={null}
{
  "channelsEnabled": true
}
```

To restrict which plugins can register as channels once they're enabled, set [`allowedChannelPlugins`](#allowedchannelplugins). See [Enterprise controls](/docs/en/channels#enterprise-controls).

### `disableCommandPluginSources`

Block the [`command` plugin source](/docs/en/plugin-marketplaces#command-sources), which installs a plugin by running a marketplace-declared command on the user's machine. When you set it to `true`, Claude Code never runs the command, doesn't install or update command-sourced plugins, and stops loading the ones already installed. Set it to `false` to allow them explicitly. Whenever it blocks command sources, whether you set it to `true` or leave it unset under [`allowManagedHooksOnly`](#allowmanagedhooksonly), it also blocks marketplace [`headersHelper` commands](/docs/en/plugin-marketplaces#authenticate-archive-downloads), except for a marketplace that managed settings themselves declare. Requires Claude Code v2.1.229 or later, and the `headersHelper` block requires v2.1.238 or later.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code never runs the marketplace-declared command, doesn't install or update command-sourced plugins, and stops loading the ones already installed
  * `false`: Claude Code allows command-sourced plugins explicitly
* **Default**: unset, so Claude Code follows [`allowManagedHooksOnly`](#allowmanagedhooksonly): an organization that restricts hook execution to managed settings gets command sources disabled too

```json managed-settings.json theme={null}
{
  "disableCommandPluginSources": true
}
```

Requires Claude Code v2.1.229 or later.

### `pluginSuggestionMarketplaces`

Name the marketplaces whose plugins can appear as contextual install suggestions, in spinner tips and pinned at the top of the `/plugin` **Discover** tab. The built-in first-party frontend-design tip is unaffected. Suggestions come from each plugin's `relevance` declaration in its marketplace entry.

* **Scope**: [`Managed`](#scopes)
* **Type**: array of marketplace names
* **Default**: unset, so no marketplace-declared suggestions surface

```json managed-settings.json theme={null}
{
  "pluginSuggestionMarketplaces": ["acme-corp-plugins"]
}
```

A name takes effect only when the marketplace is registered on the machine and its registered source is also declared in the same managed settings, either as the [`extraKnownMarketplaces`](#extraknownmarketplaces) entry for that name or as an entry of [`strictKnownMarketplaces`](#strictknownmarketplaces). Claude Code ignores a marketplace registered from a different source under an allowlisted name. The official marketplace is exempt from the source requirement: allowlisting its name alone suffices, since that name can only register from the official Anthropic source. See [Suggest plugins by context](/docs/en/plugin-relevance).

### `pluginTrustMessage`

Add your organization's own text to the plugin trust warning Claude Code shows before installation, for example to confirm that plugins from your internal marketplace are vetted.

* **Scope**: [`Managed`](#scopes)
* **Type**: string
* **Default**: unset, so Claude Code shows the standard warning alone

```json managed-settings.json theme={null}
{
  "pluginTrustMessage": "All plugins from our marketplace are approved by IT"
}
```

### `strictKnownMarketplaces`

Restrict which plugin marketplace sources people in your organization can add and install plugins from. Claude Code enforces the allowlist on marketplace add and on plugin install, update, refresh, and auto-update, before any network or filesystem operation, so a marketplace someone added before you set the policy can't be used to fetch plugins once its source no longer matches. Blocked users see an error naming the managed policy.

* **Scope**: [`Managed`](#scopes)
* **Type**: array of marketplace source objects; see [Allowed source types](#allowed-source-types)
* **Default**: unset, so users can add any marketplace. An empty array is a complete lockdown that blocks every marketplace source, including the official Anthropic marketplace

This example allows two GitHub repositories, one pinned to the `v2.0` ref, and one hosted `marketplace.json` URL:

```json managed-settings.json theme={null}
{
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "acme-corp/approved-plugins" },
    { "source": "github", "repo": "acme-corp/security-tools", "ref": "v2.0" },
    { "source": "url", "url": "https://plugins.example.com/marketplace.json" }
  ]
}
```

You can also write this key as `allowedMarketplaces`; [Marketplace key aliases](#marketplace-key-aliases) describes how Claude Code treats the alias and which version accepts it. This key is a policy gate: it controls what users may add but registers nothing. To restrict and pre-register in one file, see [Combine with `extraKnownMarketplaces`](#combine-with-extraknownmarketplaces). For the user-facing view, see [Managed marketplace restrictions](/docs/en/plugin-marketplaces#managed-marketplace-restrictions).

#### Allowed source types

Each entry below shows one allowlist entry per source type and the fields it accepts. Most types match exactly; `hostPattern` and `pathPattern` match by regex, and `github` entries can use an [owner wildcard](#owner-wildcards).

| Source        | Example entry                                                                                                                   | Fields                                                                                         |
| :------------ | :------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------- |
| `github`      | `{ "source": "github", "repo": "acme-corp/plugins", "ref": "main", "path": "marketplace" }`                                     | `repo` required; `ref` is a branch or tag; `path` is a subdirectory                            |
| `git`         | `{ "source": "git", "url": "https://gitlab.example.com/tools/plugins.git", "ref": "production" }`                               | `url` required; `ref` and `path` as for `github`                                               |
| `url`         | `{ "source": "url", "url": "https://plugins.example.com/marketplace.json", "headers": { "Authorization": "Bearer ${TOKEN}" } }` | `url` required; `headers` adds HTTP headers for authenticated access                           |
| `npm`         | `{ "source": "npm", "package": "@acme-corp/claude-plugins" }`                                                                   | `package` required, the npm package that contains `marketplace.json`                           |
| `file`        | `{ "source": "file", "path": "/opt/acme-corp/plugins/marketplace.json" }`                                                       | `path` required, the absolute path to a `marketplace.json` file                                |
| `directory`   | `{ "source": "directory", "path": "/opt/acme-corp/approved-marketplaces" }`                                                     | `path` required, the absolute path to a directory containing `.claude-plugin/marketplace.json` |
| `hostPattern` | `{ "source": "hostPattern", "hostPattern": "^github\\.example\\.com$" }`                                                        | `hostPattern` required, a regex matched against the marketplace host                           |
| `pathPattern` | `{ "source": "pathPattern", "pathPattern": "^/opt/approved/" }`                                                                 | `pathPattern` required, a regex matched against the `path` of `file` and `directory` sources   |
| `skills-dir`  | `{ "source": "skills-dir" }`                                                                                                    | No fields. Opts the `~/.claude/skills/` plugin scan back in                                    |

Three source types carry rules beyond the table:

* **`url`**: a URL marketplace downloads only the `marketplace.json` file, and Claude Code doesn't fetch plugin files by relative path from that server, so its plugins must use a [plugin source](/docs/en/plugin-marketplaces#plugin-sources) other than a relative path, such as an archive URL, which can be on the same host. For plugins with relative paths, use a Git-based marketplace instead. See [Plugins with relative paths fail in URL-based marketplaces](/docs/en/plugin-marketplaces#plugins-with-relative-paths-fail-in-url-based-marketplaces).
* **`hostPattern`**: use it to allow every marketplace on an internal GitHub Enterprise or GitLab server without listing each repository. Claude Code matches `github` sources against `github.com`, takes the hostname from `url` sources, and takes it from `git` sources depending on the [git URL](https://git-scm.com/docs/git-clone#_git_urls)'s form:

  * A URL with a scheme, such as `https://` or `ssh://`: the hostname in the URL.
  * An SSH address without a scheme, in git's `user@host:path` form, such as `git@git.example.com:tools/plugins.git`: the host between `@` and `:`, which is the host git connects to.
  * Any other form without a scheme: no host, so no `strictKnownMarketplaces` `hostPattern` entry matches it. For a `blockedMarketplaces` `hostPattern`, Claude Code takes a host from a wider set of forms, so a blocklist entry can still match such a form. Before v2.1.234, a `strictKnownMarketplaces` `hostPattern` also matched some forms that git doesn't treat as SSH addresses.

  `file` and `directory` sources have no host and never match a `hostPattern` entry.
* **`pathPattern`**: use it to allow filesystem marketplaces alongside `hostPattern` entries for network sources. `".*"` allows every local path; a narrower pattern such as `"^/opt/approved/"` restricts to a directory.

Any allowlist, even an empty one, also stops Claude Code loading [`@skills-dir` plugins](/docs/en/plugins-reference#skills-directory-plugins) from `~/.claude/skills/`. Add the `{ "source": "skills-dir" }` entry to keep loading them; the entry has no meaning outside this key and `blockedMarketplaces`.

#### Owner wildcards

A `github` entry whose `repo` value is `"<owner>/*"` matches every repository under that GitHub owner. Owner wildcards require Claude Code v2.1.223 or later and work only in `strictKnownMarketplaces` and `blockedMarketplaces`. Everywhere else a `github` source appears, such as `extraKnownMarketplaces` or `/plugin marketplace add`, the `repo` value must name a single repository. Before v2.1.223, Claude Code compared the entry literally, so an allowlist entry matched no repository and a blocklist entry blocked nothing; single-repository entries are enforced on every version.

This entry allows any marketplace repository in the `acme-corp` organization:

```json managed-settings.json theme={null}
{
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "acme-corp/*" }
  ]
}
```

Only the whole repository-name position can be a wildcard. Claude Code compares entries such as `*`, `*/plugins`, or `acme-corp/tools-*` literally, so they match no repository.

The matching rules differ between the two settings:

| Rule                      | `strictKnownMarketplaces`                                                                                                                                             | `blockedMarketplaces`                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Matching source spellings | `owner/repo` form only. A git URL that clones the same repository doesn't match                                                                                       | Any spelling, including git URLs that resolve to the same github.com repository |
| Owner case                | Case-sensitive, like exact-entry matching                                                                                                                             | Case-insensitive                                                                |
| `ref`                     | Follows the exact-entry rules: an entry with a `ref` matches only sources with that exact ref, and an entry without one matches only sources that don't specify a ref | An entry without a `ref` blocks all refs of the repositories it matches         |
| `path`                    | Looser than the exact-entry rules: an entry with a `path` requires that exact value, while an entry without one matches any path inside the repository                | An entry without a `path` blocks all paths of the repositories it matches       |

#### Exact matching

For every source type except owner-wildcard `github` entries and the regex-matched `hostPattern` and `pathPattern` entries, Claude Code allows a user's addition only when the marketplace source matches an entry exactly. For the git-based sources `github` and `git`, exact matching includes the optional fields:

* The `repo` or `url` must match exactly
* The `ref` field must match exactly, or both must be undefined
* The `path` field must match exactly, or both must be undefined

For example, Claude Code treats each pair below as two different sources:

* `{ "source": "github", "repo": "acme-corp/plugins" }` and `{ "source": "github", "repo": "acme-corp/plugins", "ref": "main" }`
* `{ "source": "github", "repo": "acme-corp/plugins", "path": "marketplace" }` and `{ "source": "github", "repo": "acme-corp/plugins" }`

#### Allow only the official marketplace

To allow the official Anthropic marketplace and nothing else, list its repository:

```json managed-settings.json theme={null}
{
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "anthropics/claude-plugins-official" }
  ]
}
```

With this entry, Claude Code keeps an already-registered official marketplace available and, on a fresh machine, registers the marketplace automatically the first time you start Claude Code interactively. Automatic registration most commonly misses:

* Non-interactive environments that run before the machine's first interactive launch.
* Machines where Claude Code already ran interactively under a policy that blocked the marketplace, such as the empty-array lockdown. Claude Code records the blocked attempt and doesn't retry after the policy changes.

On these machines, add the marketplace to [`extraKnownMarketplaces`](#extraknownmarketplaces) in the same `managed-settings.json` so Claude Code registers it automatically, or run `claude plugin marketplace add anthropics/claude-plugins-official`.

#### Combine with `extraKnownMarketplaces`

The two keys do different jobs. This table compares them:

| Aspect            | `strictKnownMarketplaces`                | `extraKnownMarketplaces`                                                                             |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Purpose           | Organizational policy enforcement        | Team convenience                                                                                     |
| Settings file     | Managed settings only                    | Any settings file                                                                                    |
| Behavior          | Blocks non-allowlisted additions         | Registers missing marketplaces                                                                       |
| When enforced     | Before network and filesystem operations | Immediately from user or managed settings; after the workspace trust dialog for a repository's files |
| Can be overridden | No, highest precedence                   | Yes, by higher-precedence settings                                                                   |
| Source format     | Direct source object                     | Named marketplace with a nested `source` object                                                      |

To both restrict and pre-register a marketplace for all users, set both in `managed-settings.json`:

```json managed-settings.json theme={null}
{
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "acme-corp/plugins" }
  ],
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": { "source": "github", "repo": "acme-corp/plugins" }
    }
  }
}
```

With only `strictKnownMarketplaces` set, users can still add an allowed marketplace themselves with `/plugin marketplace add`. The official Anthropic marketplace is the only one Claude Code registers automatically, and only when the allowlist allows it. [Allow only the official marketplace](#allow-only-the-official-marketplace) lists the machines it misses.

### `strictPluginOnlyCustomization`

Block skills, agents, hooks, and MCP servers from user and project sources, so they can come only from plugins or managed settings. Combine it with [`strictKnownMarketplaces`](#strictknownmarketplaces) to control the full customization supply chain: the marketplace allowlist controls which plugins users can install.

* **Scope**: [`Managed`](#scopes)
* **Type**: `true` to lock all four kinds of customization, or an array naming the kinds to lock, from `"skills"`, `"agents"`, `"hooks"`, and `"mcp"`
* **Default**: unset, so nothing is locked

This example locks skills and hooks and leaves agents and MCP servers unlocked:

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["skills", "hooks"]
}
```

The four sub-key entries below list what each surface blocks and what still loads. Claude Code ignores surface names it doesn't recognize rather than failing the settings file, so you can add new surface names before every client has updated.

### `strictPluginOnlyCustomization.skills`

Lock the `skills` surface. Claude Code stops loading skills from `~/.claude/skills/` and `.claude/skills/`, custom commands from `~/.claude/commands/` and `.claude/commands/`, skills under `--add-dir` directories, and skills synced from your claude.ai account, and keeps loading plugin skills, bundled skills, and skills in the managed policy directory.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"skills"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["skills"]
}
```

### `strictPluginOnlyCustomization.agents`

Lock the `agents` surface. Claude Code stops loading agents from `~/.claude/agents/` and `.claude/agents/`, and keeps loading plugin agents, built-in agents, and agents in the managed policy directory.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"agents"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["agents"]
}
```

### `strictPluginOnlyCustomization.hooks`

Lock the `hooks` surface. Claude Code stops running hooks from user, project, and local `settings.json`, and keeps running plugin hooks and hooks in managed settings.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"hooks"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["hooks"]
}
```

### `strictPluginOnlyCustomization.mcp`

Lock the `mcp` surface. Claude Code stops loading MCP servers from `~/.claude.json` and `.mcp.json`, and keeps loading plugin MCP servers and [`managed-mcp.json`](/docs/en/managed-mcp) servers.

* **Scope**: [`Managed`](#scopes)
* **Type**: the string `"mcp"` in the [`strictPluginOnlyCustomization`](#strictpluginonlycustomization) array
* **Default**: not locked

```json managed-settings.json theme={null}
{
  "strictPluginOnlyCustomization": ["mcp"]
}
```

### `enabledPlugins`

Turn individual [plugins](/docs/en/plugins) on or off, keyed by `plugin-name@marketplace-name`. A plugin with no entry at any scope falls back to its [`defaultEnabled`](/docs/en/plugins-reference#default-enablement) value. When you enable or disable a plugin with `/plugin` or `claude plugin enable`, Claude Code writes this key for you.

* **Scope**: [`Any file`](#scopes)
* **Type**: object mapping `plugin-name@marketplace-name` to a Boolean
* **Default**: unset, so each plugin follows its `defaultEnabled` value

This example enables two plugins from the `team-tools` marketplace and disables one from `personal`:

```json settings.json theme={null}
{
  "enabledPlugins": {
    "code-formatter@team-tools": true,
    "deployment-tools@team-tools": true,
    "experimental-features@personal": false
  }
}
```

Each scope serves a different purpose:

* **User settings**: your personal plugin preferences
* **Project settings**: plugins shared with everyone in the repository
* **Local settings**: per-machine overrides, gitignored when Claude Code saves a setting there
* **Managed settings**: organization-wide policy. A plugin set to `false` here is blocked from installation at every scope and hidden from the marketplace

Project settings take precedence over user settings, so setting a plugin to `false` in `~/.claude/settings.json` doesn't disable a plugin that the project's `.claude/settings.json` enables. To opt out of a project-enabled plugin on your machine, set it to `false` in `.claude/settings.local.json` instead. Plugins force-enabled by managed settings can't be disabled this way, since managed settings override local settings.

Enabling a plugin from an external source such as a GitHub repository or npm package in a project's `.claude/settings.json` doesn't install it for other people. On every path that loads plugins, Claude Code reports the plugin as not installed until each user [installs it themselves](/docs/en/discover-plugins#configure-team-marketplaces).

### `extraKnownMarketplaces`

Register additional plugin marketplaces by name, so that people who open the repository, or everyone your managed settings reach, get the marketplace without adding it themselves. Claude Code registers each marketplace it doesn't already know. Whether a plugin that [`enabledPlugins`](#enabledplugins) names from it installs depends on the plugin's source and which file enables it; that entry has the rules.

* **Scope**: [`Any file`](#scopes). Claude Code honors entries in a repository's `.claude/settings.json` or `.claude/settings.local.json` only after you accept the workspace trust dialog for that folder; in a folder you haven't trusted, including a `-p` run there, it ignores them without a message.
* **Type**: object mapping a marketplace name to an object with a `source` object and an optional `autoUpdate` Boolean
* **Default**: unset

This example registers a GitHub marketplace and a marketplace from a self-hosted git URL:

```json settings.json theme={null}
{
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": {
        "source": "github",
        "repo": "acme-corp/claude-plugins"
      }
    },
    "security-plugins": {
      "source": {
        "source": "git",
        "url": "https://git.example.com/security/plugins.git"
      }
    }
  }
}
```

[What runs before you trust a folder](/docs/en/permissions#what-runs-before-you-trust-a-folder) compares the trust gate with the other content a repository can supply. You can also write this key as `additionalMarketplaces`; see [Marketplace key aliases](#marketplace-key-aliases).

Set `"autoUpdate": true` alongside `source` to make Claude Code refresh that marketplace and update its installed plugins in the background after startup. When omitted, `claude-plugins-official` and most other official Anthropic marketplaces default to `true`, and third-party marketplaces default to `false`. See [Configure auto-updates](/docs/en/discover-plugins#configure-auto-updates).

When more than one settings file defines a marketplace entry under the same name, Claude Code uses the entry from the [highest-precedence file](/docs/en/settings#settings-precedence) whole. That entry replaces the lower-precedence entry and inherits none of its fields, so a redefinition can't combine one file's `source.headers` credential with a URL another file controls. Before v2.1.228, Claude Code merged same-name entries field by field, so an entry in a higher-precedence file could inherit fields it didn't set, including another file's `headers`.

#### Marketplace source types

The `source` object takes one of these forms:

* **`github`**: a GitHub repository, with `repo`
* **`git`**: any git URL, with `url`
* **`url`**: a direct URL to a `marketplace.json` file, with `url` and optional `headers` and `headersHelper` for authenticated access. `headersHelper` names a command that prints headers whose values are too short-lived to list in `headers`, and requires Claude Code v2.1.238 or later
* **`file`**: a local path to a `marketplace.json` file, with `path`
* **`directory`**: a local filesystem path, with `path`, for development only
* **`settings`**: an inline marketplace declared directly in the settings file without a hosted repository, with `name` and `plugins`

The `git` source type works with any git hosting service, including self-hosted GitLab and Bitbucket. Claude Code clones the repository with the same authentication that `git clone` would use on that machine: configured credential helpers or SSH keys. A provider token such as `GITHUB_TOKEN` takes effect only through a credential helper that reads it. See [Private repositories](/docs/en/plugin-marketplaces#private-repositories) for setup details.

For `github` and `git` sources, set `"skipLfs": true` inside the `source` object, alongside `repo` or `url`, to skip Git LFS downloads when Claude Code clones or updates the marketplace repository. LFS pointer files remain as pointers instead of downloading their content. Use this when the repository contains large LFS objects unrelated to plugin content.

For a `url` source, set `headersHelper` inside the `source` object when the credential in `headers` expires and a command has to produce a fresh one. Requires Claude Code v2.1.238 or later. For what the command must print and where Claude Code runs it, see [Write the headersHelper command](/docs/en/plugin-marketplaces#write-the-headershelper-command), and for the cases where Claude Code doesn't run it, see [When Claude Code skips a headersHelper command](/docs/en/plugin-marketplaces#when-claude-code-skips-a-headershelper-command-or-drops-its-output). Once you set `headersHelper` on an `https://` marketplace URL, Claude Code runs the command at two points, reusing one run's output for up to 60 seconds:

* Before each fetch of that marketplace's `marketplace.json`, including a later refresh. Claude Code sends the printed headers with that fetch.
* Before each plugin archive download on the marketplace URL's origin, meaning the same scheme, host, and port. Claude Code sends the output with that download, and no other download gets the headers.

Claude Code ignores any `headersHelper` set in the `.claude/settings.json` or `.claude/settings.local.json` of a directory you add with [`--add-dir`](/docs/en/permissions#what-runs-before-you-trust-a-folder), on a `url` source and on an inline plugin entry alike, and sends only the fixed `headers` set in that file. [How users accept a headersHelper command](/docs/en/plugin-marketplaces#how-users-accept-a-headershelper-command) covers the other settings files.

Plugins listed in a `settings` source must reference external sources such as GitHub or npm, and the `name` must match the marketplace key. You still enable each plugin separately in `enabledPlugins`. This example declares one plugin inline:

```json settings.json theme={null}
{
  "extraKnownMarketplaces": {
    "team-tools": {
      "source": {
        "source": "settings",
        "name": "team-tools",
        "plugins": [
          {
            "name": "code-formatter",
            "source": {
              "source": "github",
              "repo": "acme-corp/code-formatter"
            }
          }
        ]
      }
    }
  }
}
```

A plugin entry under `source: 'settings'` whose own `source` is an [`archive`](/docs/en/plugin-marketplaces#zip-archives) can set `headers` for the archive download. If the value you would put in `headers` is short-lived, such as a token your registry mints on request, set a `headersHelper` command instead. An entry may set both. Both fields require Claude Code v2.1.238 or later.

Claude Code sends the entry's `headers`, and whatever the command prints, with that plugin's archive download and with no other download. Claude Code runs the command only when a user [installs or updates that one plugin by itself](/docs/en/plugin-marketplaces#how-users-accept-a-headershelper-command). Three further rules depend on which file holds the entry:

* **`strict`**: unlike an entry in a marketplace's `marketplace.json`, an entry in settings doesn't need `"strict": false`, because a settings file carries no manifest fields to inline. See [Strict mode](/docs/en/plugin-marketplaces#strict-mode).
* **Folder trust**: for an entry in a project's `.claude/settings.json` or `.claude/settings.local.json`, Claude Code runs the command only after the user has also [trusted that folder](/docs/en/permissions#what-runs-before-you-trust-a-folder).
* **Header filter**: Claude Code drops [request-routing and client-identity header names](/docs/en/plugin-marketplaces#when-claude-code-skips-a-headershelper-command-or-drops-its-output) from an entry in a project's `.claude/settings.json` or `.claude/settings.local.json`, because a repository can supply those files. Claude Code applies the same filter to a catalog entry and to an entry in an `--add-dir` directory's settings, and no filter to an entry in your user settings, a `--settings` file, or managed settings.

#### Marketplace key aliases

On Claude Code v2.1.232 or later, you can write `extraKnownMarketplaces` as `additionalMarketplaces` and `strictKnownMarketplaces` as `allowedMarketplaces`. Claude Code treats each alias as follows:

* Earlier versions ignore the alias, so keep the canonical spelling in a file that older versions also read, such as a managed settings file for a fleet with mixed Claude Code versions.
* In any settings file that accepts the canonical key, Claude Code reads the alias exactly as it reads the canonical key.
* Claude Code may rewrite `additionalMarketplaces` to `extraKnownMarketplaces` when it updates the file.
* If you set both spellings in one file, Claude Code uses the canonical value and ignores the alias.

### `pluginConfigs`

Store the non-sensitive answers you give a plugin's [`userConfig`](/docs/en/plugins-reference#user-configuration) configuration dialog, keyed by plugin ID. Claude Code writes this key to your user settings when you fill in the dialog, so you don't need to edit it by hand. Sensitive options go to the macOS Keychain instead, or to `~/.claude/.credentials.json` on platforms without a supported keychain.

* **Scope**: [`User or managed`](#scopes)
* **Type**: object mapping a plugin ID to an object with an `options` field, mapping each option name to a string, number, Boolean, or array of strings, and an optional `mcpServers` field holding per-server user configuration values in the same shape
* **Default**: unset

This example stores the `api_endpoint` option for the `deployer` plugin from `acme-tools`:

```json settings.json theme={null}
{
  "pluginConfigs": {
    "deployer@acme-tools": {
      "options": {
        "api_endpoint": "https://api.example.com"
      }
    }
  }
}
```

Claude Code ignores project and local entries because it substitutes these values into plugin hook, MCP, and LSP configurations, and a cloned repository must not be able to supply them. Before v2.1.207, project and local settings were also read.

## MCP

Control which MCP servers Claude Code connects to and which an organization allows. See [Connect to external tools with MCP](/docs/en/mcp) and [Managed MCP configuration](/docs/en/managed-mcp).

### `allowAllClaudeAiMcps`

Load the [claude.ai connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai) Claude Code fetches itself alongside a deployed `managed-mcp.json`. Without this key, `managed-mcp.json` takes exclusive control of MCP servers and suppresses those connectors.

* **Scope**: [`Managed`](#scopes). Users can't re-enable connectors that exclusive control suppressed.
* **Type**: Boolean
  * `true`: Claude Code loads the claude.ai connectors alongside a deployed `managed-mcp.json`
  * `false`: a deployed `managed-mcp.json` takes exclusive control of MCP servers and suppresses the claude.ai connectors [Claude Code fetches itself](/docs/en/mcp#how-connectors-reach-claude-code)
* **Default**: `false`, so a deployed `managed-mcp.json` suppresses the claude.ai connectors Claude Code fetches itself

```json managed-settings.json theme={null}
{
  "allowAllClaudeAiMcps": true
}
```

[`allowedMcpServers`](#allowedmcpservers) and [`deniedMcpServers`](#deniedmcpservers) still apply to the connectors this key loads. Connectors delivered to a [cloud session](/docs/en/claude-code-on-the-web) whose host carries a `managed-mcp.json`, such as a self-hosted runner, stay suppressed. See [Allow claude.ai connectors alongside the managed set](/docs/en/managed-mcp#allow-claude-ai-connectors-alongside-the-managed-set).

### `allowedMcpServers`

Allowlist the MCP servers people can use. Claude Code blocks any server that doesn't match an entry wherever it's defined, including plugin servers, servers passed with `--mcp-config`, and servers from `managed-mcp.json`. Built-in servers such as Claude in Chrome, the `ide` server Claude Code connects to in a running [VS Code](/docs/en/vs-code#the-built-in-ide-mcp-server) or [JetBrains](/docs/en/jetbrains#the-built-in-ide-mcp-server) IDE, and servers the CLI itself configures are exempt from the allowlist, and the denylist still applies to them. In-process `type: "sdk"` servers, which the [app that started the session registers](/docs/en/mcp#how-connectors-reach-claude-code), are exempt from both lists.

* **Scope**: [`Any file`](#scopes). Entries from every file merge into one allowlist unless [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly) is set. Deploy it in managed settings to enforce it.
* **Type**: array of objects, each with exactly one key: `serverName`, a string limited to letters, numbers, hyphens, and underscores; `serverCommand`, an array of the command and its arguments matched exactly; or `serverUrl`, a URL pattern with `*` wildcards
* **Default**: unset, so every server is allowed; an empty array blocks every server

This example allows only the stdio server that the listed `npx` command starts:

```json settings.json theme={null}
{
  "allowedMcpServers": [
    { "serverCommand": ["npx", "-y", "@modelcontextprotocol/server-filesystem"] }
  ]
}
```

A [`deniedMcpServers`](#deniedmcpservers) entry takes precedence, so a server on both lists is blocked. Once the list contains any `serverCommand` entry, a stdio server must match a `serverCommand` entry, and once it contains any `serverUrl` entry, a remote server must match a `serverUrl` entry: a `serverName` match no longer admits that kind of server. See [Policy-based control with allowlists and denylists](/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists).

### `allowManagedMcpServersOnly`

Make the managed allowlist the only one that applies. Claude Code then reads [`allowedMcpServers`](#allowedmcpservers) from managed settings alone and ignores allowlists in user, project, and local settings; [`deniedMcpServers`](#deniedmcpservers) still merges from every file, so users can still block servers for themselves. Administrators set it so a user's own settings can't broaden what the managed allowlist permits.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code reads `allowedMcpServers` from managed settings alone and ignores allowlists in user, project, and local settings
  * `false`: allowlists from every settings file merge
* **Default**: `false`, so allowlists from every settings file merge

This example locks the allowlist to managed settings and allows only the server named `github`:

```json managed-settings.json theme={null}
{
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [
    { "serverName": "github" }
  ]
}
```

Users can still add MCP servers of their own; only servers that match the managed allowlist load. See [Restrict the allowlist to managed settings only](/docs/en/managed-mcp#restrict-the-allowlist-to-managed-settings-only).

### `deniedMcpServers`

Block specific MCP servers. Claude Code refuses to load a matching server wherever it's defined, including plugin servers, servers passed with `--mcp-config`, servers from `managed-mcp.json`, and the claude.ai connectors [it fetches itself](/docs/en/mcp#how-connectors-reach-claude-code). In-process `type: "sdk"` servers, which the app that started the session registers, are exempt.

* **Scope**: [`Any file`](#scopes). Entries from every file merge into one denylist, and [`allowManagedMcpServersOnly`](#allowmanagedmcpserversonly) doesn't change that. Deploy it in managed settings to enforce it.
* **Type**: array of objects, each with exactly one key: `serverName`, any non-empty string, so a claude.ai connector's display name such as `"claude.ai Slack"` works; `serverCommand`, an array of the command and its arguments matched exactly; or `serverUrl`, a URL pattern with `*` wildcards
* **Default**: unset, so no server is blocked; an empty array also blocks nothing

```json settings.json theme={null}
{
  "deniedMcpServers": [
    { "serverName": "filesystem" }
  ]
}
```

The denylist takes precedence over [`allowedMcpServers`](#allowedmcpservers), so a server on both lists is blocked. See [Policy-based control with allowlists and denylists](/docs/en/managed-mcp#policy-based-control-with-allowlists-and-denylists).

### `disableClaudeAiConnectors`

Turn off the [claude.ai MCP connectors](/docs/en/mcp#use-mcp-servers-from-claude-ai) [Claude Code fetches itself](/docs/en/mcp#how-connectors-reach-claude-code), so it neither fetches nor connects them. A `true` in any settings file applies: a checked-in project `.claude/settings.json` can opt a repository out of those connectors, but a project-level `false` can't override a user- or managed-level `true`. Requires Claude Code v2.1.182 or later.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code neither fetches nor connects those connectors
  * `false`: the same as unset; Claude Code fetches your connectors unless another settings file or `ENABLE_CLAUDEAI_MCP_SERVERS` turns them off
* **Default**: `false`, so Claude Code fetches your connectors
* **Per-session overrides**: [`ENABLE_CLAUDEAI_MCP_SERVERS`](/docs/en/env-vars) set to `false` turns connectors off for one session; whichever of the two turns them off, the other can't turn them back on

```json settings.json theme={null}
{
  "disableClaudeAiConnectors": true
}
```

Servers you pass explicitly with `--mcp-config` are unaffected. To block individual connectors instead of all of them, use [`deniedMcpServers`](#deniedmcpservers). See [Disable claude.ai connectors](/docs/en/mcp#disable-claude-ai-connectors). Requires Claude Code v2.1.182 or later.

### `disabledMcpjsonServers`

Reject specific servers defined in a project's `.mcp.json` file so Claude Code never connects them or asks you to approve them. A rejection in any settings file applies, including a project `.claude/settings.json` checked into the repository.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, the server names as they appear in `.mcp.json`
* **Default**: unset

```json settings.json theme={null}
{
  "disabledMcpjsonServers": ["filesystem"]
}
```

Claude Code writes this key to `.claude/settings.local.json` when you reject a server in the approval dialog. `claude mcp get <name>` shows a rejected server as `✘ Rejected (see disabledMcpjsonServers in settings)`. Rejection takes precedence over [`enabledMcpjsonServers`](#enabledmcpjsonservers) and [`enableAllProjectMcpServers`](#enableallprojectmcpservers).

### `enableAllProjectMcpServers`

Approve every MCP server defined in project `.mcp.json` files without a prompt. Claude Code writes this key to `.claude/settings.local.json` when you choose to approve all servers in the approval dialog.

* **Scope**: [`Any file`](#scopes). In a folder whose trust dialog you haven't accepted, Claude Code honors it from user settings, managed settings, and `--settings` and ignores it in the shared project file, both in the session and for `claude mcp list` and `claude mcp get`; [Project server approvals and workspace trust](/docs/en/mcp#project-server-approvals-and-workspace-trust) says when an untracked `.claude/settings.local.json` counts too.
* **Type**: Boolean
  * `true`: Claude Code approves every MCP server defined in project `.mcp.json` files without a prompt
  * `false`: Claude Code asks you to approve each server. In a trusted folder, a `false` in a higher-precedence file overrides a `true` in a lower one; in a folder you haven't trusted, a `true` in any honored file is enough
* **Default**: unset, so Claude Code asks you to approve each server

```json settings.json theme={null}
{
  "enableAllProjectMcpServers": true
}
```

A [`disabledMcpjsonServers`](#disabledmcpjsonservers) entry still rejects a server.

### `enabledMcpjsonServers`

Approve specific servers defined in project `.mcp.json` files so Claude Code connects them without asking. Claude Code writes this key to `.claude/settings.local.json` when you approve a server in the approval dialog.

* **Scope**: [`Any file`](#scopes). In a folder whose trust dialog you haven't accepted, Claude Code honors it from user settings, managed settings, and `--settings` and ignores it in the shared project file, both in the session and for `claude mcp list` and `claude mcp get`; [Project server approvals and workspace trust](/docs/en/mcp#project-server-approvals-and-workspace-trust) says when an untracked `.claude/settings.local.json` counts too.
* **Type**: array of strings, the server names as they appear in `.mcp.json`
* **Default**: unset

This example approves the `memory` and `github` servers from the project's `.mcp.json`:

```json settings.json theme={null}
{
  "enabledMcpjsonServers": ["memory", "github"]
}
```

A [`disabledMcpjsonServers`](#disabledmcpjsonservers) entry still rejects a server.

## Agents, sessions, and worktrees

Set the default agent, control teammates and cross-session messaging, and configure worktrees. See [Subagents](/docs/en/sub-agents) and [Worktrees](/docs/en/worktrees).

### `agent`

Run the main thread as a named [subagent](/docs/en/sub-agents#invoke-subagents-explicitly), so Claude Code applies that subagent's system prompt, tool restrictions, and model to your session. The same key sets the default agent for sessions you dispatch from `claude agents`.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, the name of a built-in or custom agent
* **Default**: unset, so the main thread runs as Claude Code's default agent
* **Per-session overrides**: `--agent` takes precedence over this key for one session

```json settings.json theme={null}
{
  "agent": "code-reviewer"
}
```

A plugin's own `settings.json` can also supply this key; see [Ship default settings with your plugin](/docs/en/plugins#ship-default-settings-with-your-plugin).

### `crossSessionInbound`

Choose what this session does with [messages arriving from your other Claude Code sessions](/docs/en/cross-session-messaging#control-inbound-messages). When no value applies, Claude Code decides per message from the two sessions' permission-mode classes. Requires Claude Code v2.1.224 or later.

* **Scope**: [`Any file`](#scopes). A project or local value applies only when it's stricter than the value managed settings, the `--settings` flag, or user settings give.
* **Type**: string, one of:
  * `"accept"`: Claude Code delivers the message to Claude
  * `"hold"`: Claude Code shows a notice for the message without delivering it
  * `"refuse"`: Claude Code drops the message
* **Default**: unset, so Claude Code decides per message

```json settings.json theme={null}
{
  "crossSessionInbound": "hold"
}
```

Claude Code reads managed settings first, then the `--settings` flag, then user settings, and applies the first value found. `refuse` is stricter than `hold`, and `hold` is stricter than `accept`. When none of the trusted sources sets a value, a project or local `hold` or `refuse` still applies, replacing the per-message default. In sessions with cross-session messaging, this key appears in `/config` as **Messages from your other sessions**, which writes it to user settings; the row requires Claude Code v2.1.232 or later, and Claude Code hides it while the `--settings` flag or managed settings set the key.

Claude Code [warns](/docs/en/errors#crosssessioninbound-must-be-one-of-accept-hold-refuse) when you set a value it doesn't recognize. While that value is present in a user, project, local, or `--settings` file, Claude Code holds inbound messages, even when a source that takes precedence sets `accept`. A `refuse` that another source sets still applies. Fix or remove the value to clear the hold.

When the unrecognized value is in [managed settings](/docs/en/managed-settings), Claude Code instead treats it as `refuse` until an administrator fixes it. Before v2.1.248, Claude Code ignored an unrecognized value without warning.

### `disableAgentView`

Turn off [background agents and agent view](/docs/en/agent-view): `claude agents`, `--bg`, `/background`, and the on-demand supervisor. Set it in [managed settings](/docs/en/managed-settings) to enforce it for an organization.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns off `claude agents`, `--bg`, `/background`, and the on-demand supervisor
  * `false`: agent view is available
* **Default**: unset, so agent view is available
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_AGENT_VIEW`](/docs/en/env-vars) turns agent view off for one session; whichever of the two turns it off, the other can't turn it back on

```json settings.json theme={null}
{
  "disableAgentView": true
}
```

### `isolatePeerMachines`

Require your explicit approval before Claude's `SendMessage` reaches one of your sessions beyond this machine; see [Require approval for cross-machine messages](/docs/en/cross-session-messaging#require-approval-for-cross-machine-messages). The approval prompt appears even in [`bypassPermissions` mode](/docs/en/permission-modes#skip-all-checks-with-bypasspermissions-mode).

* **Scope**: [`Any file`](#scopes). A `true` from any scope applies, so a checked-in project file can turn the requirement on but not off.
* **Type**: Boolean
  * `true`: Claude Code asks for your approval before Claude's `SendMessage` reaches one of your sessions beyond this machine
  * `false`: cross-machine messages don't prompt
* **Default**: unset, so cross-machine messages don't prompt

```json settings.json theme={null}
{
  "isolatePeerMachines": true
}
```

The cross-machine `SendMessage` approval requires Claude Code v2.1.224 or later.

### `processWrapper`

On macOS and Linux, place a corporate launcher command in front of the [background processes Claude Code starts](/docs/en/corporate-launcher#what-the-launcher-covers). Claude Code runs the launcher with its own command line appended, so the launcher must exec into Claude Code; see [Run Claude Code behind a corporate launcher](/docs/en/corporate-launcher) for the launcher contract. Requires Claude Code v2.1.210 or later.

* **Scope**: [`User or managed`](#scopes)
* **Type**: string, the launcher command as an argv prefix, such as an absolute path with optional arguments
* **Default**: unset, so background processes start unwrapped
* **Per-session overrides**: [`CLAUDE_CODE_PROCESS_WRAPPER`](/docs/en/env-vars) takes precedence over this key for one session

```json settings.json theme={null}
{
  "processWrapper": "/opt/corp/launcher --profile claude"
}
```

Claude Code ignores the launcher on Windows and starts every process unwrapped. Requires Claude Code v2.1.210 or later.

### `teammateMode`

Choose where Claude Code shows [agent team](/docs/en/agent-teams) teammates: inside your main terminal pane, or in split panes when your terminal supports them. See [Choose a display mode](/docs/en/agent-teams#choose-a-display-mode).

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: string, one of:
  * `"in-process"`: teammates run inside your main terminal pane
  * `"auto"`: split panes when you're running inside tmux, or inside iTerm2 with `it2` on your `PATH` or tmux installed; in-process otherwise
  * `"tmux"`: split panes using tmux or iTerm2, detected from your terminal
  * `"iterm2"`: iTerm2 native split panes through the `it2` CLI, in Claude Code v2.1.186 or later
* **Default**: `"in-process"`
* **Per-session overrides**: `--teammate-mode` takes precedence over this key for one session

```json settings.json theme={null}
{
  "teammateMode": "auto"
}
```

Before v2.1.179, the default was `auto`. The `iterm2` value requires Claude Code v2.1.186 or later.

<span id="worktree-settings" />

### `worktree`

Configure how Claude Code creates and manages [git worktrees](/docs/en/worktrees) for `--worktree`, the `EnterWorktree` tool, and isolated subagents and background sessions.

* **Scope**: [`Any file`](#scopes)
* **Type**: object with `baseRef`, `symlinkDirectories`, `sparsePaths`, and `bgIsolation`
* **Default**: unset

This example branches new worktrees from your current `HEAD` and symlinks `node_modules` into each one:

```json settings.json theme={null}
{
  "worktree": {
    "baseRef": "head",
    "symlinkDirectories": ["node_modules"]
  }
}
```

To copy gitignored files like `.env` into new worktrees, add a [`.worktreeinclude` file](/docs/en/worktrees#copy-gitignored-files-into-worktrees) to your project root instead of a setting.

### `worktree.baseRef`

Choose which ref new worktrees branch from. `"fresh"` branches from `origin/<default-branch>` for a clean tree matching the remote; `"head"` branches from your current local `HEAD`, so unpushed commits and feature-branch state are present in the worktree.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"fresh"`: new worktrees branch from `origin/<default-branch>`
  * `"head"`: new worktrees branch from your current local `HEAD`, including unpushed commits
* **Default**: `"fresh"`

```json settings.json theme={null}
{
  "worktree": {
    "baseRef": "head"
  }
}
```

Inside a linked worktree, `"head"` resolves to that worktree's `HEAD`, not the main checkout's.

### `worktree.symlinkDirectories`

Symlink directories from the main repository into each worktree so you don't duplicate large directories on disk.

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, directory paths relative to the repository root
* **Default**: unset, so Claude Code symlinks no directories

This example symlinks `node_modules` and `.cache` from the main repository into every new worktree:

```json settings.json theme={null}
{
  "worktree": {
    "symlinkDirectories": ["node_modules", ".cache"]
  }
}
```

### `worktree.sparsePaths`

Check out only the listed directories in each worktree through git sparse-checkout. Claude Code writes only those directories plus root-level files to disk, which is faster in large monorepos; see [Check out only the directories you need](/docs/en/large-codebases#check-out-only-the-directories-you-need).

* **Scope**: [`Any file`](#scopes)
* **Type**: array of strings, directory paths relative to the repository root
* **Default**: unset, so each worktree checks out the whole tree

This example checks out only `packages/my-app` and `shared/utils`, plus root-level files, in each worktree:

```json settings.json theme={null}
{
  "worktree": {
    "sparsePaths": ["packages/my-app", "shared/utils"]
  }
}
```

While a sparse worktree exists, git enables `extensions.worktreeConfig` in the repository's shared `.git/config`.

### `worktree.bgIsolation`

Choose how [background sessions](/docs/en/agent-view#how-file-edits-are-isolated) isolate their file edits. With `"worktree"`, Claude Code blocks `Edit` and `Write` in the main checkout until the session calls `EnterWorktree`; with `"none"`, background jobs edit the working copy directly. Set `"none"` for a repository where git worktrees are impractical.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, one of:
  * `"worktree"`: Claude Code blocks `Edit` and `Write` in the main checkout until the session calls `EnterWorktree`
  * `"none"`: background jobs edit the working copy directly
* **Default**: `"worktree"`

```json settings.json theme={null}
{
  "worktree": {
    "bgIsolation": "none"
  }
}
```

Outside a git repository, a [`WorktreeCreate` hook](/docs/en/worktrees#non-git-version-control) that fails releases the block so the session can edit the working directory in place; that release requires Claude Code v2.1.203 or later.

## Remote, desktop, and notifications

Configure Remote Control, cloud environments, the desktop app, and the notifications Claude Code sends when it needs you. See [Remote Control](/docs/en/remote-control).

### `agentPushNotifEnabled`

Allow Claude to send a push notification to your phone when it decides one is worth sending, for example when a long task finishes. Claude Code syncs this choice to your account, and pushes arrive while [Remote Control](/docs/en/remote-control) is connected. Appears in `/config` as **Push when Claude decides**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: Boolean
  * `true`: Claude can send a push notification to your phone when it decides one is worth sending
  * `false`: Claude doesn't send those notifications
* **Default**: `false`

```json settings.json theme={null}
{
  "agentPushNotifEnabled": true
}
```

See [Mobile push notifications](/docs/en/remote-control#mobile-push-notifications).

### `awaySummaryEnabled`

Show a one-line session recap when you return to the terminal after a few minutes away. Set it to `false`, or turn off **Session recap** in `/config`, to stop the recap.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: you see a one-line session recap when you return after a few minutes away
  * `false`: Claude Code shows no recap
* **Default**: unset, so the recap is on
* **Per-session overrides**: [`CLAUDE_CODE_ENABLE_AWAY_SUMMARY`](/docs/en/env-vars) takes precedence over this key for one session, in either direction

```json settings.json theme={null}
{
  "awaySummaryEnabled": false
}
```

Claude Code never shows the recap in non-interactive mode.

### `disableArtifact`

<Warning>
  Deprecated, and replaced by [`enableArtifact`](#enableartifact). Claude Code still honors `disableArtifact: true` as equivalent to `enableArtifact: false`, and ignores `disableArtifact: false`.
</Warning>

Use [`enableArtifact`](#enableartifact) instead to turn off the [Artifact](/docs/en/artifacts) tool, which publishes session output as a private web page on claude.ai. When you turn the **Artifacts** row off in `/config`, Claude Code writes `enableArtifact` to your user settings and clears this key.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code turns the Artifact tool off for every session the file applies to, and no other file turns it back on. Before v2.1.242, a higher-precedence file could override a lower file's `true` rather than the key acting as a lock
  * `false`: ignored; to leave the tool on, remove the key
* **Default**: unset, so the tool follows your account's [availability](/docs/en/artifacts#availability)
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_ARTIFACT`](/docs/en/env-vars) set to `1` turns the tool off for one session

```json settings.json theme={null}
{
  "disableArtifact": true
}
```

[Disable artifacts](/docs/en/artifacts#disable-artifacts) lists every way to turn the tool off.

### `disableDeepLinkRegistration`

Stop Claude Code from registering the `claude-cli://` protocol handler with the operating system, which it otherwise does after you send the first prompt of an interactive session. [Deep links](/docs/en/deep-links) let external tools open a Claude Code session with a pre-filled prompt. Set this in environments where protocol handler registration is restricted or managed separately.

* **Scope**: [`Any file`](#scopes)
* **Type**: the string `"disable"`
* **Default**: unset, so Claude Code registers the handler

```json settings.json theme={null}
{
  "disableDeepLinkRegistration": "disable"
}
```

### `disableDesktopLocalSessions`

Turn off Code sessions that run on the device in the [desktop app](/docs/en/desktop#local-sessions-on-managed-devices), for deployments where developers should work on remote machines over SSH. In the Code tab, the **Local** environment stays in the environment dropdown but is grayed out and can't be selected, with a tooltip saying your organization turned it off; on Windows the WSL entry is grayed out the same way, though whether WSL sessions run on a managed device at all is [governed separately](/docs/en/admin-setup#wsl-sessions-in-claude-code-desktop). New sessions default to the first [SSH connection](/docs/en/desktop#ssh-sessions) if one is configured, and the app refuses to start or resume a session on the device, including an SSH connection back to the same machine. SSH sessions to other hosts and cloud sessions are unaffected. The desktop app reads this key; the terminal CLI ignores it. Requires Claude Desktop v1.37937.0 or later.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean; only the JSON Boolean `true` takes effect
  * `true`: the desktop app offers no on-device Code sessions; existing local sessions stay listed but can't continue
  * `false`: local sessions stay available
* **Default**: unset, so local sessions are available

```json managed-settings.json theme={null}
{
  "disableDesktopLocalSessions": true
}
```

The desktop app ignores any other value, and a value that isn't a Boolean, such as the string `"true"` or `1`, also logs a warning. Pair it with [`sshConfigs`](#sshconfigs) so users land on a working connection, and with [`sshHostAllowlist`](#sshhostallowlist) to limit which hosts they can reach. See [Local sessions on managed devices](/docs/en/desktop#local-sessions-on-managed-devices).

Claude Desktop supplies Code sessions with policy derived from your desktop configuration, for example the egress allowlist, filesystem sandbox, and MCP restrictions in third-party deployments. Claude Code ignores those parent settings whenever an [admin source](/docs/en/managed-settings#how-claude-code-combines-managed-sources) is present: server-managed settings, an MDM or OS-level policy, or a managed settings file. Deploying this key through one of those on a device that had none before, as in third-party deployments, therefore stops the desktop-derived policies from applying. [Let an embedding host add policy](/docs/en/managed-settings#let-an-embedding-host-add-policy) covers when parent settings can still merge; this holds for any key you deploy that way, not only this one.

### `disableRemoteControl`

Turn off [Remote Control](/docs/en/remote-control): Claude Code then refuses `claude remote-control`, the `--remote-control` flag, auto-start, and the in-session toggle, and reports that your organization's policy disabled it. Place it in [managed settings](/docs/en/managed-settings) for per-device MDM enforcement.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code refuses `claude remote-control`, the `--remote-control` flag, auto-start, and the in-session toggle
  * `false`: Remote Control stays available
* **Default**: `false`

```json settings.json theme={null}
{
  "disableRemoteControl": true
}
```

### `enableArtifact`

Turn off the [Artifact](/docs/en/artifacts) tool, which publishes session output as a private web page on claude.ai. When you turn the **Artifacts** row off in `/config`, Claude Code writes this key to your user settings, so you don't usually edit it by hand. Requires Claude Code v2.1.196 or later.

* **Scope**: [`Any file`](#scopes). Every file can turn the tool off, and none can turn it back on.
* **Type**: Boolean
  * `false`: Claude Code turns the Artifact tool off for every session the file applies to
  * `true`: the same as leaving the key unset, because it never overrides a `false` from another file, from [`CLAUDE_CODE_DISABLE_ARTIFACT`](/docs/en/env-vars), or from your organization's [admin setting](/docs/en/artifacts#manage-artifacts-for-your-organization)
* **Default**: unset, so the tool follows your account's [availability](/docs/en/artifacts#availability)

```json settings.json theme={null}
{
  "enableArtifact": false
}
```

While a source other than your own user settings keeps the tool turned off, Claude Code hides the **Artifacts** row in `/config`, because turning it on there wouldn't change anything. [Disable artifacts](/docs/en/artifacts#disable-artifacts) lists every way to turn the tool off. Before v2.1.242, Claude Code ignored this key in project and local settings, and a file higher in the [precedence stack](/docs/en/settings#settings-precedence) could turn the tool back on over a lower file's off.

### `inputNeededNotifEnabled`

Get a push notification on your phone when a permission prompt or question is waiting for your input. Claude Code sends these only while [Remote Control](/docs/en/remote-control) is connected. Appears in `/config` as **Push when actions required**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: Boolean
  * `true`: you get a push notification on your phone when a permission prompt or question is waiting, while Remote Control is connected
  * `false`: Claude Code sends no such notifications
* **Default**: `false`

```json settings.json theme={null}
{
  "inputNeededNotifEnabled": true
}
```

See [Mobile push notifications](/docs/en/remote-control#mobile-push-notifications).

### `preferredNotifChannel`

Choose how Claude Code notifies you when a task completes or a permission prompt is waiting. Appears in `/config` as **Local notifications**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: string, one of:
  * `"auto"`: Claude Code sends a desktop notification in iTerm2, Ghostty, and Kitty, rings the bell in Terminal.app only when its audible bell is off, and does nothing elsewhere
  * `"terminal_bell"`: Claude Code rings the bell character in any terminal
  * `"iterm2"`: Claude Code sends an iTerm2 desktop notification
  * `"iterm2_with_bell"`: Claude Code sends an iTerm2 desktop notification and rings the bell
  * `"kitty"`: Claude Code sends a Kitty desktop notification
  * `"ghostty"`: Claude Code sends a Ghostty desktop notification
  * `"notifications_disabled"`: Claude Code sends no notification
* **Default**: `"auto"`

```json settings.json theme={null}
{
  "preferredNotifChannel": "terminal_bell"
}
```

With `"auto"`, Claude Code sends a desktop notification in iTerm2, Ghostty, and Kitty. In Terminal.app it rings the bell character only when you have turned Terminal's audible bell off, and in other terminals it does nothing. Set `"terminal_bell"` to ring the bell character in any terminal. See [Get a terminal bell or notification](/docs/en/terminal-config#get-a-terminal-bell-or-notification).

### `remote.defaultEnvironmentId`

Pick the default [cloud environment](/docs/en/cloud-environments) for cloud sessions you create from the CLI, such as with `claude --cloud`. Claude Code writes this key to your user settings when you pick an environment with [`/remote-env`](/docs/en/cloud-environments#select-an-environment-from-the-cli).

* **Scope**: [`Any file`](#scopes). For a self-hosted environment ID, user or managed settings, or the `--settings` flag only.
* **Type**: string, an environment ID such as `env_...` or `ccpool_...`
* **Default**: unset, so Claude Code uses the Anthropic-hosted environment when your list has one, and otherwise the first environment in your list that isn't a [Remote Control bridge environment](/docs/en/cloud-environments#the-default-environment), or the first environment when every one is a bridge environment
* **Per-session overrides**: `--environment` takes precedence over this key for the one cloud session it creates

```json settings.json theme={null}
{
  "remote": {
    "defaultEnvironmentId": "env_0123abcd"
  }
}
```

An Anthropic-hosted environment ID, which starts with `env_`, follows the standard settings precedence, so a value in a repository's project settings overrides your user-level pick. A [self-hosted environment](/docs/en/self-hosted-environments) ID, which starts with `ccpool_`, is honored only from user settings, managed settings, and the `--settings` flag; Claude Code ignores one in a repository's project or local settings, and `/remote-env` shows which value it ignored, so a checked-in file can't steer sessions onto a self-hosted environment you didn't choose.

### `remoteControlAtStartup`

Connect [Remote Control](/docs/en/remote-control) automatically when each interactive session starts, instead of waiting for `/remote-control`. Set it to `true` to turn auto-connect on, `false` to turn it off. Appears in `/config` as **Enable Remote Control for all sessions**.

* **Scope**: [`Any file`](#scopes). Claude Code also reads a value left in `~/.claude.json` by older versions.
* **Type**: Boolean
  * `true`: Claude Code connects Remote Control automatically when each interactive session starts
  * `false`: Claude Code waits for `/remote-control`
* **Default**: unset, so auto-connect follows your organization's admin default when one is set, and otherwise Claude Code's current default
* **Per-session overrides**: `--remote-control` turns Remote Control on for one session even when this key is `false`, and no flag turns it off for one session

```json settings.json theme={null}
{
  "remoteControlAtStartup": true
}
```

Claude Code ignores a `true` from project or local settings, so a repository can turn auto-connect off for its checkout but can't turn it on. For the full per-scope behavior, see [Enable Remote Control for all sessions](/docs/en/remote-control#enable-remote-control-for-all-sessions) and the [security keys where the stricter value applies](/docs/en/settings#security-keys-where-the-stricter-value-applies).

### `sshConfigs`

Add SSH connections to the [Desktop](/docs/en/desktop#pre-configure-ssh-connections-for-your-team) environment dropdown. Administrators use it to distribute shared connections to a team. Connections you define in managed settings show as managed, so users can select them but can't edit or delete them in the app.

* **Scope**: [`User or managed`](#scopes). The desktop app reads this key.
* **Type**: array of objects, each with required `id`, `name`, and `sshHost` and optional `sshPort` and `sshIdentityFile`
* **Default**: unset

This example adds one connection named `Dev VM` that connects to `user@dev.example.com`:

```json settings.json theme={null}
{
  "sshConfigs": [
    {
      "id": "dev-vm",
      "name": "Dev VM",
      "sshHost": "user@dev.example.com"
    }
  ]
}
```

### `sshHostAllowlist`

Limit the hosts a [Desktop SSH session](/docs/en/desktop#restrict-which-ssh-hosts-users-can-connect-to) can connect to. Only the Desktop app reads this key; the CLI doesn't. Patterns are case-insensitive: `*` matches any host, `*.example.com` matches `example.com` and every subdomain, and anything else is an exact match against the hostname after `~/.ssh/config` resolution. An empty array turns SSH sessions off.

* **Scope**: [`Managed`](#scopes)
* **Type**: array of hostname patterns
* **Default**: unset, so any host is allowed

This example allows `devboxes.example.com` and its subdomains, plus the exact host `bastion.example.com`:

```json managed-settings.json theme={null}
{
  "sshHostAllowlist": ["*.devboxes.example.com", "bastion.example.com"]
}
```

<span id="authentication-and-login" />

## Authentication and providers

Supply credentials through helper scripts and, for organizations, force a login method or organization. See [Authentication](/docs/en/authentication).

### `apiKeyHelper`

Run your own command to produce the credential Claude Code sends with model requests. Claude Code runs the command through the system shell, `/bin/sh` on macOS and Linux and `cmd` on Windows, and sends its output as both the `X-Api-Key` and `Authorization: Bearer` headers. Use it for dynamic or rotating credentials, such as short-lived tokens fetched from a vault.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code doesn't run a helper

```json settings.json theme={null}
{
  "apiKeyHelper": "/bin/generate_temp_api_key.sh"
}
```

Claude Code caches the value and reruns the command after the interval you set with [`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`](/docs/en/env-vars). In interactive sessions, when the command comes from project or local settings, Claude Code doesn't run it until you accept the workspace trust prompt. See [Credential management](/docs/en/authentication#credential-management).

### `awsAuthRefresh`

Run your own command, such as `aws sso login`, to refresh the credentials in your `.aws` directory when the ones Claude Code has for [Amazon Bedrock](/docs/en/amazon-bedrock) stop working. Claude Code checks the current credentials against STS first and runs the command only when that check fails, then reads the refreshed `.aws` directory.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code doesn't refresh AWS credentials for you

```json settings.json theme={null}
{
  "awsAuthRefresh": "aws sso login --profile myprofile"
}
```

Use this key when your refresh flow writes to `.aws`; use [`awsCredentialExport`](#awscredentialexport) when it prints credentials instead. See [advanced credential configuration](/docs/en/amazon-bedrock#advanced-credential-configuration).

### `awsCredentialExport`

Run your own command that prints AWS credentials as JSON, so Claude Code can call [Amazon Bedrock](/docs/en/amazon-bedrock) with credentials that don't live in your `.aws` directory. Claude Code accepts the `aws sts` output shape and the flat `aws configure export-credentials` shape, and scopes the credentials to its own Bedrock client, so the shell commands Claude runs still see your ambient credentials.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code uses the ambient AWS credential chain

```json settings.json theme={null}
{
  "awsCredentialExport": "/bin/generate_aws_grant.sh"
}
```

Unlike [`awsAuthRefresh`](#awsauthrefresh), Claude Code always runs this command when it's set, without checking the ambient credentials first. See [advanced credential configuration](/docs/en/amazon-bedrock#advanced-credential-configuration).

### `forceLoginMethod`

Restrict which kind of account people can log in with. Set `"claudeai"` to allow only claude.ai accounts, `"console"` to allow only Claude Console accounts, or `"gateway"` to send people to a [cloud gateway](/docs/en/claude-apps-gateway) instead of a first-party login. Administrators set it in managed settings and pair it with [`forceLoginOrgUUID`](#forceloginorguuid) to keep developers' claude.ai logins inside one organization.

* **Scope**: [`Any file`](#scopes). Claude Code honors `"gateway"` only from a managed source on the machine: `managed-settings.json`, the macOS plist or Windows HKLM registry, or a policy helper. It treats `"gateway"` as unset in user, project, local, HKCU, and server-managed settings, the same rule as [`forceLoginGatewayUrl`](#forcelogingatewayurl).
* **Type**: string, one of:
  * `"claudeai"`: only claude.ai accounts can log in
  * `"console"`: only Claude Console accounts can log in
  * `"gateway"`: Claude Code sends people to a cloud gateway instead of a first-party login
* **Default**: unset, so people pick a login method

```json settings.json theme={null}
{
  "forceLoginMethod": "claudeai"
}
```

Every first-party login path applies the restriction, including the [VS Code extension](/docs/en/vs-code), the Agent SDK, `claude setup-token`, and `/install-github-app`, except the terminal's interactive login screen, reached by `/login` or first-run onboarding, which pre-selects the method without enforcing it. Before v2.1.212, only terminal logins applied it. See [Restrict login to your organization](/docs/en/authentication#restrict-login-to-your-organization) for how each login path, environment credentials, and third-party providers are handled.

### `forceLoginGatewayUrl`

Set the gateway URL the `/login` Cloud gateway screen connects to, so people reach your [cloud gateway](/docs/en/claude-apps-gateway) without typing its address. The screen has no URL field: with this key set, it shows your gateway URL and connects when the person presses Enter; without it, it tells them to contact their IT administrator. When `forceLoginMethod` is unset, this key alone opens the Cloud gateway screen. `forceLoginMethod: "gateway"` also opens it and removes the login-method picker, and a `claudeai` or `console` value there takes precedence over this key. Set both keys so the screen connects instead of showing an error.

* **Scope**: [`Managed`](#scopes). Read only from a source on the machine: `managed-settings.json`, the macOS plist or Windows HKLM registry, or a policy helper. Claude Code ignores it in HKCU and server-managed settings.
* **Type**: string, a full URL including the scheme
* **Default**: unset, so the Cloud gateway screen shows an error telling people to contact their IT administrator

```json managed-settings.json theme={null}
{
  "forceLoginGatewayUrl": "https://claude-gateway.example.com"
}
```

A value that isn't a valid URL is dropped on its own; the rest of the managed settings file still applies. See [Set the gateway URL](/docs/en/claude-apps-gateway#set-the-gateway-url).

### `forceLoginOrgUUID`

From a managed source, require claude.ai account logins to belong to one Anthropic organization, a single UUID, or to any of several, an array. From any settings file, a single UUID also pre-selects that organization during a claude.ai or Claude Console login; an array pre-selects nothing.

* **Scope**: [`Any file`](#scopes). Only a managed source enforces the restriction; a single UUID in any other settings file pre-selects the organization during login without restricting it.
* **Type**: string, one UUID, or array of strings, several UUIDs
* **Default**: unset, so any organization can log in

This example accepts logins from either of two organizations without pre-selecting one:

```json managed-settings.json theme={null}
{
  "forceLoginOrgUUID": ["xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"]
}
```

An empty array in a managed source blocks every login with a misconfiguration message, and so does a value Claude Code can't parse. See [Restrict login to your organization](/docs/en/authentication#restrict-login-to-your-organization) for how Claude Code treats Claude Console logins, the other login paths, and environment credentials.

### `gcpAuthRefresh`

Run your own command to refresh Google Cloud Application Default Credentials when Claude Code finds they've expired or can't be loaded, so [Google Cloud's Agent Platform](/docs/en/google-vertex-ai) requests keep working without you re-authenticating by hand.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, a shell command line
* **Default**: unset, so Claude Code's credential error tells you to run `gcloud auth application-default login` yourself

```json settings.json theme={null}
{
  "gcpAuthRefresh": "gcloud auth application-default login"
}
```

See [advanced credential configuration](/docs/en/google-vertex-ai#advanced-credential-configuration).

### `otelHeadersHelper`

Run your own command to generate the headers Claude Code sends with OpenTelemetry exports, for backends whose tokens rotate. Claude Code runs it at startup and periodically after that, and expects a JSON object of string header values on stdout.

* **Scope**: [`Any file`](#scopes)
* **Type**: string, an executable path or a shell command line
* **Default**: unset, so Claude Code adds no helper-generated headers

```json settings.json theme={null}
{
  "otelHeadersHelper": "/bin/generate_otel_headers.sh"
}
```

Set the refresh interval with [`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS`](/docs/en/env-vars). See [Dynamic headers](/docs/en/monitoring-usage#dynamic-headers) for the script requirements and where Claude Code reports a failing helper.

## Updates and versioning

Choose an update channel and, for organizations, pin the versions people can run. See [Update Claude Code](/docs/en/setup#update-claude-code).

### `autoUpdatesChannel`

Choose which [release channel](/docs/en/setup#configure-release-channel) background auto-updates and `claude update` follow. Set `"stable"` for a version that is typically about one week old and skips releases with major regressions, or `"latest"` for the most recent release.

* **Scope**: [`Any file`](#scopes). Set it in managed settings to enforce one channel across your organization.
* **Type**: string, one of:
  * `"latest"`: updates follow the most recent release
  * `"stable"`: updates follow a version that is typically about one week old and skips releases with major regressions
* **Default**: unset, so Claude Code follows `"latest"`

```json settings.json theme={null}
{
  "autoUpdatesChannel": "stable"
}
```

Claude Code writes `"stable"` to your user settings when you pick it under **Auto-update channel** in `/config`, and removes the key when you switch back to latest there. `claude install stable` and `claude install latest` also save the channel you name. Switching from `"latest"` to `"stable"` in `/config` asks whether to allow a downgrade or stay on your current version; staying sets [`minimumVersion`](#minimumversion). Homebrew installs ignore this key: the `claude-code` cask tracks stable and `claude-code@latest` tracks latest, and `claude update` defers to `brew upgrade`. To turn auto-updates off entirely, set [`DISABLE_AUTOUPDATER`](/docs/en/setup#disable-auto-updates) in `env`.

### `minimumVersion`

Keep background auto-updates and `claude update` from installing any version below this one, so moving to the `"stable"` channel doesn't downgrade you from a newer `"latest"` build. Claude Code writes this key for you when you choose to stay on your current version while switching channels in `/config`, and clears it when you switch back to `"latest"`.

* **Scope**: [`Any file`](#scopes). Set it in managed settings to pin an organization-wide minimum that user and project settings can't lower.
* **Type**: string, a version number such as `"2.1.100"`
* **Default**: unset, so updates can install any version the channel offers

This example follows the stable channel and refuses to install any version below 2.1.100:

```json settings.json theme={null}
{
  "autoUpdatesChannel": "stable",
  "minimumVersion": "2.1.100"
}
```

This key only constrains updates. To make Claude Code refuse to start below a version, use [`requiredMinimumVersion`](#requiredminimumversion) instead. See [Pin a minimum version](/docs/en/setup#pin-a-minimum-version).

### `requiredMaximumVersion`

Set the newest Claude Code version your organization allows to start. When the running version is newer, Claude Code exits at startup and tells the user to install an approved version through your organization's approved method; `claude install <version>` may also work. Requires Claude Code v2.1.163 or later.

* **Scope**: [`Managed`](#scopes). Claude Code gives no warning when it ignores the key elsewhere.
* **Type**: string, a version number such as `"2.1.150"`; a value that isn't a valid version is ignored
* **Default**: unset, so no ceiling applies

```json managed-settings.json theme={null}
{
  "requiredMaximumVersion": "2.1.150"
}
```

Background auto-updates and `claude update` skip versions above the ceiling, so an installation inside the range stays inside it. `claude update`, `claude install`, and `claude doctor` keep working above the ceiling so users can recover. Pair it with [`requiredMinimumVersion`](#requiredminimumversion) to enforce a range. Requires Claude Code v2.1.163 or later.

### `requiredMinimumVersion`

Set the oldest Claude Code version your organization allows to start. When the running version is older, Claude Code exits at startup and tells the user to update through your organization's approved method. The check runs at startup only, so a session that's already running continues. Requires Claude Code v2.1.163 or later.

* **Scope**: [`Managed`](#scopes). Claude Code gives no warning when it ignores the key elsewhere.
* **Type**: string, a version number such as `"2.1.150"`; a value that isn't a valid version is ignored
* **Default**: unset, so no floor applies

```json managed-settings.json theme={null}
{
  "requiredMinimumVersion": "2.1.150"
}
```

`claude update`, `claude install`, and `claude doctor` keep working below the floor so users can recover. Unlike [`minimumVersion`](#minimumversion), which only prevents downgrades, this key blocks startup. Pair it with [`requiredMaximumVersion`](#requiredmaximumversion) to enforce a range. Requires Claude Code v2.1.163 or later.

## Tools

Turn off specific tools in the [Claude Code desktop app](/docs/en/desktop). The terminal CLI ignores these keys. For the tools themselves, see [Tools available to Claude](/docs/en/tools-reference).

### `browserExternalPageTools`

Stop Claude from using its tools to read or act on external pages in the desktop app's [Browser pane](/docs/en/desktop#browse-external-sites). People in your organization can still open external sites themselves, and local dev server previews keep working with Claude's tools. The desktop app reads this key; the terminal CLI ignores it.

* **Scope**: [`Managed`](#scopes)
* **Type**: string, `"disabled"`; the desktop app also accepts `"disable"`, in either case
* **Default**: unset, so Claude's tools work on external pages

```json managed-settings.json theme={null}
{
  "browserExternalPageTools": "disabled"
}
```

Any other value leaves Claude's tools on, and a non-empty string that isn't one of the two accepted values logs a warning. To block external sites for people and Claude alike, set [`disableBrowserExternalNavigation`](#disablebrowserexternalnavigation) instead. See [Restrict external browsing for your organization](/docs/en/desktop#restrict-external-browsing-for-your-organization).

### `disableBrowserExternalNavigation`

Turn off external browsing in the desktop app's [Browser pane](/docs/en/desktop#browse-external-sites) for people and Claude alike. Localhost dev server previews keep working. The desktop app reads this key; the terminal CLI ignores it.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean; only the JSON Boolean `true` takes effect
  * `true`: the desktop app turns off external browsing in the Browser pane for people and Claude alike; localhost previews keep working
  * `false`: external browsing stays on
* **Default**: unset, so external browsing is on

```json managed-settings.json theme={null}
{
  "disableBrowserExternalNavigation": true
}
```

The desktop app ignores any other value, and a value that isn't a Boolean, such as the string `"true"` or `1`, also logs a warning. To leave external browsing on but keep Claude's tools off external pages, set [`browserExternalPageTools`](#browserexternalpagetools) instead. See [Restrict external browsing for your organization](/docs/en/desktop#restrict-external-browsing-for-your-organization).

### `disableMobileSimulatorTools`

Block Claude's tools for the desktop app's [iOS Simulator pane](/docs/en/desktop-ios-simulator#turn-off-simulator-access). People keep manual use of the pane; only Claude's access is removed, and nobody can turn it back on from inside the app. The desktop app reads this key; the terminal CLI ignores it.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean; only the JSON Boolean `true` takes effect
  * `true`: the desktop app blocks Claude's tools for the iOS Simulator pane
  * `false`: Claude's simulator tools follow each person's settings toggle in the desktop app
* **Default**: unset, so Claude's simulator tools follow each person's settings toggle in the desktop app

```json managed-settings.json theme={null}
{
  "disableMobileSimulatorTools": true
}
```

The desktop app ignores any other value, and a value that isn't a Boolean, such as the string `"true"` or `1`, also logs a warning.

<span id="data-and-privacy" />

## Privacy and telemetry

Control how long Claude Code keeps session data and what it sends. The switches that turn off usage metrics and error reports are environment variables, not settings keys: set `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in the [`env`](#env) key or in the shell. [Telemetry services](/docs/en/data-usage#telemetry-services) says what each one stops. Two exceptions turn off from a settings file: [`feedbackDrafts`](#feedbackdrafts) below for Claude-drafted feedback, and [`feedbackSurveyRate`](#feedbacksurveyrate) below for the session survey.

### `cleanupPeriodDays`

Set how many days Claude Code keeps [session transcripts and other application data](/docs/en/claude-directory#cleaned-up-automatically) before deleting them. Claude Code runs the deletion as a background sweep after a session starts, as long as it can safely determine the retention period.

* **Scope**: [`Any file`](#scopes)
* **Type**: number of days, a whole number, minimum `1`
* **Default**: `30`

```json settings.json theme={null}
{
  "cleanupPeriodDays": 20
}
```

Setting `0` fails validation, so pick a large value such as `3650` for long retention. To stop Claude Code from writing transcripts at all, see [Plaintext storage](/docs/en/claude-directory#plaintext-storage).

### `desktopSessionCleanupPeriodDays`

Set an age limit in days for the transcripts of sessions you started or most recently continued in Claude Desktop or Cowork. Without this key, Claude Code [keeps those transcripts at any age](/docs/en/claude-directory#cleaned-up-automatically). Claude Code deletes each one once it's older than both this limit and [`cleanupPeriodDays`](#cleanupperioddays), so with `cleanupPeriodDays` at its default of 30, a value of `7` still keeps them 30 days. When managed settings set `cleanupPeriodDays`, that period applies instead and this key is ignored. Requires Claude Code v2.1.248 or later.

* **Scope**: [`User or managed`](#scopes). Claude Code also reads the key from a file you pass with `--settings`, and ignores it in project and local settings.
* **Type**: number of days, a whole number, minimum `0`
* **Default**: `0`, which sets no age limit

```json settings.json theme={null}
{
  "desktopSessionCleanupPeriodDays": 90
}
```

### `feedbackDrafts`

Control [Claude-drafted feedback](/docs/en/tools-reference#sendfeedback-tool-behavior): whether Claude can queue feedback drafts for you to review, and whether Claude Code shows a card when Claude queues one.

* **Scope**: [`User or managed`](#scopes)
* **Type**: string, one of `"notify"`, `"quiet"`, or `"off"`
  * `"notify"`: Claude Code shows a card above the prompt when Claude queues a draft, up to [three cards in a session](/docs/en/tools-reference#what-you-see-when-claude-drafts) by default
  * `"quiet"`: Claude drafts without a card. You see the count of queued drafts in the prompt footer and review them in `/feedback`
  * `"off"`: Claude Code removes the SendFeedback tool, so Claude can't queue drafts
* **Default**: `"notify"`
* **Per-session overrides**: [`CLAUDE_CODE_SEND_FEEDBACK`](/docs/en/env-vars) set to `0` turns the feature off for one session

```json settings.json theme={null}
{
  "feedbackDrafts": "quiet"
}
```

Appears in `/config` as **Claude-drafted feedback**, which writes this key to your user settings. You see the `/config` row only in sessions [where Claude can draft feedback](/docs/en/tools-reference#sessions-without-claude-drafted-feedback); setting `"off"` doesn't hide it, so you can turn the feature back on from the same row. A value in managed settings takes precedence over your user setting, so when an administrator sets this key, the row shows the managed value and changing it has no effect. Claude Code ignores this key in project and local settings.

### `feedbackSurveyRate`

Set the probability that the [session quality survey](/docs/en/data-usage#session-quality-surveys) appears when a session is eligible for it. Set `0` to keep the survey from appearing.

* **Scope**: [`Any file`](#scopes)
* **Type**: number between `0` and `1`
* **Default**: unset, so Claude Code uses the rate Anthropic sets remotely, or its built-in rate of `0.005` on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry, which don't receive remote configuration
* **Per-session overrides**: [`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`](/docs/en/env-vars) set to `1` turns the survey off for one session whatever rate this key sets

```json settings.json theme={null}
{
  "feedbackSurveyRate": 0.05
}
```

The same rate applies to the survey in the VS Code extension.

### `skipWebFetchPreflight`

Skip the [WebFetch domain safety check](/docs/en/data-usage#webfetch-domain-safety-check), which sends each requested hostname to `api.anthropic.com` before fetching. Set `true` in environments that block traffic to Anthropic, such as Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry deployments with restrictive egress.

* **Scope**: [`Any file`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code skips the WebFetch domain safety check
  * `false`: the check runs before the first fetch to each hostname in a session, and again for a hostname whose earlier check was blocked or failed
* **Default**: unset, so the check runs before the first fetch to each hostname in a session

```json settings.json theme={null}
{
  "skipWebFetchPreflight": true
}
```

With the check skipped, WebFetch attempts any URL without consulting the blocklist, so pair it with [`WebFetch` permission rules](/docs/en/permissions#webfetch) if you need to restrict which domains Claude can reach.

<span id="managed-policy" />

## Enterprise and managed settings

Keys an organization uses to compute, refresh, and combine managed settings. See [Set up managed settings](/docs/en/admin-setup).

### `disableSideloadFlags`

Reject the `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` CLI flags at startup, which users could otherwise pass to bypass [`strictKnownMarketplaces`](#strictknownmarketplaces) for a single run. Claude Code exits with an error naming the rejected flags, and applies the same check to surfaces that start the CLI with these flags internally, currently [Cowork](/docs/en/desktop) local sessions in the desktop app. In [cloud sessions](/docs/en/claude-code-on-the-web), Claude Code drops the MCP servers the server delivered through `--mcp-config`, other than in-process `type: "sdk"` entries, and starts the session. Requires Claude Code v2.1.193 or later.

* **Scope**: [`Managed`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code rejects `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` at startup and exits with an error naming them, except that in cloud sessions it drops the MCP servers the server delivered through `--mcp-config`, other than in-process `type: "sdk"` entries, and starts the session
  * `false`: Claude Code accepts those flags
* **Default**: `false`

```json managed-settings.json theme={null}
{
  "disableSideloadFlags": true
}
```

Claude Code still accepts a `--mcp-config` whose servers are all in-process `type: "sdk"` entries, so the Agent SDK and VS Code extension keep working. Users can still add servers with `claude mcp add` or a `.mcp.json` file; for per-server control, set [`allowedMcpServers`](/docs/en/managed-mcp) as well. Requires Claude Code v2.1.193 or later.

In cloud sessions, Claude Code also ignores server-delivered mid-session MCP updates, the path behind cloud session configuration and SDK `setMcpServers()` on remote workers. In-process `type: "sdk"` entries stay exempt there too. Before v2.1.239, a server-delivered `--mcp-config` blocked a cloud session from starting.

### `forceRemoteSettingsRefresh`

Block CLI startup until Claude Code has freshly fetched [server-managed settings](/docs/en/server-managed-settings). If the fetch fails, Claude Code exits instead of continuing with cached or no settings. Set it when your environment can't accept even a brief window in which a session runs without its managed policy.

When the key is unset, Claude Code doesn't block startup on the fetch, though when the developer signs in at startup it waits up to five seconds for the fetch. A Cloud gateway session always waits, and exits if the gateway can't be reached.

* **Scope**: [`Managed`](#scopes). Claude Code honors a `true` from any admin-controlled managed source, even one that isn't the highest-priority source.
* **Type**: Boolean
  * `true`: Claude Code blocks startup until it has freshly fetched server-managed settings, and exits if the fetch fails
  * `false`: Claude Code doesn't block startup on the fetch, though at a sign-in startup it waits up to five seconds for the fetch
* **Default**: `false`

```json managed-settings.json theme={null}
{
  "forceRemoteSettingsRefresh": true
}
```

Set it in an MDM profile or the managed settings file to enforce fail-closed startup before the first server payload arrives. Claude Code applies the check only in sessions that fetch server-managed settings, so a session that [doesn't fetch them](/docs/en/server-managed-settings#platform-availability) starts without waiting. The `claude auth` subcommands are exempt, so users can re-authenticate when expired credentials are why the fetch fails. See [Enforce fail-closed startup](/docs/en/server-managed-settings#enforce-fail-closed-startup).

### `managedSourcesBehavior`

Choose whether Claude Code applies only the highest-priority [managed source](/docs/en/managed-settings#how-claude-code-combines-managed-sources) your organization delivers, or combines every admin source it delivers. By default Claude Code takes the highest-priority source that carries a [policy key](/docs/en/managed-settings#how-claude-code-combines-managed-sources) and ignores the rest. A policy key is any settings key other than this one and `wslInheritsWindowsSettings`. So once server-managed settings or an MDM policy deliver a policy key, a `managed-settings.json` file contributes only the [keys Claude Code reads from every admin source](/docs/en/managed-settings#keys-read-from-every-admin-source). With `"merge"`, every admin source you deliver contributes its keys to one combined policy. Requires Claude Code v2.1.242 or later.

Set `"merge"` only where every source [ranked](/docs/en/managed-settings#how-claude-code-combines-managed-sources) below your highest one is under an administrator's control, because Claude Code then adds entries from a lower source, such as `permissions.allow` rules, to the policy.

* **Scope**: [`Managed`](#scopes). Claude Code reads this key from the highest-priority source that carries either this key or a policy key, and ignores this key in every source ranked lower, so a lower source can't opt itself into combining with the source above it. Neither the Windows HKCU registry nor [parent settings from an embedding host](/docs/en/managed-settings#let-an-embedding-host-add-policy) take part in the merge.
* **Type**: string, one of:
  * `"first-wins"`: the highest-priority source that carries a policy key supplies the policy, and lower sources contribute only the [keys Claude Code reads from every admin source](/docs/en/managed-settings#keys-read-from-every-admin-source)
  * `"merge"`: every admin source you deliver contributes its keys, combined by the rules below
* **Default**: `"first-wins"`

Deliver the key in the highest-priority source you deploy. A machine that never receives server-managed settings needs the key in its MDM profile too, because Claude Code reads the key from the highest-priority source that carries it or a policy key. A `managed-settings.json` file is the lowest-ranked admin source, so `"merge"` set there has no source below it to combine with. In server-managed settings, the key looks like this:

```json theme={null}
{
  "managedSourcesBehavior": "merge"
}
```

Under `"merge"`, Claude Code combines each key by its kind. This table gives the rule for each kind; the restriction allowlist and highest-source-only rows name every key they cover, and the other rows give examples:

| Kind of key                                | How Claude Code combines it                                                                                                                                                             | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lists                                      | Combines entries from every source                                                                                                                                                      | [`permissions.allow`](#permissions-allow), [`sandbox.network.allowedDomains`](#sandbox-network-alloweddomains), and other list keys                                                                                                                                                                                                                                                                                                                                                                    |
| Locks                                      | Applies the strictest value any source sets. When no source sets a strict value, applies a looser value only from the highest source                                                    | [`allowManagedPermissionRulesOnly`](#allowmanagedpermissionrulesonly), [`permissions.disableBypassPermissionsMode`](#permissions-disablebypasspermissionsmode), and other boolean or enum locks                                                                                                                                                                                                                                                                                                        |
| Restriction allowlists                     | Takes the list whole from the highest source that sets it, without adding entries from lower sources. When the highest source doesn't set one, takes it whole from the next source down | [`availableModels`](#availablemodels), [`allowedMcpServers`](#allowedmcpservers), [`strictKnownMarketplaces`](#strictknownmarketplaces), [`allowedChannelPlugins`](#allowedchannelplugins), and the [`fallbackModel`](#fallbackmodel) chain                                                                                                                                                                                                                                                            |
| Read from the highest-priority source only | Reads the key only from the highest-priority source that carries a policy key, so a lower source's value is ignored even when the highest source sets none                              | [`apiKeyHelper`](#apikeyhelper), [`awsAuthRefresh`](#awsauthrefresh), [`awsCredentialExport`](#awscredentialexport), [`gcpAuthRefresh`](#gcpauthrefresh), [`otelHeadersHelper`](#otelheadershelper), `proxyAuthHelper`, [`forceLoginOrgUUID`](#forceloginorguuid), [`forceLoginMethod`](#forceloginmethod), [`forceLoginGatewayUrl`](#forcelogingatewayurl), [`parentSettingsBehavior`](#parentsettingsbehavior), [`modelPicker`](#modelpicker), [`permissions.defaultMode`](#permissions-defaultmode) |
| `env`                                      | [Merges per variable across admin sources](/docs/en/managed-settings#keys-read-from-every-admin-source), under both `"first-wins"` and `"merge"`                                             | [`env`](#env)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Every other key                            | Takes the value from the highest source that sets it                                                                                                                                    | [`cleanupPeriodDays`](#cleanupperioddays), [`model`](#model)                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Two of those keys add a condition of their own:

* **[`modelOverrides`](#modeloverrides)**: pairs with `availableModels`. Claude Code takes `modelOverrides` from the highest source that sets it, unless a higher source sets `availableModels` without `modelOverrides`. In that case it ignores `modelOverrides` from every source.
* **[`forceLoginGatewayUrl`](#forcelogingatewayurl) and the `"gateway"` value of [`forceLoginMethod`](#forceloginmethod)**: Claude Code honors them only when the highest source is an MDM policy or a managed settings file, so under server-managed settings neither applies.

To confirm which sources combined on a machine, run `/status` and [read the `Setting sources` line](/docs/en/managed-settings#read-the-source-in-/status).

### `parentSettingsBehavior`

Choose whether Claude Code applies managed settings supplied by an embedding host process, such as the Agent SDK or an IDE extension, when an admin-deployed managed tier is also present. With `"first-wins"`, Claude Code drops the host-supplied settings; with `"merge"`, it applies them under the admin tier through a restrictive-only filter. Set `"merge"` when a host needs to pass its own restrictions to the sessions it launches, for example Claude Desktop delivering a gateway's egress allowlist.

* **Scope**: [`Managed`](#scopes). Claude Code reads it from the highest-priority admin-controlled managed source.
* **Type**: string, one of:
  * `"first-wins"`: Claude Code drops the host-supplied settings when an admin-deployed managed tier is present
  * `"merge"`: Claude Code applies the host-supplied settings under the admin tier through a restrictive-only filter
* **Default**: `"first-wins"`

```json managed-settings.json theme={null}
{
  "parentSettingsBehavior": "merge"
}
```

This key has no effect when no admin-deployed managed tier exists: the host's settings then apply as the only managed tier, still filtered to restrictive values. For the filter's limits and how the managed sources interact, see [Parent settings from embedding hosts](/docs/en/managed-settings#parent-settings-from-embedding-hosts) and [Restrict parent settings](/docs/en/claude-apps-gateway#restrict-parent-settings).

<span id="compute-managed-settings-with-a-policy-helper" />

### `policyHelper`

Run an executable you deploy that computes managed settings at startup, so you can derive policy from device posture, identity, or a remote service instead of a static file. Claude Code runs the helper before it accepts the first prompt and treats the settings it emits as the managed settings for the session.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file. Claude Code reads the key from the highest-priority managed source that delivers settings and runs the helper only when that source is one of those three; it ignores the key in server-managed settings, the HKCU registry, and host-supplied parent settings.
* **Type**: object with `path`, `timeoutMs`, and `refreshIntervalMs`
* **Default**: unset, so no helper runs

This example runs the helper with a 5-second timeout and re-runs it every five minutes:

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy",
    "timeoutMs": 5000,
    "refreshIntervalMs": 300000
  }
}
```

#### Write the helper output

Claude Code runs the helper with no arguments, sets `CLAUDE_CODE_VERSION` in its environment, and reads a JSON envelope from stdout, capped at 1 MiB.

Put the settings under a `managedSettings` key. A bare settings object with no `managedSettings` key parses with `managedSettings` undefined and applies nothing, and Claude Code reports no error:

```json theme={null}
{
  "managedSettings": {
    "permissions": { "deny": ["Read(//etc/secrets/**)"] }
  }
}
```

When the helper emits `managedSettings`, that object becomes the only managed settings source for the run: Claude Code ignores the MDM, file, and HKCU sources, reads the [cross-source keys](/docs/en/managed-settings#keys-read-from-every-admin-source) from the helper's output alone, and never merges [parent settings](/docs/en/managed-settings#parent-settings-from-embedding-hosts).

The startup `forceRemoteSettingsRefresh` check runs before the helper and reads any admin source. A helper that exits 0 with an envelope that omits `managedSettings` contributes no managed settings, and the other sources apply as usual.

#### Helper failures

A helper run fails when:

* `path` breaks the rules in [`policyHelper.path`](#policyhelper-path).
* No regular file is at `path`. Claude Code checks for the file before starting the helper, within the same `timeoutMs` budget, so an unresponsive network mount can cause the run to fail.
* The helper exits non-zero, is still running when `timeoutMs` elapses, or doesn't start at all, for example because it isn't executable.
* The helper writes more than 1 MiB to stdout or to stderr.
* stdout isn't a single JSON object, or its `managedSettings` has a [schema violation Claude Code can't repair](/docs/en/managed-settings#find-entries-claude-code-dropped).

When the startup run fails, Claude Code prints the reason and refuses to start. After a non-zero exit or a timeout, the message includes the helper's stderr. The refusal covers interactive sessions, `claude -p`, Agent SDK sessions, [background sessions](/docs/en/agent-view), and most subcommands.

The refusal is deliberate, so a helper that needs outage resilience should serve from its own cache and exit `0`.

When a background refresh fails, Claude Code keeps the last successful policy in effect. Claude Code runs each refresh under the same `timeoutMs` and failure rules as the startup run. With `--debug`, Claude Code writes the helper's stderr from every run to the [debug log](/docs/en/debug-your-config).

Claude Code reports an invalid `policyHelper` value as a [dropped entry](/docs/en/managed-settings#find-entries-claude-code-dropped) and starts the session on the remaining managed settings without running a helper. Invalid values include a bare path string and a `timeoutMs` below [its minimum](#policyhelper-timeoutms).

To turn a helper off, remove the key from the source that sets it.

### `policyHelper.path`

Name the helper executable Claude Code runs. For what happens when the path breaks the rules below, see [Helper failures](#helper-failures).

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file, wherever [`policyHelper`](#policyhelper) is read.
* **Type**: string, an absolute path in normalized form, without `.` or `..` segments; on Windows, a drive-letter or UNC path that ends in `.exe`
* **Default**: none; required when `policyHelper` is set

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy"
  }
}
```

### `policyHelper.timeoutMs`

Set how long Claude Code waits for the helper before treating the run as failed. A timed-out run fails the same way as a non-zero exit, so at startup Claude Code refuses to start.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file, wherever [`policyHelper`](#policyhelper) is read.
* **Type**: integer, milliseconds, minimum `1000`
* **Default**: `10000`

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy",
    "timeoutMs": 5000
  }
}
```

### `policyHelper.refreshIntervalMs`

Have Claude Code re-run the helper in the background on an interval so policy changes reach a running session. When a refresh succeeds, its output replaces the previous managed settings without a restart; when a refresh fails, Claude Code keeps the policy it already has.

* **Scope**: [`Managed`](#scopes). Read from the macOS plist, the Windows HKLM registry, or the managed settings file, wherever [`policyHelper`](#policyhelper) is read.
* **Type**: integer, milliseconds: `0` to disable refresh, otherwise at least `60000`
* **Default**: unset, so Claude Code runs the helper once at startup

This example re-runs the helper every five minutes:

```json managed-settings.json theme={null}
{
  "policyHelper": {
    "path": "/usr/local/bin/claude-policy",
    "refreshIntervalMs": 300000
  }
}
```

### `wslInheritsWindowsSettings`

Have Claude Code on WSL read managed settings from the Windows policy chain, with HKLM and the Windows managed settings file taking priority over `/etc/claude-code` and HKCU below it. While the chain is on, Claude Code reads `/etc/claude-code` only when no managed settings file or drop-in under `C:\Program Files\ClaudeCode\` delivers a [policy key](/docs/en/managed-settings#how-claude-code-combines-managed-sources). Set it to extend the policy you already deploy on Windows to WSL sessions on the same machine, so they follow the same rules as host sessions. Claude Code honors it only when set in the HKLM registry key or in a managed settings file or drop-in under `C:\Program Files\ClaudeCode\`, both of which require Windows admin to write.

* **Scope**: [`Managed`](#scopes). In an admin-controlled Windows source.
* **Type**: Boolean
  * `true`: Claude Code on WSL reads managed settings from the Windows policy chain, and reads `/etc/claude-code` only when no managed settings file or drop-in under `C:\Program Files\ClaudeCode\` delivers a [policy key](/docs/en/managed-settings#how-claude-code-combines-managed-sources)
  * `false`: WSL reads only `/etc/claude-code`
* **Default**: `false`, so WSL reads only `/etc/claude-code`

```json managed-settings.json theme={null}
{
  "wslInheritsWindowsSettings": true
}
```

Once an admin source turns the chain on, HKCU policy joins it on WSL only when HKCU also sets the key to `true`. That copy doesn't turn the chain on by itself. A Windows source that contains only this key doesn't count as a policy source, so a lower-priority source still supplies the policy. This key has no effect on native Windows.

## Global config settings

Save these keys in `~/.claude.json`, not in a settings file. Claude Code ignores them anywhere else. Claude Code and `/config` write most of them for you, and you can also edit them by hand.

### `autoConnectIde`

Connect to a running IDE automatically when you start Claude Code from an external terminal. Appears in `/config` as **Auto-connect to IDE (external terminal)** when you run Claude Code outside a VS Code or JetBrains terminal.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code connects to a running IDE automatically when you start it from an external terminal
  * `false`: Claude Code doesn't connect automatically from an external terminal; inside a VS Code or JetBrains terminal, or with `--ide`, it still connects
* **Default**: `false`
* **Per-session overrides**: [`CLAUDE_CODE_AUTO_CONNECT_IDE`](/docs/en/env-vars) takes precedence over this key for one session, in either direction

```json ~/.claude.json theme={null}
{
  "autoConnectIde": true
}
```

Claude Code ignores this key in `settings.json`.

### `autoInstallIdeExtension`

Install the Claude Code IDE extension automatically when you run Claude Code from a VS Code terminal. Appears in `/config` as **Auto-install IDE extension** when you run Claude Code inside a VS Code or JetBrains terminal.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: Claude Code installs the IDE extension automatically when you run it from a VS Code terminal
  * `false`: Claude Code doesn't install the extension automatically
* **Default**: `true`
* **Per-session overrides**: [`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`](/docs/en/env-vars) set to `1` skips the install for one session even when this key is `true`

```json ~/.claude.json theme={null}
{
  "autoInstallIdeExtension": false
}
```

Claude Code ignores this key in `settings.json`.

### `diffTool`

Choose where Claude Code shows the diff of an `Edit` or `Write` change it proposes when a [VS Code](/docs/en/vs-code) or [JetBrains](/docs/en/jetbrains#features) IDE is connected: `"auto"` opens it in the IDE's diff viewer, `"terminal"` keeps it in the terminal. Appears in `/config` as **Diff tool** only while Claude Code is connected to a VS Code or JetBrains IDE.

* **Scope**: [`Global config`](#scopes)
* **Type**: string, one of:
  * `"auto"`: Claude Code opens the diff in the IDE's diff viewer when a VS Code or JetBrains IDE is connected
  * `"terminal"`: Claude Code keeps the diff in the terminal
* **Default**: `"auto"`

```json ~/.claude.json theme={null}
{
  "diffTool": "terminal"
}
```

Claude Code ignores this key in `settings.json`.

### `externalEditorContext`

When you press `Ctrl+G`, Claude Code opens the prompt you're typing in your [external editor](/docs/en/interactive-mode#general-controls). With this key on, the editor buffer starts with Claude's previous response as `#` comment lines, so you can read it while you write, and Claude Code strips those lines when you save. Appears in `/config` as **Show last response in external editor**.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: the editor buffer starts with Claude's previous response as `#` comment lines, which Claude Code strips when you save
  * `false`: the editor buffer opens with only your prompt
* **Default**: `false`

```json ~/.claude.json theme={null}
{
  "externalEditorContext": true
}
```

With it on, the buffer Claude Code opens looks like this, and only the text below the marker line is sent as your prompt:

```text theme={null}
# ─── Claude's last response (for reference; removed on save) ───
# I added the retry loop to fetchUser in src/api.ts and a test
# for the timeout case. Want me to wire the same retry into
# fetchOrders?
# ─── Write your reply below this line ──────────────────────────

Yes, and cap it at three attempts.
```

Claude Code keeps the last 50 lines of the response and marks the cut with `# … (earlier output truncated)`.

Claude Code ignores this key in `settings.json`.

### `permissionExplainerEnabled`

When Claude asks permission to run a Bash or PowerShell command, you can press `Ctrl+E` on the prompt to get a model-generated [explanation of the command](/docs/en/permissions#permission-system): what it does, why Claude is running it, and what could go wrong, labeled **Low risk**, **Med risk**, or **High risk**. Claude Code asks the model for the explanation only when you press the shortcut, and showing it doesn't run the command. Set this key to `false` to turn the shortcut off.

* **Scope**: [`Global config`](#scopes)
* **Type**: Boolean
  * `true`: you can press `Ctrl+E` on a Bash or PowerShell permission prompt to get a model-generated explanation of the command
  * `false`: Claude Code turns the `Ctrl+E` shortcut off
* **Default**: `true`

```json ~/.claude.json theme={null}
{
  "permissionExplainerEnabled": false
}
```

Claude Code ignores this key in `settings.json`.

### `teammateDefaultModel`

<Warning>
  Removed in v2.1.234, together with its `/config` row **Default teammate model**. Setting it has no effect on current versions.
</Warning>

Through v2.1.233, you set this key to the model for [agent team](/docs/en/agent-teams#specify-teammates-and-models) teammates your prompt didn't name a model for: an alias such as `"sonnet"`, or `null` to follow the lead's model. For the model Claude Code picks for such teammates now, see [specify teammates and models](/docs/en/agent-teams#specify-teammates-and-models).

* **Scope**: [`Global config`](#scopes). On v2.1.233 and earlier.
* **Type**: string, a model alias or full model ID, or `null`
* **Default**: unset

## See also

* [Configure permissions](/docs/en/permissions): rule syntax, permission modes, and workspace trust
* [Environment variables](/docs/en/env-vars): every `CLAUDE_*`, `ANTHROPIC_*`, and provider variable Claude Code reads
* [Tools available to Claude](/docs/en/tools-reference): the built-in tools and which need approval
* [Example settings files](/docs/en/settings-example): a personal file, a team file, and an organization's managed file
* [Set up managed settings](/docs/en/admin-setup): how organizations decide what to enforce
* [Deploy managed settings](/docs/en/managed-settings): delivery mechanisms, precedence within the managed tier, and invalid entries in managed settings
* [Debug your configuration](/docs/en/debug-your-config): `claude doctor` and the Settings Error dialog
