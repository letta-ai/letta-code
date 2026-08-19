import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function git(memoryDir, args, options = {}) {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
}

function gitIdentityEnvironment() {
  const authorId = process.env.AGENT_ID?.trim() || "letta-agent";
  const authorName = process.env.AGENT_NAME?.trim() || authorId;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: `${authorId}@letta.com`,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: `${authorId}@letta.com`,
  };
}

export function resolveActivationInvocation(env = process.env) {
  const explicitCommand = env.LETTA_MEMFS_V2_ACTIVATE_COMMAND;
  const packagedEntrypoint = fileURLToPath(
    new URL("../../../letta.js", import.meta.url),
  );
  const usePackagedEntrypoint =
    !explicitCommand && !env.LETTA_CODE_BIN && existsSync(packagedEntrypoint);
  const command =
    explicitCommand ||
    env.LETTA_CODE_BIN ||
    (usePackagedEntrypoint ? process.execPath : undefined) ||
    (process.platform === "win32" ? "letta.cmd" : "letta");
  const rawArgs = explicitCommand
    ? env.LETTA_MEMFS_V2_ACTIVATE_ARGS
    : env.LETTA_CODE_BIN
      ? env.LETTA_CODE_BIN_ARGS_JSON
      : undefined;
  const commandArgs = rawArgs
    ? JSON.parse(rawArgs)
    : usePackagedEntrypoint
      ? [packagedEntrypoint]
      : [];
  if (
    !Array.isArray(commandArgs) ||
    commandArgs.some((arg) => typeof arg !== "string")
  ) {
    fail("Letta command arguments must be a JSON array of strings");
  }
  return { command, commandArgs };
}

function runAgentCommand(args) {
  const { command, commandArgs } = resolveActivationInvocation();
  const output = execFileSync(command, [...commandArgs, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  try {
    return JSON.parse(output);
  } catch {
    fail(`Activation command returned invalid JSON: ${output.trim()}`);
  }
}

export function normalizeBackend(backend) {
  if (backend === "local") return "local";
  if (backend === "cloud" || backend === "api") return "cloud";
  fail(`Unsupported target backend: ${backend}`);
}

export function preflightAgent(backend, agentId, memoryDir) {
  return runAgentCommand([
    "--backend",
    normalizeBackend(backend),
    "agents",
    "memfs-v2",
    "--agent",
    agentId,
    "--memory-dir",
    memoryDir,
    "--preflight",
  ]);
}

export function activateAgent(backend, agentId, memoryDir, memoryCommit) {
  return runAgentCommand([
    "--backend",
    normalizeBackend(backend),
    "agents",
    "memfs-v2",
    "--agent",
    agentId,
    "--memory-dir",
    memoryDir,
    "--memory-commit",
    memoryCommit,
  ]);
}

export async function agentHasMemfsV2Tag(memoryDir, agentId) {
  const storageDir = path.dirname(path.dirname(path.dirname(memoryDir)));
  const recordName = `${Buffer.from(agentId).toString("base64url")}.json`;
  try {
    const record = JSON.parse(
      await readFile(path.join(storageDir, "agents", recordName), "utf8"),
    );
    return Array.isArray(record.tags) && record.tags.includes("memfs-v2");
  } catch {
    return null;
  }
}

export function revertConversion(memoryDir, commit) {
  if (git(memoryDir, ["rev-parse", "HEAD"]).trim() !== commit) {
    fail(
      "Activation failed and memory HEAD moved; conversion was not reverted",
    );
  }
  git(memoryDir, ["revert", "--no-edit", commit], {
    env: gitIdentityEnvironment(),
  });
}
