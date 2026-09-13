import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { evaluateProbe } from "./runtime-observations.ts";
import {
  type CommandRunner,
  type CommandSpec,
  runBoundedCommand,
  sandboxClaudeCommand,
} from "./runtime-sandbox.ts";
import type {
  ClaudeProbeObservation,
  ClaudeRuntimeDiff,
  ClaudeRuntimeSnapshot,
} from "./types.ts";

const PACKAGE_NAME = "@anthropic-ai/claude-code";
export const CLAUDE_PROBE_CONTRACT_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP = 2 * 1024 * 1024;
const AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
// biome-ignore lint/suspicious/noControlCharactersInRegex: this intentionally strips ANSI escape sequences.
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const VOLATILE_KEYS = new Set([
  "id",
  "message_id",
  "session_id",
  "request_id",
  "uuid",
  "timestamp",
  "created_at",
  "duration_ms",
  "duration_api_ms",
  "total_cost_usd",
  "cost_usd",
  "usage",
]);
const SAFE_INIT_FIELDS = new Set([
  "permissionMode",
  "claude_code_version",
  "output_style",
  "fast_mode_state",
]);
const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|credential|password|api.?key|email|account|organization|user.?name)/iu;

export interface ClaudeRuntimeCommandPlan {
  root: string;
  installRoot: string;
  home: string;
  config: string;
  repo: string;
  packageSpec: string;
  binary: string;
  install: CommandSpec;
  initializeRepo: CommandSpec;
  verifyPackage: CommandSpec;
  version: CommandSpec;
  help: CommandSpec;
  doctor: CommandSpec;
  autoModeDefaults: CommandSpec;
  init: CommandSpec;
  probes: Array<{ name: string; command: CommandSpec }>;
}

export interface CaptureClaudeRuntimeOptions {
  version: string;
  tempDir: string;
  dryRun?: boolean;
  keepRoot?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  timeoutMs?: number;
  outputCapBytes?: number;
  maxProbeAttempts?: number;
  requireAuth?: boolean;
  reuseProbes?: ClaudeProbeObservation[];
  sandbox?: "docker" | "direct";
}

export interface ParsedClaudeStream {
  events: unknown[];
  eventTypes: string[];
  init: {
    tools: string[];
    model: string | null;
    capabilities: unknown | null;
    stableFields: Record<string, unknown>;
  } | null;
  toolCalls: Array<{ id: string | null; name: string; input: unknown }>;
  toolResults: Array<{
    toolUseId: string | null;
    content: string;
    isError: boolean;
  }>;
}

export function isClaudeProbeContractCurrent(
  runtime: ClaudeRuntimeSnapshot | null | undefined,
): boolean {
  return runtime?.probe_contract_version === CLAUDE_PROBE_CONTRACT_VERSION;
}

interface ProbeDefinition {
  name: string;
  allowedTools: string[];
  prompt: string;
}

const PROBES: ProbeDefinition[] = [
  {
    name: "read-lines-9-10-tab-prefix",
    allowedTools: ["Read"],
    prompt:
      "Use the Read tool exactly once on ./read-fixture.txt with offset 9 and limit 2. Then stop. Do not modify files or use any other tool.",
  },
  {
    name: "task-metadata-delete-contract",
    allowedTools: ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList"],
    prompt:
      'Exercise only the task tools and continue through every step even if one call reports an error. Create one task named "probe-task" with metadata {"probe":"remove","keep":"yes"}; update metadata with {"probe":null,"count":3,"flags":["ready"],"details":{"source":"claude-watch"}}; get the resulting task record; permanently delete it with TaskUpdate status "deleted"; get the deleted ID again expecting a not-found error; then list tasks to confirm it is absent. Do not perform other work or use other tools.',
  },
];

function safeVersion(version: string): string {
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  ) {
    throw new Error(`Invalid exact Claude version: ${version}`);
  }
  return version;
}

function command(
  label: string,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputCapBytes: number,
  stdin?: string,
): CommandSpec {
  return {
    command: executable,
    args,
    cwd,
    env,
    timeoutMs,
    outputCapBytes,
    stdin,
    label,
  };
}

