import { type ChildProcess, spawn } from "node:child_process";
import { buildShellLaunchers } from "@/tools/impl/shell-launchers";
import { LIMITS, truncateByChars } from "@/tools/impl/truncation";
import {
  captureSecretRedactions,
  scrubAmbientSecrets,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import { executePromptHook } from "./prompt-executor";
import {
  type CommandHookConfig,
  type HookCommand,
  type HookExecutionResult,
  HookExitCode,
  type HookInput,
  type HookResult,
  isCommandHook,
  isPromptHook,
} from "./types";

const DEFAULT_TIMEOUT_MS = 60000;

export function truncateHookFeedback(
  text: string,
  workingDirectory: string,
): string {
  return truncateByChars(
    scrubAmbientSecrets(text),
    LIMITS.HOOK_OUTPUT_CHARS,
    "Hook",
    {
      workingDirectory,
      previewChars: LIMITS.OVERFLOW_PREVIEW_CHARS,
    },
  ).content;
}

function getHookIdentifier(hook: HookCommand): string {
  if (isCommandHook(hook)) {
    return hook.command;
  }
  if (isPromptHook(hook)) {
    return `prompt:${hook.prompt.slice(0, 50)}${hook.prompt.length > 50 ? "..." : ""}`;
  }
  return "unknown";
}

function trySpawnWithLauncher(
  launcher: string[],
  workingDirectory: string,
  input: HookInput,
): ChildProcess {
  const [executable, ...args] = launcher;
  if (!executable) {
    throw new Error("Empty launcher");
  }

  const agentId = "agent_id" in input ? input.agent_id : undefined;

  const {
    LETTA_AGENT_ID: _lettaAgentId,
    AGENT_ID: _agentId,
    LETTA_CONVERSATION_ID: _lettaConversationId,
    CONVERSATION_ID: _conversationId,
    LETTA_MEMORY_DIR: _lettaMemoryDir,
    MEMORY_DIR: _memoryDir,
    USER_CWD: _userCwd,
    LETTA_WORKING_DIR: _lettaWorkingDir,
    ...parentEnv
  } = process.env;

  return spawn(executable, args, {
    cwd: workingDirectory,
    env: {
      ...parentEnv,
      LETTA_HOOK_EVENT: input.event_type,
      LETTA_WORKING_DIR: workingDirectory,
      USER_CWD: workingDirectory,
      ...(agentId && {
        LETTA_AGENT_ID: agentId,
        AGENT_ID: agentId,
      }),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export async function executeHookCommand(
  hook: HookCommand,
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  if (isPromptHook(hook)) {
    return executePromptHook(hook, input, workingDirectory);
  }

  if (isCommandHook(hook)) {
    return executeCommandHook(hook, input, workingDirectory);
  }

  return {
    exitCode: HookExitCode.ERROR,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: 0,
    error: `Unknown hook type: ${(hook as HookCommand).type}`,
  };
}

export async function executeCommandHook(
  hook: CommandHookConfig,
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookResult> {
  const startTime = Date.now();
  const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;
  const inputJson = JSON.stringify(input);

  const launchers = buildShellLaunchers(hook.command, {
    preservePowerShellExitCode: true,
  });
  if (launchers.length === 0) {
    return {
      exitCode: HookExitCode.ERROR,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: Date.now() - startTime,
      error: "No shell launchers available for this platform",
    };
  }

  let lastError: Error | null = null;

  for (const launcher of launchers) {
    try {
      const result = await executeWithLauncher(
        launcher,
        inputJson,
        workingDirectory,
        input,
        timeout,
        hook.command,
        startTime,
        hook.quiet,
      );
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  return {
    exitCode: HookExitCode.ERROR,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: Date.now() - startTime,
    error: `Failed to execute hook: ${lastError?.message || "No suitable shell found"}`,
  };
}

function executeWithLauncher(
  launcher: string[],
  inputJson: string,
  workingDirectory: string,
  input: HookInput,
  timeout: number,
  command: string,
  startTime: number,
  quiet?: boolean,
): Promise<HookResult> {
  const redactions = captureSecretRedactions(
    "agent_id" in input ? input.agent_id : undefined,
  );
  return new Promise<HookResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    const safeResolve = (rawResult: HookResult) => {
      if (!resolved) {
        resolved = true;
        const result: HookResult = {
          ...rawResult,
          stdout: scrubSecretsFromString(rawResult.stdout, redactions),
          stderr: scrubSecretsFromString(rawResult.stderr, redactions),
          ...(rawResult.error && {
            error: scrubSecretsFromString(rawResult.error, redactions),
          }),
        };
        const exitCode =
          result.exitCode === HookExitCode.ALLOW
            ? 0
            : result.exitCode === HookExitCode.BLOCK
              ? 2
              : 1;
        const exitColor =
          result.exitCode === HookExitCode.ALLOW
            ? "\x1b[32m"
            : result.exitCode === HookExitCode.BLOCK
              ? "\x1b[31m"
              : "\x1b[33m";
        const exitLabel = result.timedOut
          ? `${exitColor}timeout\x1b[0m`
          : `${exitColor}exit ${exitCode}\x1b[0m`;
        if (!quiet) {
          console.log(`\x1b[90m[hook:${input.event_type}] ${command}\x1b[0m`);
          console.log(
            `\x1b[90m  \u23BF ${exitLabel} (${result.durationMs}ms)\x1b[0m`,
          );
          if (result.stdout) {
            console.log(`\x1b[90m  \u23BF (stdout)\x1b[0m`);
            const indented = result.stdout
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n");
            console.log(`\x1b[90m${indented}\x1b[0m`);
          }
          if (result.stderr) {
            console.log(`\x1b[90m  \u23BF (stderr)\x1b[0m`);
            const indented = result.stderr
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n");
            console.log(`\x1b[90m${indented}\x1b[0m`);
          }
        }
        resolve(result);
      }
    };

    let child: ChildProcess;
    try {
      child = trySpawnWithLauncher(launcher, workingDirectory, input);
    } catch (error) {
      reject(error);
      return;
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!resolved) {
          child.kill("SIGKILL");
        }
      }, 1000);
    }, timeout);

    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(inputJson);
      child.stdin.end();
    }

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    }

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      let exitCode: HookExitCode;
      if (timedOut) {
        exitCode = HookExitCode.ERROR;
      } else if (code === null) {
        exitCode = HookExitCode.ERROR;
      } else if (code === 0) {
        exitCode = HookExitCode.ALLOW;
      } else if (code === 2) {
        exitCode = HookExitCode.BLOCK;
      } else {
        exitCode = HookExitCode.ERROR;
      }

      safeResolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs,
        ...(timedOut && { error: `Hook timed out after ${timeout}ms` }),
      });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeoutId);

      if (error.code === "ENOENT") {
        reject(error);
        return;
      }

      const durationMs = Date.now() - startTime;
      safeResolve({
        exitCode: HookExitCode.ERROR,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut: false,
        durationMs,
        error: `Failed to execute hook: ${error.message}`,
      });
    });
  });
}

