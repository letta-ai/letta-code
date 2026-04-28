import { describe, expect, test } from "bun:test";
import { summarizeShellDisplay } from "../../cli/helpers/shellSemanticDisplay";

describe("summarizeShellDisplay", () => {
  test("classifies rg search commands", () => {
    expect(summarizeShellDisplay('rg -n "TODO" src')).toMatchObject({
      kind: "search",
      label: "Search",
      summary: 'query: "TODO", path: src',
    });
  });

  test("classifies rg --files list commands", () => {
    expect(
      summarizeShellDisplay("rg --files src/channels | head -n 50"),
    ).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: src/channels, limit: 50",
    });
  });

  test("classifies rg --files followed by sed formatter as list commands", () => {
    expect(
      summarizeShellDisplay("rg --files webview/src | sed -n"),
    ).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: webview/src",
    });
  });

  test("classifies read-only find pipelines as list commands", () => {
    expect(
      summarizeShellDisplay("find src/channels -type f | head -n 20"),
    ).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: src/channels, limit: 20",
    });
  });

  test("keeps explicit dot roots in find summaries", () => {
    expect(summarizeShellDisplay("find . -name '*.rs'")).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: .",
    });
  });

  test("keeps explicit dot roots in eza summaries", () => {
    expect(summarizeShellDisplay("exa -I target .")).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: .",
    });
  });

  test("classifies read commands with line ranges", () => {
    expect(summarizeShellDisplay("sed -n '1,120p' src/foo.ts")).toMatchObject({
      kind: "read",
      label: "Read",
      summary: "path: src/foo.ts, lines: 1-120",
    });
  });

  test("classifies head reads with line ranges", () => {
    expect(summarizeShellDisplay("head -n 80 src/foo.ts")).toMatchObject({
      kind: "read",
      label: "Read",
      summary: "path: src/foo.ts, lines: 1-80",
    });
  });

  test("classifies tail reads with trailing line counts", () => {
    expect(summarizeShellDisplay("tail -n 40 src/foo.ts")).toMatchObject({
      kind: "read",
      label: "Read",
      summary: "path: src/foo.ts, last: 40 lines",
    });
  });

  test("unwraps shell launchers before classifying", () => {
    expect(
      summarizeShellDisplay(["bash", "-lc", "git grep queue src/websocket"]),
    ).toMatchObject({
      kind: "search",
      label: "Search",
      summary: 'query: "queue", path: src/websocket',
      rawCommand: "git grep queue src/websocket",
    });
  });

  test("preserves cd context for list commands", () => {
    expect(summarizeShellDisplay("cd app && rg --files")).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: app",
    });
  });

  test("falls back to run for ambiguous commands", () => {
    expect(summarizeShellDisplay("git status")).toMatchObject({
      kind: "run",
      label: "Run",
      summary: "git status",
    });
  });

  test("falls back to run for chained commands", () => {
    expect(summarizeShellDisplay("rg --version && node -v")).toMatchObject({
      kind: "run",
      label: "Run",
      summary: "rg --version && node -v",
    });
  });

  test("falls back to run for redirects", () => {
    expect(summarizeShellDisplay("echo foo > bar")).toMatchObject({
      kind: "run",
      label: "Run",
      summary: "echo foo > bar",
    });
  });

  test("uses the exact package-files capture as a filtered list summary", () => {
    const command = String.raw`printf '== package files ==\n'; rg --files | rg '(^|/)(apps/code-desktop|apps/code-desktop-electron|apps/code-desktop-ui|code-desktop).*(package\.json|vite\.config|webpack|electron-builder|forge|builder|tsconfig|main\.|preload\.|menu|entitlements|yaml|yml)$|(^|/)(package\.json|pnpm-workspace\.yaml|nx\.json)$'`;

    const summary = summarizeShellDisplay(command);
    expect(summary).toMatchObject({
      kind: "list",
      label: "List",
      rawCommand: command,
    });
    expect(summary.summary).toContain("path: .");
    expect(summary.summary).toContain("filter:");
    expect(summary.summary).toContain("apps/code-desktop");
    expect(summary.summary).toContain("pnpm-workspace");
  });

  test("uses the exact vite-config capture as a read summary", () => {
    const command = String.raw`printf '== apps/desktop-ui/vite.config.ts ==\n'; sed -n '1,240p' apps/desktop-ui/vite.config.ts; printf '\n== apps/desktop-ui/package.json ==\n'; if [ -f apps/desktop-ui/package.json ]; then sed -n '1,240p' apps/desktop-ui/package.json; fi`;

    expect(summarizeShellDisplay(command)).toMatchObject({
      kind: "read",
      label: "Read",
      rawCommand: command,
      summary: "path: apps/desktop-ui/vite.config.ts, lines: 1-240",
    });
  });

  test("uses the exact code-desktop ui config capture as a filtered list summary", () => {
    const command = String.raw`printf '== code-desktop ui config files ==\n'; rg --files apps/code-desktop/ui | rg '(vite\.config|package\.json|project\.json|index\.html|main\.tsx|main\.ts|tsconfig|sentry|source|map)' ; printf '\n== apps/code-desktop/ui/project.json ==\n'; sed -n '1,240p' apps/code-desktop/ui/project.json 2>/dev/null; printf '\n== apps/code-desktop/ui/vite.config.* ==\n'; for f in apps/code-desktop/ui/vite.config.*; do echo "--- $f ---"; sed -n '1,260p' "$f"; done`;

    const summary = summarizeShellDisplay(command);
    expect(summary).toMatchObject({
      kind: "list",
      label: "List",
      rawCommand: command,
    });
    expect(summary.summary).toContain("path: apps/code-desktop/ui");
    expect(summary.summary).toContain("filter:");
    expect(summary.summary).toContain("vite");
    expect(summary.summary).toContain("project");
  });

  test("uses the exact electron build capture as a filtered list summary", () => {
    const command = String.raw`printf '== electron build/packaging files ==\n'; rg --files apps/code-desktop apps/code-desktop/electron | rg '(project\.json|electron-builder|builder|forge|tsup|esbuild|vite\.config|package\.json|entitlements|plist|yaml|yml|desktop.*config|notarize|afterSign)' ; printf '\n== relevant project/build files contents ==\n'; for f in apps/code-desktop/project.json apps/code-desktop/electron/project.json apps/code-desktop/project.config.json apps/code-desktop/electron-builder.yml apps/code-desktop/electron/builder.yml apps/code-desktop/electron/electron-builder.yml apps/code-desktop/electron-builder.yaml apps/code-desktop/electron-builder.yml apps/code-desktop/electron/electron-builder.yaml; do if [ -f "$f" ]; then echo "--- $f ---"; sed -n '1,260p' "$f"; fi; done`;

    const summary = summarizeShellDisplay(command);
    expect(summary).toMatchObject({
      kind: "list",
      label: "List",
      rawCommand: command,
    });
    expect(summary.summary).toContain("path: apps/code-desktop");
    expect(summary.summary).toContain("filter:");
    expect(summary.summary).toContain("electron-builder");
  });

  test("uses the exact stale-asset capture as a list summary", () => {
    const command = String.raw`printf '== stale asset summary ==\n'; printf 'JS bundles: '; find apps/code-desktop/dist/assets -maxdepth 1 -type f -name 'index-*.js' | wc -l; printf 'CSS bundles: '; find apps/code-desktop/dist/assets -maxdepth 1 -type f -name 'index-*.css' | wc -l; printf 'All asset files: '; find apps/code-desktop/dist/assets -maxdepth 1 -type f | wc -l; printf '\nRecent asset mtimes:\n'; find apps/code-desktop/dist/assets -maxdepth 1 -type f -name 'index-*.*' -exec stat -f '%Sm %N' -t '%Y-%m-%d %H:%M' {} \; | sort | tail -n 20`;

    const summary = summarizeShellDisplay(command);
    expect(summary).toMatchObject({
      kind: "list",
      label: "List",
      rawCommand: command,
    });
    expect(summary.summary).toContain("path: apps/code-desktop/dist/assets");
  });

  test("keeps the exact node heredoc capture on the run path", () => {
    const command = String.raw`printf '== referenced renderer asset sizes ==\n'; node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('apps/code-desktop/dist/index.html','utf8');
const js = html.match(/src="\.\/([^\"]+)"/)?.[1];
const css = html.match(/href="\.\/([^\"]+)"/)?.[1];
for (const f of [js, css]) {
  if (!f) continue;
  const st = fs.statSync('apps/code-desktop/dist/' + f);
  console.log(f, st.size);
}
NODE`;

    expect(summarizeShellDisplay(command)).toMatchObject({
      kind: "run",
      label: "Run",
      rawCommand: command,
    });
  });
});
