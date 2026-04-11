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

  test("classifies read-only find pipelines as list commands", () => {
    expect(
      summarizeShellDisplay("find src/channels -type f | head -n 20"),
    ).toMatchObject({
      kind: "list",
      label: "List",
      summary: "path: src/channels, limit: 20",
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
});