export async function executeHooks(
  hooks: HookCommand[],
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const results: HookResult[] = [];
  const feedback: string[] = [];
  let blocked = false;
  let errored = false;
  let updatedInput: Record<string, unknown> | undefined;

  for (const hook of hooks) {
    const result = await executeHookCommand(hook, input, workingDirectory);
    results.push(result);

    if (result.exitCode === HookExitCode.ALLOW) {
      if (result.stdout?.trim()) {
        if (input.event_type === "PreToolUse" && !updatedInput) {
          try {
            const json = JSON.parse(result.stdout.trim());
            const rewritten = json?.hookSpecificOutput?.updatedInput;
            if (
              rewritten &&
              typeof rewritten === "object" &&
              !Array.isArray(rewritten)
            ) {
              updatedInput = rewritten as Record<string, unknown>;
            }
          } catch {}
        }

        if (input.event_type === "UserPromptSubmit") {
          feedback.push(result.stdout.trim());
        }
      }
      continue;
    }

    if (result.exitCode === HookExitCode.BLOCK) {
      blocked = true;
      if (result.stderr) {
        feedback.push(`[${getHookIdentifier(hook)}]: ${result.stderr}`);
      }
      break;
    }

    if (result.exitCode === HookExitCode.ERROR) {
      errored = true;
      if (result.stderr) {
        feedback.push(`Hook error: ${result.stderr}`);
      } else if (result.error) {
        feedback.push(`Hook error: ${result.error}`);
      }
    }
  }

  return {
    blocked,
    errored,
    feedback:
      input.event_type === "SessionStart"
        ? feedback
        : feedback.map((text) => truncateHookFeedback(text, workingDirectory)),
    results,
    ...(updatedInput && { updatedInput }),
  };
}

export async function executeHooksParallel(
  hooks: HookCommand[],
  input: HookInput,
  workingDirectory: string = process.cwd(),
): Promise<HookExecutionResult> {
  const results = await Promise.all(
    hooks.map((hook) => executeHookCommand(hook, input, workingDirectory)),
  );

  const feedback: string[] = [];
  let blocked = false;
  let errored = false;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const hook = hooks[i];
    if (!result || !hook) continue;

    if (result.exitCode === HookExitCode.ALLOW && result.stdout?.trim()) {
      try {
        const json = JSON.parse(result.stdout.trim());
        const additionalContext =
          json?.hookSpecificOutput?.additionalContext ||
          json?.additionalContext;
        if (typeof additionalContext === "string" && additionalContext) {
          feedback.push(additionalContext);
        }
      } catch {}
    }

    if (result.exitCode === HookExitCode.BLOCK) {
      blocked = true;
      if (result.stderr) {
        feedback.push(`[${getHookIdentifier(hook)}]: ${result.stderr}`);
      }
    }
    if (result.exitCode === HookExitCode.ERROR) {
      errored = true;
      if (result.stderr) {
        feedback.push(`Hook error: ${result.stderr}`);
      } else if (result.error) {
        feedback.push(`Hook error: ${result.error}`);
      }
    }
  }

  return {
    blocked,
    errored,
    feedback: feedback.map((text) =>
      truncateHookFeedback(text, workingDirectory),
    ),
    results,
  };
}