export function createClaudeRuntimeCommandPlan(
  version: string,
  root: string,
  options: Pick<
    CaptureClaudeRuntimeOptions,
    "env" | "timeoutMs" | "outputCapBytes"
  > = {},
): ClaudeRuntimeCommandPlan {
  safeVersion(version);
  const installRoot = join(root, "install");
  const home = join(root, "home");
  const config = join(root, "config");
  const repo = join(root, "repo");
  const binary = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "claude.cmd" : "claude",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputCapBytes = options.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  const suppliedEnv = options.env ?? process.env;
  const commonEnv: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    CLAUDE_CONFIG_DIR: config,
    DISABLE_UPDATES: "1",
    DISABLE_AUTOUPDATER: "1",
    CI: "1",
    NO_COLOR: "1",
    COLUMNS: "120",
    LINES: "40",
    TERM: "dumb",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    PATH: suppliedEnv.PATH ?? "/usr/bin:/bin",
  };
  const runtimeEnv: NodeJS.ProcessEnv = { ...commonEnv };
  for (const key of AUTH_ENV_KEYS) {
    if (suppliedEnv[key]) runtimeEnv[key] = suppliedEnv[key];
  }
  const packageSpec = `${PACKAGE_NAME}@${version}`;
  const streamArgs = [
    "-p",
    "Reply with exactly OK and do not use tools.",
    "--safe-mode",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--max-budget-usd",
    "0.05",
  ];
  const autoModeDefaults = command(
    "auto-mode-defaults",
    binary,
    ["auto-mode", "defaults"],
    repo,
    runtimeEnv,
    timeoutMs,
    outputCapBytes,
  );
  const probeCommands = PROBES.map((probe) => ({
    name: probe.name,
    command: command(
      `probe:${probe.name}`,
      binary,
      [
        "-p",
        probe.prompt,
        "--safe-mode",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--tools",
        probe.allowedTools.join(","),
        "--allowedTools",
        probe.allowedTools.join(","),
        "--max-budget-usd",
        "0.25",
      ],
      repo,
      runtimeEnv,
      Math.min(timeoutMs, 60_000),
      outputCapBytes,
    ),
  }));
  return {
    root,
    installRoot,
    home,
    config,
    repo,
    packageSpec,
    binary,
    install: command(
      "install",
      "npm",
      [
        "install",
        "--prefix",
        installRoot,
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        packageSpec,
      ],
      root,
      commonEnv,
      Math.max(timeoutMs, 300_000),
      outputCapBytes,
    ),
    initializeRepo: command(
      "git-init",
      "/usr/bin/git",
      ["init", "--quiet"],
      repo,
      commonEnv,
      timeoutMs,
      outputCapBytes,
    ),
    verifyPackage: command(
      "verify-package",
      "node",
      [
        "-e",
        "const p=require(process.argv[1]); process.stdout.write(String(p.version))",
        join(installRoot, "node_modules", PACKAGE_NAME, "package.json"),
      ],
      root,
      commonEnv,
      timeoutMs,
      outputCapBytes,
    ),
    version: command(
      "version",
      binary,
      ["--version"],
      repo,
      commonEnv,
      timeoutMs,
      outputCapBytes,
    ),
    help: command(
      "help",
      binary,
      ["--help"],
      repo,
      commonEnv,
      timeoutMs,
      outputCapBytes,
    ),
    doctor: command(
      "doctor",
      binary,
      ["doctor"],
      repo,
      commonEnv,
      timeoutMs,
      outputCapBytes,
    ),
    autoModeDefaults,
    init: command(
      "init-stream",
      binary,
      streamArgs,
      repo,
      runtimeEnv,
      Math.min(timeoutMs, 60_000),
      outputCapBytes,
    ),
    probes: probeCommands,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(textContent).filter(Boolean).join("\n");
  const object = record(value);
  if (!object) return "";
  return textContent(object.text ?? object.content ?? object.output ?? "");
}

