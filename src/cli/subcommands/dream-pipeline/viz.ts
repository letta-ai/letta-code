// Self-contained HTML visualization for a dream run: every reflection agent's
// trajectory + generated memory filesystem, and the aggregator (trajectory,
// final tree snapshot, and the patch it landed on the real memfs), embedded
// as JSON in one file with a vanilla-JS viewer.
//
// Reads only the run directory's own artifacts (per-batch
// input/output/trajectory/report, aggregate/*), so it can re-render any past
// run at any time.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { NormalizedRecord } from "@/agent/trajectories/types";
import { getDreamRootDir, getDreamRunRoot } from "./paths";

const FILE_CONTENT_CAP = 30_000;
const TOOL_TEXT_CAP = 6_000;
const DIFF_CAP = 120_000;

interface VizStep {
  kind: "user" | "reasoning" | "assistant" | "tool";
  content?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolIsError?: boolean;
}

interface VizFile {
  path: string;
  content: string;
  truncated: boolean;
}

interface VizAgent {
  id: string;
  role: "reflection" | "aggregator";
  label: string;
  batchIndex?: number;
  /** Backend agent the pass ran on (the persistent reflector). */
  agentId?: string;
  /** Conversation on that agent holding this pass's full history. */
  conversationId?: string;
  sessionIds: string[];
  success: boolean;
  error?: string;
  durationMs: number;
  report: string;
  steps: VizStep[];
  files: VizFile[];
  inputFiles: VizFile[];
  gitLog: string;
  gitDiff: string;
  stats: { toolCalls: number; reasoning: number; assistant: number };
}

function truncate(
  text: string,
  cap: number,
): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return {
    text: `${text.slice(0, cap)}\n… [truncated, ${text.length - cap} more chars]`,
    truncated: true,
  };
}

