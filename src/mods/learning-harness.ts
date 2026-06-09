import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type HeadlessLearningOutputFormat = "json" | "stream-json";

export interface ModLearningExample {
  input: string;
  expected?: string;
  notes?: string;
}

export interface ModLearningEvaluationSpec {
  forbiddenTraceMarkers?: string[];
  prompt: string;
  outputFormat?: HeadlessLearningOutputFormat;
  timeoutMs?: number;
  maxTurns?: number;
  memoryFiles?: Record<string, string>;
  requiredResultMarkers?: string[];
  requiredTraceMarkers?: string[];
  forbiddenResultMarkers?: string[];
}

export interface ModLearningSpec {
  name: string;
  slug?: string;
  objective: string;
  targetModName?: string;
  requirements: string[];
  modApiHints?: string[];
  examples?: ModLearningExample[];
  evaluation: ModLearningEvaluationSpec;
}

export interface CommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CommandRunResult {
  args: string[];
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

export interface MarkerCheck {
  marker: string;
  present: boolean;
}

export interface ModLearningEvaluationResult {
  forbiddenResultMarkers: MarkerCheck[];
  forbiddenTraceMarkers: MarkerCheck[];
  requiredResultMarkers: MarkerCheck[];
  requiredTraceMarkers: MarkerCheck[];
  resultText: string;
  passed: boolean;
}

export interface RunModLearningOptions {
  backend?: string;
  candidateFileName?: string;
  candidateSourcePath?: string;
  cliArgsPrefix?: string[];
  cliCommand?: string;
  commandRunner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  evalModel?: string;
  generationModel?: string;
  onProgress?: (progress: ModLearningProgress) => void;
  outputBaseDir?: string;
  promoteToPath?: string;
  repoRoot: string;
  runDir?: string;
  skipGeneration?: boolean;
  spec: ModLearningSpec;
}

export type ModLearningProgressPhase =
  | "preparing"
  | "generating"
  | "evaluating"
  | "promoting"
  | "writing-report"
  | "done";

export interface ModLearningProgress {
  candidatePath: string;
  message: string;
  phase: ModLearningProgressPhase;
  runDir: string;
}

export interface ModLearningReport {
  candidatePath: string;
  evalMemoryDir: string;
  evalResult: CommandRunResult | null;
  evaluation: ModLearningEvaluationResult;
  generationResult: CommandRunResult | null;
  passed: boolean;
  promotedToPath: string | null;
  reportPath: string;
  runDir: string;
  spec: ModLearningSpec;
}

interface HeadlessCommandOptions {
  backend?: string;
  maxTurns?: number;
  model?: string;
  noMods?: boolean;
  outputFormat: HeadlessLearningOutputFormat;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "mod-learning-run";
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function defaultModLearningRunDirectory(
  spec: ModLearningSpec,
  baseDir: string = path.join(".letta", "mod-learning-runs"),
  now: Date = new Date(),
): string {
  return path.join(
    baseDir,
    `${slugify(spec.slug ?? spec.name)}-${timestampForPath(now)}`,
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function markerChecks(
  markers: string[] | undefined,
  haystack: string,
): MarkerCheck[] {
  return (markers ?? []).map((marker) => ({
    marker,
    present: haystack.includes(marker),
  }));
}

function allPresent(checks: MarkerCheck[]): boolean {
  return checks.every((check) => check.present);
}

function allAbsent(checks: MarkerCheck[]): boolean {
  return checks.every((check) => !check.present);
}

function normalizeCandidateFileName(
  spec: ModLearningSpec,
  fileName: string | undefined,
): string {
  if (fileName?.trim()) return fileName;
  return `${slugify(spec.slug ?? spec.name)}.ts`;
}

function safeJoin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return resolved;
  }
  throw new Error(`Path escapes run directory: ${relativePath}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonArtifact(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCommandArtifacts(
  prefix: string,
  command: string,
  args: string[],
  result: CommandRunResult,
): Promise<void> {
  await writeFile(
    `${prefix}.command.txt`,
    `${renderCommand(command, args)}\n`,
    "utf8",
  );
  await writeFile(`${prefix}.stdout`, result.stdout, "utf8");
  await writeFile(`${prefix}.stderr`, result.stderr, "utf8");
  await writeJsonArtifact(`${prefix}.result.json`, result);
}

async function prepareMemoryFiles(
  memoryDir: string,
  memoryFiles: Record<string, string> | undefined,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(memoryFiles ?? {})) {
    const filePath = safeJoin(memoryDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function renderEvaluationPrompt(prompt: string, memoryDir: string): string {
  return prompt.replace(/\$\{MEMORY_DIR\}|\$MEMORY_DIR/g, () => memoryDir);
}

export function buildModLearningPrompt(
  spec: ModLearningSpec,
  candidatePath: string,
): string {
  const requirements = spec.requirements
    .map((requirement, index) => `${index + 1}. ${requirement}`)
    .join("\n");
  const hints = (spec.modApiHints ?? [])
    .map((hint, index) => `${index + 1}. ${hint}`)
    .join("\n");
  const examples = (spec.examples ?? [])
    .map((example, index) => {
      const parts = [`Example ${index + 1}:`, `Input: ${example.input}`];
      if (hasText(example.expected))
        parts.push(`Expected: ${example.expected}`);
      if (hasText(example.notes)) parts.push(`Notes: ${example.notes}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return `You are dogfooding Letta Code's trusted local mod system. Learn a minimal mod from the target spec and write the candidate mod file.\n\nTarget: ${spec.name}\nObjective: ${spec.objective}\nCandidate file, absolute path: ${candidatePath}\n\nHard rules:\n- Edit only the candidate file above. Do not modify repository source, docs, package files, tests, or git state.\n- Export either \`activate(letta)\` or a default function.\n- Use the trusted local mod API directly; do not import from "@/..." or from this repo's src files.\n- Prefer a small implementation that satisfies the behavior over a polished product mod.\n- If you register an eval-facing tool, set \`requiresApproval: false\` and keep it read-only.\n- Do not run tests or lint. Write the candidate file and stop.\n\nMinimal mod API reminder:\n\`\`\`ts\nexport function activate(letta) {\n  const disposers = [];\n  if (letta.capabilities.events.turns) {\n    disposers.push(letta.events.on("turn_start", (event) => {\n      // event.input is an array of message/approval objects. Do not append\n      // strings to existing content because content may be structured parts.\n      event.input = [\n        ...event.input,\n        { type: "message", role: "system", content: "mod reminder" },\n      ];\n      return { input: event.input };\n    }));\n  }\n  if (letta.capabilities.events.tools) {\n    disposers.push(letta.events.on("tool_start", (event, ctx) => {\n      // event.toolName, event.args, event.conversationId, ctx.getContext().\n    }));\n  }\n  if (letta.capabilities.tools) {\n    disposers.push(letta.tools.register({\n      name: "example_tool",\n      description: "Short tool description",\n      parameters: { type: "object", properties: {}, additionalProperties: false },\n      requiresApproval: false,\n      parallelSafe: true,\n      run(ctx) {\n        // For conversation-scoped state, use ctx.conversation.id or\n        // ctx.getContext().sessionId as the key.\n        return "ok";\n      },\n    }));\n  }\n  return () => disposers.reverse().forEach((dispose) => dispose());\n}\n\`\`\`\n\nRequirements:\n${requirements}\n${hints ? `\nUseful API/implementation hints:\n${hints}\n` : ""}${examples ? `\nDemos:\n${examples}\n` : ""}\nEvaluation prompt this candidate must satisfy:\n${spec.evaluation.prompt}\n\nWrite the candidate mod now, then reply with only a concise summary and the file path.`;
}
function buildHeadlessArgs(
  prompt: string,
  options: HeadlessCommandOptions,
): string[] {
  const args = [
    "-p",
    prompt,
    "--new-agent",
    "--no-memfs",
    "--no-system-info-reminder",
    "--yolo",
    "--output-format",
    options.outputFormat,
  ];
  if (options.noMods) args.push("--no-mods");
  if (options.model) args.push("--model", options.model);
  if (options.backend) args.push("--backend", options.backend);
  if (options.maxTurns !== undefined)
    args.push("--max-turns", String(options.maxTurns));
  return args;
}

export function extractHeadlessResultText(
  stdout: string,
  outputFormat: HeadlessLearningOutputFormat,
): string {
  if (outputFormat === "json") {
    try {
      const parsed = JSON.parse(stdout) as { result?: unknown };
      return typeof parsed.result === "string" ? parsed.result : "";
    } catch {
      return "";
    }
  }

  const assistantParts: string[] = [];
  let finalResult: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const payload =
        parsed.type === "stream_event" &&
        parsed.event &&
        typeof parsed.event === "object"
          ? (parsed.event as Record<string, unknown>)
          : parsed;
      if (payload.type === "result" && typeof payload.result === "string") {
        finalResult = payload.result;
      } else if (
        (payload.type === "message" || payload.type === undefined) &&
        payload.message_type === "assistant_message" &&
        typeof payload.content === "string"
      ) {
        assistantParts.push(payload.content);
      }
    } catch {
      // Ignore non-JSON diagnostic lines; raw stdout is still saved as trace.
    }
  }
  return finalResult ?? assistantParts.join("");
}

export function evaluateModLearningRun(params: {
  exitCode: number | null;
  outputFormat: HeadlessLearningOutputFormat;
  spec: ModLearningEvaluationSpec;
  stderr?: string;
  stdout: string;
  timedOut: boolean;
}): ModLearningEvaluationResult {
  const resultText = extractHeadlessResultText(
    params.stdout,
    params.outputFormat,
  );
  const requiredResultMarkers = markerChecks(
    params.spec.requiredResultMarkers,
    resultText,
  );
  const traceText = `${params.stdout}\n${params.stderr ?? ""}`;
  const requiredTraceMarkers = markerChecks(
    params.spec.requiredTraceMarkers,
    traceText,
  );
  const forbiddenTraceMarkers = markerChecks(
    params.spec.forbiddenTraceMarkers,
    traceText,
  );
  const forbiddenResultMarkers = markerChecks(
    params.spec.forbiddenResultMarkers,
    resultText,
  );
  const passed =
    params.exitCode === 0 &&
    !params.timedOut &&
    allPresent(requiredResultMarkers) &&
    allPresent(requiredTraceMarkers) &&
    allAbsent(forbiddenResultMarkers) &&
    allAbsent(forbiddenTraceMarkers);

  return {
    forbiddenResultMarkers,
    forbiddenTraceMarkers,
    requiredResultMarkers,
    requiredTraceMarkers,
    resultText,
    passed,
  };
}

export async function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandRunOptions,
): Promise<CommandRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let killedHard = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !killedHard) {
          killedHard = true;
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      stderrChunks.push(Buffer.from(String(error.stack ?? error.message)));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        args,
        command,
        cwd: options.cwd,
        durationMs: Date.now() - startedAt,
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

function renderMarkerSection(label: string, checks: MarkerCheck[]): string[] {
  if (checks.length === 0) return [`- ${label}: none configured`];
  return [
    `- ${label}:`,
    ...checks.map(
      (check) => `  - ${check.present ? "✅" : "❌"} ${check.marker}`,
    ),
  ];
}

function renderMarkdownReport(report: ModLearningReport): string {
  const lines = [
    `# Mod learning report: ${report.spec.name}`,
    "",
    `- Status: ${report.passed ? "PASS" : "FAIL"}`,
    `- Run directory: ${report.runDir}`,
    `- Candidate: ${report.candidatePath}`,
    `- Eval memory dir: ${report.evalMemoryDir}`,
    `- Generation exit: ${report.generationResult?.exitCode ?? "skipped"}`,
    `- Eval exit: ${report.evalResult?.exitCode ?? "not run"}`,
    `- Promoted to: ${report.promotedToPath ?? "not promoted"}`,
    "",
    "## Marker checks",
    ...renderMarkerSection(
      "Required result markers",
      report.evaluation.requiredResultMarkers,
    ),
    ...renderMarkerSection(
      "Required trace markers",
      report.evaluation.requiredTraceMarkers,
    ),
    ...renderMarkerSection(
      "Forbidden result markers",
      report.evaluation.forbiddenResultMarkers,
    ),
    ...renderMarkerSection(
      "Forbidden trace markers",
      report.evaluation.forbiddenTraceMarkers,
    ),
    "",
    "## Extracted result",
    "",
    "```text",
    report.evaluation.resultText || "(empty)",
    "```",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runModLearning(
  options: RunModLearningOptions,
): Promise<ModLearningReport> {
  const repoRoot = path.resolve(options.repoRoot);
  const runDir = path.resolve(
    repoRoot,
    options.runDir ??
      defaultModLearningRunDirectory(
        options.spec,
        options.outputBaseDir ?? path.join(".letta", "mod-learning-runs"),
      ),
  );
  const candidateDir = path.join(runDir, "mods");
  const candidateFileName = normalizeCandidateFileName(
    options.spec,
    options.candidateFileName,
  );
  const candidatePath = path.join(candidateDir, candidateFileName);
  const evalMemoryDir = path.join(runDir, "eval-memory");
  const runner = options.commandRunner ?? defaultCommandRunner;
  const cliCommand = options.cliCommand ?? "bun";
  const cliArgsPrefix = options.cliArgsPrefix ?? ["run", "dev"];
  const baseEnv = options.env ?? process.env;

  const emitProgress = (phase: ModLearningProgressPhase, message: string) => {
    options.onProgress?.({ candidatePath, message, phase, runDir });
  };

  emitProgress("preparing", "Preparing mod learning run");
  await mkdir(candidateDir, { recursive: true });
  await writeJsonArtifact(
    path.join(runDir, "spec.snapshot.json"),
    options.spec,
  );

  let generationResult: CommandRunResult | null = null;
  if (options.candidateSourcePath) {
    emitProgress("generating", "Copying candidate mod");
    await copyFile(
      path.resolve(repoRoot, options.candidateSourcePath),
      candidatePath,
    );
  } else if (!options.skipGeneration) {
    emitProgress("generating", "Generating candidate mod");
    const generationPrompt = buildModLearningPrompt(
      options.spec,
      candidatePath,
    );
    const generationArgs = [
      ...cliArgsPrefix,
      ...buildHeadlessArgs(generationPrompt, {
        backend: options.backend,
        maxTurns: 12,
        model: options.generationModel,
        noMods: true,
        outputFormat: "json",
      }),
    ];
    await writeFile(
      path.join(runDir, "generation-prompt.md"),
      generationPrompt,
      "utf8",
    );
    generationResult = await runner(cliCommand, generationArgs, {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        LETTA_DISABLE_MODS: "1",
        LETTA_DISABLE_EXTENSIONS: "1",
      },
      timeoutMs: 15 * 60 * 1000,
    });
    await writeCommandArtifacts(
      path.join(runDir, "generation"),
      cliCommand,
      generationArgs,
      generationResult,
    );
  }

  const candidateExists = await fileExists(candidatePath);
  await prepareMemoryFiles(evalMemoryDir, options.spec.evaluation.memoryFiles);

  let evalResult: CommandRunResult | null = null;
  let evaluation: ModLearningEvaluationResult = {
    forbiddenResultMarkers: [],
    forbiddenTraceMarkers: [],
    requiredResultMarkers: [],
    requiredTraceMarkers: [],
    resultText: "",
    passed: false,
  };

  if (candidateExists) {
    emitProgress("evaluating", "Evaluating candidate mod");
    const outputFormat = options.spec.evaluation.outputFormat ?? "stream-json";
    const evalPrompt = renderEvaluationPrompt(
      options.spec.evaluation.prompt,
      evalMemoryDir,
    );
    const evalArgs = [
      ...cliArgsPrefix,
      ...buildHeadlessArgs(evalPrompt, {
        backend: options.backend,
        maxTurns: options.spec.evaluation.maxTurns ?? 8,
        model: options.evalModel,
        outputFormat,
      }),
    ];
    await writeFile(path.join(runDir, "eval-prompt.md"), evalPrompt, "utf8");
    evalResult = await runner(cliCommand, evalArgs, {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        LETTA_MODS_DIR: candidateDir,
        LETTA_EXTENSIONS_DIR: candidateDir,
        MEMORY_DIR: evalMemoryDir,
      },
      timeoutMs: options.spec.evaluation.timeoutMs ?? 15 * 60 * 1000,
    });
    await writeCommandArtifacts(
      path.join(runDir, "eval"),
      cliCommand,
      evalArgs,
      evalResult,
    );
    evaluation = evaluateModLearningRun({
      exitCode: evalResult.exitCode,
      outputFormat,
      spec: options.spec.evaluation,
      stderr: evalResult.stderr,
      stdout: evalResult.stdout,
      timedOut: evalResult.timedOut,
    });
  }

  let promotedToPath: string | null = null;
  const passed = candidateExists && evaluation.passed;
  if (passed && options.promoteToPath) {
    emitProgress("promoting", "Promoting passing candidate mod");
    promotedToPath = path.resolve(repoRoot, options.promoteToPath);
    await mkdir(path.dirname(promotedToPath), { recursive: true });
    await copyFile(candidatePath, promotedToPath);
  }

  const reportPath = path.join(runDir, "report.md");
  emitProgress("writing-report", "Writing mod learning report");
  const report: ModLearningReport = {
    candidatePath,
    evalMemoryDir,
    evalResult,
    evaluation,
    generationResult,
    passed,
    promotedToPath,
    reportPath,
    runDir,
    spec: options.spec,
  };
  await writeJsonArtifact(path.join(runDir, "report.json"), report);
  await writeFile(reportPath, renderMarkdownReport(report), "utf8");
  emitProgress(
    "done",
    report.passed ? "mod learning passed" : "mod learning failed",
  );
  return report;
}

export async function readModLearningSpec(
  specPath: string,
): Promise<ModLearningSpec> {
  return JSON.parse(await readFile(specPath, "utf8")) as ModLearningSpec;
}