function contentBlocks(event: Record<string, unknown>): unknown[] {
  const message = record(event.message);
  const content = message?.content ?? event.content;
  return Array.isArray(content)
    ? content
    : content === undefined
      ? []
      : [content];
}

export function parseClaudeStream(output: string): ParsedClaudeStream {
  const events: unknown[] = [];
  for (const [index, rawLine] of output.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`Malformed Claude stream-json at line ${index + 1}`);
    }
  }
  if (events.length === 0)
    throw new Error("Claude stream-json contained no events");

  let init: ParsedClaudeStream["init"] = null;
  const eventTypes = new Set<string>();
  const toolCalls: ParsedClaudeStream["toolCalls"] = [];
  const toolResults: ParsedClaudeStream["toolResults"] = [];
  for (const eventValue of events) {
    const event = record(eventValue);
    if (!event) continue;
    const type = typeof event.type === "string" ? event.type : "unknown";
    const subtype = typeof event.subtype === "string" ? event.subtype : null;
    eventTypes.add(subtype ? `${type}/${subtype}` : type);
    if (!init && type === "system" && subtype === "init") {
      const tools = Array.isArray(event.tools)
        ? event.tools.filter((tool): tool is string => typeof tool === "string")
        : [];
      const stableFields: Record<string, unknown> = {};
      const structuralFields = new Set([
        "type",
        "subtype",
        "tools",
        "model",
        "capabilities",
        "cwd",
        "session_id",
      ]);
      for (const key of Object.keys(event).sort()) {
        if (!structuralFields.has(key) && SAFE_INIT_FIELDS.has(key))
          stableFields[key] = normalizeVolatile(event[key]);
      }
      init = {
        tools: [...new Set(tools)].sort(),
        model: typeof event.model === "string" ? event.model : null,
        capabilities: normalizeVolatile(event.capabilities ?? null),
        stableFields,
      };
    }
    for (const blockValue of contentBlocks(event)) {
      const block = record(blockValue);
      if (!block) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : null,
          name: block.name,
          input: normalizeVolatile(block.input ?? null),
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          toolUseId:
            typeof block.tool_use_id === "string" ? block.tool_use_id : null,
          content: normalizeToolResultText(textContent(block.content)),
          isError: block.is_error === true,
        });
      }
    }
  }
  return {
    events,
    eventTypes: [...eventTypes].sort(),
    init,
    toolCalls,
    toolResults,
  };
}