function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function readTextIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJsonIfExists<T>(path: string): T | null {
  const raw = readTextIfExists(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function collectFiles(root: string): VizFile[] {
  const out: VizFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        const { text, truncated } = truncate(
          readFileSync(path, "utf8"),
          FILE_CONTENT_CAP,
        );
        out.push({ path: relative(root, path), content: text, truncated });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Normalized-v1 trajectory records → paired display steps. */
function stepsFromNormalized(records: NormalizedRecord[]): VizStep[] {
  const steps: VizStep[] = [];
  const callIndexById = new Map<string, number>();
  for (const record of records) {
    if (record.role === "meta") continue;
    if (record.role === "user" && record.content) {
      steps.push({ kind: "user", content: record.content });
    } else if (record.role === "reasoning" && record.content) {
      steps.push({ kind: "reasoning", content: record.content });
    } else if (record.role === "assistant") {
      if (record.content) {
        steps.push({ kind: "assistant", content: record.content });
      }
      for (const call of record.tool_calls ?? []) {
        steps.push({
          kind: "tool",
          toolName: call.name,
          toolArgs: truncate(call.args ?? "{}", TOOL_TEXT_CAP).text,
        });
        callIndexById.set(call.id, steps.length - 1);
      }
    } else if (record.role === "tool") {
      const text = truncate(record.content ?? "", TOOL_TEXT_CAP).text;
      const isError = /^error/i.test(record.content ?? "");
      const idx = record.tool_call_id
        ? callIndexById.get(record.tool_call_id)
        : undefined;
      const target = idx !== undefined ? steps[idx] : undefined;
      if (target) {
        target.toolResult = text;
        target.toolIsError = isError;
      } else {
        steps.push({
          kind: "tool",
          toolName: "(unmatched result)",
          toolResult: text,
          toolIsError: isError,
        });
      }
    }
  }
  return steps;
}

function loadSteps(trajectoryPath: string): VizStep[] {
  const records = readJsonIfExists<NormalizedRecord[]>(trajectoryPath);
  return Array.isArray(records) ? stepsFromNormalized(records) : [];
}

function statsFor(steps: VizStep[]): VizAgent["stats"] {
  return {
    toolCalls: steps.filter((s) => s.kind === "tool").length,
    reasoning: steps.filter((s) => s.kind === "reasoning").length,
    assistant: steps.filter((s) => s.kind === "assistant").length,
  };
}

interface StoredReport {
  subagentId?: string;
  subagentAgentId?: string;
  agentId?: string;
  conversationId?: string;
  label?: string;
  sessionIds?: string[];
  inputs?: string[];
  success?: boolean;
  error?: string;
  durationMs?: number;
  report?: string;
}

function loadBatchAgent(batchDir: string, index: number): VizAgent | null {
  const report = readJsonIfExists<StoredReport>(join(batchDir, "report.json"));
  const outputDir = join(batchDir, "output");
  if (!report && !existsSync(outputDir)) return null;
  const steps = loadSteps(join(batchDir, "trajectory.json"));
  return {
    id: `batch-${index}`,
    role: "reflection",
    label: `batch ${index}`,
    batchIndex: index,
    agentId: report?.agentId,
    conversationId: report?.conversationId,
    sessionIds: report?.sessionIds ?? [],
    success: report?.success ?? false,
    error: report?.error,
    durationMs: report?.durationMs ?? 0,
    report: report?.report ?? "",
    steps,
    files: collectFiles(outputDir),
    inputFiles: collectFiles(join(batchDir, "input")),
    gitLog: git(outputDir, ["log", "--format=%h  %s", "--reverse"]),
    gitDiff: truncate(
      git(outputDir, [
        "log",
        "-p",
        "--reverse",
        "--skip=1",
        "--format=commit %h%n%s%n",
      ]),
      DIFF_CAP,
    ).text,
    stats: statsFor(steps),
  };
}

function loadAggregatorAgent(aggregateDir: string): VizAgent | null {
  if (!existsSync(aggregateDir)) return null;
  const report = readJsonIfExists<StoredReport>(
    join(aggregateDir, "report.json"),
  );
  const trajectoryPath = join(aggregateDir, "trajectory.json");
  if (!report && !existsSync(trajectoryPath)) return null;
  const steps = loadSteps(trajectoryPath);
  return {
    id: "aggregator",
    role: "aggregator",
    label: "aggregator",
    agentId: report?.subagentAgentId,
    conversationId: report?.conversationId,
    sessionIds: report?.inputs ?? [],
    success: report?.success ?? false,
    error: report?.error,
    durationMs: report?.durationMs ?? 0,
    report: report?.report ?? "",
    steps,
    files: collectFiles(join(aggregateDir, "output")),
    inputFiles: [],
    gitLog: readTextIfExists(join(aggregateDir, "git-log.txt")).trim(),
    gitDiff: truncate(
      readTextIfExists(join(aggregateDir, "memfs.patch")),
      DIFF_CAP,
    ).text,
    stats: statsFor(steps),
  };
}

interface VizData {
  runId: string;
  agents: VizAgent[];
  runRoot: string;
}

function buildData(runRoot: string): VizData {
  const agents: VizAgent[] = [];

  const batchesRoot = join(runRoot, "batches");
  if (existsSync(batchesRoot)) {
    const indices = readdirSync(batchesRoot)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number.parseInt(name, 10))
      .sort((a, b) => a - b);
    for (const index of indices) {
      const agent = loadBatchAgent(join(batchesRoot, String(index)), index);
      if (agent) agents.push(agent);
    }
  }

  const aggregator = loadAggregatorAgent(join(runRoot, "aggregate"));
  if (aggregator) agents.push(aggregator);

  return { runId: basename(runRoot), agents, runRoot };
}

/** Resolve "latest", a run id, or an absolute run-root path to a run root. */
export function resolveDreamRunRoot(agentId: string, ref: string): string {
  if (ref !== "latest" && (ref.startsWith("/") || ref.startsWith("."))) {
    return ref;
  }
  if (ref !== "latest") {
    return getDreamRunRoot(agentId, ref);
  }
  const runsDir = join(getDreamRootDir(agentId), "runs");
  if (!existsSync(runsDir)) {
    throw new Error(`No dream runs recorded for ${agentId} (${runsDir})`);
  }
  const runs = readdirSync(runsDir)
    .filter((name) => !name.startsWith("."))
    .sort();
  const latest = runs[runs.length - 1];
  if (!latest) {
    throw new Error(`No dream runs recorded for ${agentId} (${runsDir})`);
  }
  return join(runsDir, latest);
}

export function generateDreamViz(runRoot: string): {
  html: string;
  agentCount: number;
} {
  const data = buildData(runRoot);
  return { html: renderHtml(data), agentCount: data.agents.length };
}

function renderHtml(data: VizData): string {
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  const runId = data.runId;
  return `<!doctype html>
<title>Dream — ${runId}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  --bg: #faf9f6; --panel: #ffffff; --ink: #23262e; --dim: #6d7180; --line: #e5e2da;
  --accent: #6d4fe0; --accent-soft: #efeafd; --gold: #a07617; --gold-soft: #f7efdc;
  --ok: #2c8a5f; --bad: #c4453c; --teal: #23767a; --teal-soft: #e4f1f0;
  --user: #46618f; --user-soft: #e9eef7; --code-bg: #f4f2ec;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #14151b; --panel: #1c1e26; --ink: #dfdfe6; --dim: #8b8e9c; --line: #2c2f3a;
  --accent: #9b83f0; --accent-soft: #292344; --gold: #d4aa4a; --gold-soft: #332b18;
  --ok: #55b98a; --bad: #e07a72; --teal: #5cb3b0; --teal-soft: #1c3234;
  --user: #8aa5d6; --user-soft: #222a3a; --code-bg: #22242e;
}}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 "Avenir Next", "Segoe UI", system-ui, sans-serif; }
.mono, pre, code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.layout { display: grid; grid-template-columns: 300px 1fr; min-height: 100vh; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .rail { position: static; height: auto; } }
.rail { border-right: 1px solid var(--line); padding: 20px 16px; position: sticky; top: 0;
  height: 100vh; overflow-y: auto; }
.rail h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: .01em; }
.rail .runid { color: var(--accent); font-size: 12px; margin-bottom: 14px; overflow-wrap: anywhere; }
.runmeta { font-size: 12px; color: var(--dim); display: grid; gap: 2px; margin-bottom: 18px; }
.runmeta b { color: var(--ink); font-weight: 600; }
.navhead { font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--dim); margin: 16px 0 6px; }
.navitem { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left;
  padding: 7px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--ink);
  cursor: pointer; font: inherit; font-size: 13px; }
.navitem:hover { background: var(--accent-soft); }
.navitem.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.navitem.agg.active { background: var(--gold-soft); color: var(--gold); }
.navitem .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; position: relative; top: -1px; }
.navitem small { color: var(--dim); font-weight: 400; margin-left: auto; }
main { padding: 26px 34px 80px; min-width: 0; }
.pagehead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 14px; margin-bottom: 4px; }
.pagehead h2 { margin: 0; font-size: 21px; }
.roletag { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; padding: 3px 9px;
  border-radius: 99px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.roletag.agg { background: var(--gold-soft); color: var(--gold); }
.statustag { font-size: 12px; font-weight: 600; }
.statustag.ok { color: var(--ok); } .statustag.bad { color: var(--bad); }
.agentid { color: var(--dim); font-size: 12px; margin: 2px 0 12px; overflow-wrap: anywhere; }
.agentid a { color: var(--accent); text-decoration: none; }
.agentid a:hover { text-decoration: underline; }
.tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0 24px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 10px 16px; }
.tile .v { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tile .k { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .07em; }
section h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .09em; color: var(--dim);
  margin: 30px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.step { border-left: 3px solid var(--line); padding: 2px 0 2px 14px; margin: 10px 0; }
.step .who { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 650; color: var(--dim); }
.step-user { border-color: var(--user); } .step-user .who { color: var(--user); }
.step-reasoning { border-color: var(--line); }
.step-reasoning .body { color: var(--dim); font-style: italic; }
.step-assistant { border-color: var(--accent); } .step-assistant .who { color: var(--accent); }
.step-tool { border-color: var(--teal); } .step-tool .who { color: var(--teal); }
.step .body { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 88ch; }
details { margin: 4px 0; }
summary { cursor: pointer; color: var(--dim); font-size: 12.5px; user-select: none; }
summary:hover { color: var(--ink); }
summary .tname { color: var(--teal); font-weight: 600; font-size: 13px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 7px;
  padding: 10px 12px; font-size: 12px; line-height: 1.5; overflow-x: auto; margin: 6px 0; }
.toolerr pre { border-color: var(--bad); }
.filetree { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
@media (max-width: 900px) { .filetree { grid-template-columns: 1fr; } }
.filelist { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 8px; }
.filelist button { display: block; width: 100%; text-align: left; border: 0; background: none;
  color: var(--ink); font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; padding: 5px 8px;
  border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.filelist button:hover { background: var(--accent-soft); }
.filelist button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.fileview pre { max-height: 480px; overflow: auto; margin: 0; }
.fileview .fname { font-size: 12.5px; color: var(--dim); margin-bottom: 6px; }
.empty { color: var(--dim); font-style: italic; }
.report { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--ok);
  border-radius: 9px; padding: 14px 18px; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 92ch; }
.errbox { border-left-color: var(--bad); color: var(--bad); }
</style>
<div class="layout">
  <nav class="rail" id="rail"></nav>
  <main id="main"></main>
</div>
<script type="application/json" id="data">${json}</script>
<script>
const DATA = JSON.parse(document.getElementById("data").textContent);
const reflections = DATA.agents.filter(a => a.role === "reflection");
const aggregators = DATA.agents.filter(a => a.role !== "reflection");
let activeId = (reflections[0] || DATA.agents[0] || {}).id;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function fmtDur(ms) { return ms >= 60000 ? Math.round(ms/6000)/10 + "m" : Math.round(ms/1000) + "s"; }

function renderRail() {
  const rail = document.getElementById("rail");
  rail.textContent = "";
  rail.appendChild(el("h1", null, "Dream Run"));
  rail.appendChild(el("div", "runid mono", DATA.runId));
  const meta = el("div", "runmeta");
  const okCount = reflections.filter(r => r.success).length;
  const sessionCount = reflections.reduce((n, r) => n + r.sessionIds.length, 0);
  meta.innerHTML =
    "<div><b>" + reflections.length + "</b> batches · <b>" + sessionCount + "</b> sessions</div>" +
    "<div><b>" + okCount + "/" + reflections.length + "</b> reflections succeeded</div>";
  rail.appendChild(meta);

  rail.appendChild(el("div", "navhead", "Reflection agents"));
  for (const agent of reflections) rail.appendChild(navItem(agent, false));
  if (aggregators.length) {
    rail.appendChild(el("div", "navhead", "Aggregation"));
    for (const agent of aggregators) rail.appendChild(navItem(agent, true));
  }
}
function navItem(agent, isAgg) {
  const btn = el("button", "navitem" + (isAgg ? " agg" : "") + (agent.id === activeId ? " active" : ""));
  const dot = el("span", "dot");
  dot.style.background = agent.success ? "var(--ok)" : "var(--bad)";
  btn.appendChild(dot);
  btn.appendChild(el("span", null, agent.label));
  btn.appendChild(el("small", null, fmtDur(agent.durationMs)));
  btn.onclick = () => { activeId = agent.id; render(); };
  return btn;
}

function elPre(text) { const pre = el("pre"); pre.textContent = text; return pre; }

function renderStep(step) {
  const div = el("div", "step step-" + step.kind);
  if (step.kind === "tool") {
    div.appendChild(el("div", "who", "tool"));
    const argsDetails = el("details", step.toolIsError ? "toolerr" : "");
    const summary = el("summary");
    summary.appendChild(el("span", "tname", step.toolName || "tool"));
    summary.appendChild(document.createTextNode(
      (step.toolIsError ? " — error" : "") + " (args" + (step.toolResult !== undefined ? " + result" : "") + ")"));
    argsDetails.appendChild(summary);
    if (step.toolArgs) argsDetails.appendChild(elPre(step.toolArgs));
    if (step.toolResult !== undefined) {
      argsDetails.appendChild(el("div", "who", "result"));
      argsDetails.appendChild(elPre(step.toolResult || "(empty)"));
    }
    div.appendChild(argsDetails);
  } else {
    const who = { user: "user prompt", reasoning: "reasoning", assistant: "assistant" }[step.kind];
    div.appendChild(el("div", "who", who));
    if (step.kind === "user" || (step.content && step.content.length > 2500)) {
      const details = el("details");
      details.appendChild(el("summary", null, (step.content || "").slice(0, 110) + "…"));
      details.appendChild(el("div", "body", step.content));
      div.appendChild(details);
    } else {
      div.appendChild(el("div", "body", step.content || ""));
    }
  }
  return div;
}

function renderFiles(files, container, emptyText) {
  if (!files.length) { container.appendChild(el("div", "empty", emptyText)); return; }
  const wrap = el("div", "filetree");
  const list = el("div", "filelist");
  const view = el("div", "fileview");
  const activeFile = files.find(f => !f.path.endsWith(".gitkeep")) || files[0];
  const show = (file) => {
    view.textContent = "";
    view.appendChild(el("div", "fname mono", file.path + (file.truncated ? "  (truncated)" : "")));
    view.appendChild(elPre(file.content || "(empty)"));
    for (const btn of list.children) btn.classList.toggle("active", btn.dataset.path === file.path);
  };
  for (const file of files) {
    const btn = el("button", null, file.path);
    btn.dataset.path = file.path;
    btn.onclick = () => show(file);
    list.appendChild(btn);
  }
  wrap.appendChild(list); wrap.appendChild(view);
  container.appendChild(wrap);
  show(activeFile);
}

function render() {
  renderRail();
  const main = document.getElementById("main");
  main.textContent = "";
  const agent = DATA.agents.find(a => a.id === activeId);
  if (!agent) { main.appendChild(el("div", "empty", "no agents in this run")); return; }

  const head = el("div", "pagehead");
  head.appendChild(el("h2", null, agent.label));
  head.appendChild(el("span", "roletag" + (agent.role !== "reflection" ? " agg" : ""), agent.role));
  head.appendChild(el("span", "statustag " + (agent.success ? "ok" : "bad"),
    agent.success ? "succeeded" : "failed"));
  main.appendChild(head);

  if (agent.agentId || agent.conversationId) {
    const ids = el("div", "agentid mono");
    if (agent.agentId) {
      ids.appendChild(document.createTextNode("agent "));
      if (agent.agentId.startsWith("agent-")) {
        const link = el("a", null, agent.agentId);
        link.href = "https://app.letta.com/chat/" + agent.agentId;
        link.target = "_blank";
        ids.appendChild(link);
      } else {
        ids.appendChild(el("span", null, agent.agentId));
      }
    }
    if (agent.conversationId) {
      if (agent.agentId) ids.appendChild(document.createTextNode("  ·  "));
      ids.appendChild(el("span", null, "conversation " + agent.conversationId));
    }
    main.appendChild(ids);
  }

  const tiles = el("div", "tiles");
  const tile = (v, k) => { const t = el("div", "tile"); t.appendChild(el("div", "v", String(v))); t.appendChild(el("div", "k", k)); return t; };
  tiles.appendChild(tile(agent.sessionIds.length, agent.role === "reflection" ? "sessions" : "inputs"));
  tiles.appendChild(tile(agent.stats.toolCalls, "tool calls"));
  tiles.appendChild(tile(agent.stats.reasoning, "reasoning"));
  tiles.appendChild(tile(fmtDur(agent.durationMs), "duration"));
  tiles.appendChild(tile(agent.files.filter(f => !f.path.endsWith(".gitkeep")).length, "memory files"));
  main.appendChild(tiles);

  if (agent.sessionIds.length) {
    const sess = el("details");
    sess.appendChild(el("summary", null, (agent.role === "reflection" ? "input sessions" : "inputs") + " (" + agent.sessionIds.length + ")"));
    sess.appendChild(elPre(agent.sessionIds.join("\\n")));
    main.appendChild(sess);
  }
  if (agent.error) {
    main.appendChild(el("section")).appendChild(el("div", "report errbox", agent.error));
  }

  const trajSection = el("section");
  trajSection.appendChild(el("h3", null, "Trajectory (" + agent.steps.length + " steps)"));
  if (agent.steps.length) {
    for (const step of agent.steps) trajSection.appendChild(renderStep(step));
  } else {
    trajSection.appendChild(el("div", "empty", "no trajectory recorded"));
  }
  main.appendChild(trajSection);

  if (agent.report) {
    const repSection = el("section");
    repSection.appendChild(el("h3", null, "Final report"));
    repSection.appendChild(el("div", "report", agent.report));
    main.appendChild(repSection);
  }

  if (agent.inputFiles.length) {
    const inSection = el("section");
    inSection.appendChild(el("h3", null, "Input transcripts"));
    renderFiles(agent.inputFiles, inSection, "no inputs");
    main.appendChild(inSection);
  }

  const fsSection = el("section");
  fsSection.appendChild(el("h3", null, agent.role === "aggregator" ? "Aggregated memory filesystem" : "Output memory filesystem"));
  renderFiles(agent.files, fsSection, "no files");
  main.appendChild(fsSection);

  const gitSection = el("section");
  gitSection.appendChild(el("h3", null, agent.role === "aggregator" ? "Memory changes landed" : "Git history"));
  if (agent.gitLog.trim() || agent.gitDiff.trim()) {
    if (agent.gitLog.trim()) gitSection.appendChild(elPre(agent.gitLog.trim()));
    if (agent.gitDiff.trim()) {
      const diff = el("details");
      diff.appendChild(el("summary", null, "full diff of memory changes"));
      diff.appendChild(elPre(agent.gitDiff.trim()));
      gitSection.appendChild(diff);
    }
  } else {
    gitSection.appendChild(el("div", "empty", "no git history"));
  }
  main.appendChild(gitSection);
  window.scrollTo(0, 0);
}
render();
</script>`;
}