function normalizeString(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .replace(/\b(?:sk-ant|sk-|oauth-)[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
    .replace(/[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27,}/g, "<id>")
    .replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(
      /(["']?(?:createdAt|updatedAt|created_at|updated_at)["']?\s*[:=]\s*)\d{10,}/gu,
      "$1<timestamp>",
    )
    .replace(/\/tmp\/[\w./-]+/g, "<tmp>")
    .replace(/\\tmp\\[-\w.\\]+/g, "<tmp>");
}

export function normalizeText(value: string): string {
  return normalizeString(value).trim();
}

export function normalizeToolResultText(value: string): string {
  return normalizeString(value);
}

export function normalizeVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeVolatile);
  if (typeof value === "string") return normalizeText(value);
  const object = record(value);
  if (!object) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    if (!VOLATILE_KEYS.has(key) && !SENSITIVE_KEY_PATTERN.test(key))
      normalized[key] = normalizeVolatile(object[key]);
  }
  return normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeVolatile(value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticProbe(probe: ClaudeProbeObservation): unknown {
  return {
    name: probe.name,
    status: probe.status,
    assertions: probe.assertions,
    error: probe.error,
  };
}

function namesDiff(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } {
  const oldSet = new Set(before);
  const newSet = new Set(after);
  return {
    added: [...newSet].filter((name) => !oldSet.has(name)).sort(),
    removed: [...oldSet].filter((name) => !newSet.has(name)).sort(),
  };
}

function linesDiff(
  before: string,
  after: string,
): { added: string[]; removed: string[] } {
  const oldLines = new Set(before.split("\n").filter(Boolean));
  const newLines = new Set(after.split("\n").filter(Boolean));
  return {
    added: [...newLines].filter((line) => !oldLines.has(line)).sort(),
    removed: [...oldLines].filter((line) => !newLines.has(line)).sort(),
  };
}

export function diffClaudeRuntime(
  previous: ClaudeRuntimeSnapshot,
  current: ClaudeRuntimeSnapshot,
): ClaudeRuntimeDiff {
  const tools = namesDiff(
    previous.init?.tools ?? [],
    current.init?.tools ?? [],
  );
  const eventTypes = namesDiff(
    previous.event_inventory,
    current.event_inventory,
  );
  const helpLines = linesDiff(previous.help_text, current.help_text);
  const oldProbes = new Map(
    previous.probes.map((probe) => [
      probe.name,
      stableJson(semanticProbe(probe)),
    ]),
  );
  const newProbes = new Map(
    current.probes.map((probe) => [
      probe.name,
      stableJson(semanticProbe(probe)),
    ]),
  );
  const changedProbes = [...new Set([...oldProbes.keys(), ...newProbes.keys()])]
    .filter((name) => oldProbes.get(name) !== newProbes.get(name))
    .sort();
  return {
    tools_added: tools.added,
    tools_removed: tools.removed,
    help_changed: previous.help_hash !== current.help_hash,
    help_lines_added: helpLines.added,
    help_lines_removed: helpLines.removed,
    doctor_changed: stableJson(previous.doctor) !== stableJson(current.doctor),
    init_changed: stableJson(previous.init) !== stableJson(current.init),
    auto_mode_defaults_changed:
      stableJson(previous.auto_mode_defaults) !==
      stableJson(current.auto_mode_defaults),
    event_types_added: eventTypes.added,
    event_types_removed: eventTypes.removed,
    changed_probes: changedProbes,
  };
}

export const diffRuntimeSnapshots = diffClaudeRuntime;

function checkResult(result: CommandResult, label: string): void {
  if (result.timedOut) throw new Error(`Command ${label} timed out`);
  if (result.truncated)
    throw new Error(`Command ${label} exceeded its output cap`);
  if (result.exitCode !== 0) throw new Error(`Command ${label} exited nonzero`);
}

function authAvailable(env: NodeJS.ProcessEnv): boolean {
  return AUTH_ENV_KEYS.some(
    (key) => typeof env[key] === "string" && (env[key]?.length ?? 0) > 0,
  );
}

function isAuthFailure(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /not logged in|authentication|authenticate|api key|oauth|unauthorized/.test(
    text,
  );
}

function doctorSummary(result: CommandResult, env: NodeJS.ProcessEnv): string {
  let combined = `${result.stdout}\n${result.stderr}`;
  for (const key of AUTH_ENV_KEYS) {
    const secret = env[key];
    if (secret) combined = combined.split(secret).join("<redacted>");
  }
  return normalizeText(combined)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 40)
    .join("\n")
    .slice(0, 8_000);
}

function normalizeDoctorVersion(summary: string, version: string): string {
  return summary
    .replaceAll(version, "<version>")
    .replace(/^Commit: [0-9a-f]+$/gmu, "Commit: <commit>");
}

export function extractAutoModeDefaults(output: string): unknown | null {
  const normalized = normalizeText(output);
  if (!normalized) return null;
  try {
    return normalizeVolatile(JSON.parse(normalized));
  } catch {
    // Older releases may print the defaults as text rather than JSON.
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length > 0 ? [...new Set(lines)].sort() : null;
  }
}

async function filesystemInventory(root: string): Promise<Map<string, string>> {
  const inventory = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        inventory.set(
          name,
          `${info.size}:${hash(await readFile(path, "utf8"))}`,
        );
      }
    }
  }
  await walk(root);
  return inventory;
}

function filesystemChanges(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((name) => {
    if (!before.has(name)) return [`added:${name}`];
    if (!after.has(name)) return [`removed:${name}`];
    return before.get(name) === after.get(name) ? [] : [`changed:${name}`];
  });
}

function skippedProbe(name: string, reason: string): ClaudeProbeObservation {
  return {
    name,
    status: "skipped",
    attempts: 0,
    assertions: {},
    tool_calls: [],
    tool_results: [],
    filesystem_changes: [],
    error: reason,
  };
}

async function runProbe(
  definition: ProbeDefinition,
  spec: CommandSpec,
  runner: CommandRunner,
  repo: string,
  maxAttempts: number,
): Promise<ClaudeProbeObservation> {
  let lastError = "Probe produced no conclusive tool transcript";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await filesystemInventory(repo);
    const result = await runner(spec);
    const after = await filesystemInventory(repo);
    if (result.timedOut || result.truncated || result.exitCode !== 0) {
      lastError = result.timedOut
        ? "Probe timed out"
        : result.truncated
          ? "Probe exceeded output cap"
          : "Probe exited nonzero";
      continue;
    }
    let parsed: ParsedClaudeStream;
    try {
      parsed = parseClaudeStream(result.stdout);
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Malformed probe stream";
      continue;
    }
    const disallowed = parsed.toolCalls.find(
      (call) => !definition.allowedTools.includes(call.name),
    );
    const evaluation = evaluateProbe(definition.name, parsed);
    const observation: ClaudeProbeObservation = {
      name: definition.name,
      status: disallowed
        ? "failed"
        : evaluation.complete
          ? "passed"
          : "inconclusive",
      attempts: attempt,
      assertions: evaluation.assertions,
      tool_calls: parsed.toolCalls.map(({ name, input }) => ({ name, input })),
      tool_results: parsed.toolResults.map(
        (resultValue) => resultValue.content,
      ),
      filesystem_changes: filesystemChanges(before, after),
      error: disallowed
        ? `Tool outside allowlist: ${disallowed.name}`
        : evaluation.complete
          ? null
          : "Probe transcript did not complete the fixed contract",
    };
    if (observation.status !== "inconclusive" || attempt === maxAttempts)
      return observation;
    lastError = "Probe transcript did not complete the fixed contract";
  }
  return {
    name: definition.name,
    status: "inconclusive",
    attempts: maxAttempts,
    assertions: {},
    tool_calls: [],
    tool_results: [],
    filesystem_changes: [],
    error: lastError,
  };
}

/**
 * Installs and captures one exact Claude release in its own disposable root.
 * Dry-run returns null before creating directories or invoking install/auth commands.
 */
export async function captureClaudeRuntime(
  options: CaptureClaudeRuntimeOptions,
): Promise<ClaudeRuntimeSnapshot | null> {
  safeVersion(options.version);
  if (options.dryRun) return null;
  const root = await mkdtemp(
    join(resolve(options.tempDir), `claude-${options.version}-`),
  );
  const plan = createClaudeRuntimeCommandPlan(options.version, root, options);
  const runner = options.runner ?? runBoundedCommand;
  const sandboxed = (spec: CommandSpec): CommandSpec =>
    options.sandbox === "direct" ? spec : sandboxClaudeCommand(spec, root);
  try {
    await Promise.all([
      mkdir(plan.installRoot, { recursive: true }),
      mkdir(plan.home, { recursive: true }),
      mkdir(plan.config, { recursive: true }),
      mkdir(plan.repo, { recursive: true }),
    ]);
    await writeFile(
      join(plan.repo, "read-fixture.txt"),
      [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "line9",
        "line10",
        "eleven",
      ].join("\n"),
      "utf8",
    );

    checkResult(await runner(sandboxed(plan.install)), plan.install.label);
    checkResult(await runner(plan.initializeRepo), plan.initializeRepo.label);
    const packageResult = await runner(sandboxed(plan.verifyPackage));
    checkResult(packageResult, plan.verifyPackage.label);
    if (packageResult.stdout.trim() !== options.version) {
      throw new Error(
        `Installed Claude package version mismatch: expected ${options.version}`,
      );
    }
    const versionResult = await runner(sandboxed(plan.version));
    checkResult(versionResult, plan.version.label);
    const reportedVersion =
      /^\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/u.exec(
        versionResult.stdout,
      )?.[1];
    if (reportedVersion !== options.version) {
      throw new Error(`Claude --version mismatch: expected ${options.version}`);
    }
    const helpResult = await runner(sandboxed(plan.help));
    checkResult(helpResult, plan.help.label);
    const normalizedHelp = normalizeText(helpResult.stdout);
    const safeModeSupported = normalizedHelp.includes("--safe-mode");
    if (!safeModeSupported) {
      plan.init.args = plan.init.args.filter(
        (argument) => argument !== "--safe-mode",
      );
      for (const probe of plan.probes) {
        probe.command.args = probe.command.args.filter(
          (argument) => argument !== "--safe-mode",
        );
      }
    }
    const doctorResult = await runner(sandboxed(plan.doctor));
    if (doctorResult.truncated) checkResult(doctorResult, plan.doctor.label);
    const autoResult = await runner(sandboxed(plan.autoModeDefaults));
    if (autoResult.truncated)
      checkResult(autoResult, plan.autoModeDefaults.label);

    let init: ClaudeRuntimeSnapshot["init"] = null;
    let eventInventory: string[] = [];
    const probes: ClaudeProbeObservation[] = [];
    if (authAvailable(plan.init.env)) {
      const initResult = await runner(sandboxed(plan.init));
      if (initResult.exitCode !== 0 && isAuthFailure(initResult)) {
        throw new Error(
          "Claude runtime authentication failed. Check the ANTHROPIC_API_KEY Actions secret and rerun the watcher.",
        );
      } else {
        checkResult(initResult, plan.init.label);
        const parsed = parseClaudeStream(initResult.stdout);
        if (!parsed.init) {
          throw new Error(
            "Claude stream completed without a system/init event; runtime inventory is incomplete.",
          );
        }
        init = {
          tools: parsed.init.tools,
          model: parsed.init.model,
          capabilities: parsed.init.capabilities,
          stable_fields: parsed.init.stableFields,
        };
        eventInventory = parsed.eventTypes;
        if (options.reuseProbes) {
          probes.push(
            ...options.reuseProbes.map(
              (probe) => normalizeVolatile(probe) as ClaudeProbeObservation,
            ),
          );
        } else {
          for (const [index, probe] of PROBES.entries()) {
            const probePlan = plan.probes[index];
            if (!probePlan)
              throw new Error(`Missing command plan for probe ${probe.name}`);
            probes.push(
              await runProbe(
                probe,
                sandboxed(probePlan.command),
                runner,
                plan.repo,
                Math.max(1, Math.min(options.maxProbeAttempts ?? 2, 3)),
              ),
            );
          }
        }
      }
    } else if (options.requireAuth !== false) {
      throw new Error(
        "ANTHROPIC_API_KEY is required for Claude runtime inventory and probes.",
      );
    } else {
      for (const probe of PROBES)
        probes.push(skippedProbe(probe.name, "Authentication unavailable"));
    }

    const snapshotWithoutDigest = {
      probe_contract_version: CLAUDE_PROBE_CONTRACT_VERSION,
      version: options.version,
      version_output: normalizeText(versionResult.stdout),
      help_text: normalizedHelp,
      help_hash: hash(normalizedHelp),
      doctor: {
        exit_code: doctorResult.exitCode ?? -1,
        summary: doctorResult.timedOut
          ? "timed_out"
          : normalizeDoctorVersion(
              doctorSummary(doctorResult, plan.doctor.env),
              options.version,
            ),
      },
      auto_mode_defaults:
        !autoResult.timedOut && autoResult.exitCode === 0
          ? extractAutoModeDefaults(autoResult.stdout)
          : null,
      init,
      event_inventory: eventInventory,
      probes,
    };
    const semanticSnapshot = {
      ...snapshotWithoutDigest,
      probes: probes.map(semanticProbe),
    };
    return {
      ...snapshotWithoutDigest,
      digest: hash(stableJson(semanticSnapshot)),
    };
  } finally {
    if (!options.keepRoot) await rm(root, { recursive: true, force: true });
  }
}
