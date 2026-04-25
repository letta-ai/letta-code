import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  getMemoryGitStatus,
  getMemoryRepoDir,
  isGitRepo,
  pullMemory,
} from "../../agent/memoryGit";
import { runMemoryTokensAction } from "./memoryTokens";

function printUsage(): void {
  console.log(
    `
Usage:
  letta memory status [--agent <id>]
  letta memory diff [--agent <id>]
  letta memory backup [--agent <id>]
  letta memory backups [--agent <id>]
  letta memory restore --from <backup> --force [--agent <id>]
  letta memory export --agent <id> --out <dir>
  letta memory pull [--agent <id>]
  letta memory tokens [--memory-dir <path>] [--agent <id>] [--top <N>]
                     [--format text|json] [--quiet]

Notes:
  - Most actions require agent id via --agent or LETTA_AGENT_ID and output JSON.
  - \`tokens\` additionally accepts --memory-dir or $MEMORY_DIR; reports the
    estimated token size of system/. Policy (whether a size is concerning) is
    up to the caller.
  - Memory is git-backed. Use git commands for commit/push.

Examples:
  LETTA_AGENT_ID=agent-123 letta memory status
  letta memory pull --agent agent-123
  letta memory backup --agent agent-123
  letta memory export --agent agent-123 --out /tmp/letta-memory-agent-123
  letta memory tokens
  letta memory tokens --memory-dir ~/.letta/agents/agent-123/memory --format json
`.trim(),
  );
}

function getAgentId(agentFromArgs?: string, agentIdFromArgs?: string): string {
  return agentFromArgs || agentIdFromArgs || process.env.LETTA_AGENT_ID || "";
}

const MEMORY_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  from: { type: "string" },
  force: { type: "boolean" },
  out: { type: "string" },
  "memory-dir": { type: "string" },
  top: { type: "string" },
  format: { type: "string" },
  quiet: { type: "boolean" },
} as const;

function parseMemoryArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: MEMORY_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getMemoryRoot(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId, "memory");
}

function getAgentRoot(agentId: string): string {
  return join(homedir(), ".letta", "agents", agentId);
}

function formatBackupTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

async function listBackups(
  agentId: string,
): Promise<Array<{ name: string; path: string; createdAt: string | null }>> {
  const agentRoot = getAgentRoot(agentId);
  if (!existsSync(agentRoot)) {
    return [];
  }
  const entries = await readdir(agentRoot, { withFileTypes: true });
  const backups: Array<{
    name: string;
    path: string;
    createdAt: string | null;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("memory-backup-")) continue;
    const path = join(agentRoot, entry.name);
    let createdAt: string | null = null;
    try {
      const stat = statSync(path);
      createdAt = stat.mtime.toISOString();
    } catch {
      createdAt = null;
    }
    backups.push({ name: entry.name, path, createdAt });
  }
  backups.sort((a, b) => a.name.localeCompare(b.name));
  return backups;
}

function resolveBackupPath(agentId: string, from: string): string {
  if (from.startsWith("/") || /^[A-Za-z]:[/\\]/.test(from)) {
    return from;
  }
  return join(getAgentRoot(agentId), from);
}

export async function runMemorySubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseMemoryArgs>;
  try {
    parsed = parseMemoryArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;

  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  const agentId = getAgentId(parsed.values.agent, parsed.values["agent-id"]);

  // `tokens` has its own input resolution (--memory-dir / $MEMORY_DIR first,
  // then falls back to agent id). Short-circuit before the agent-id hard check.
  if (action === "tokens") {
    return runMemoryTokensAction({
      memoryDir: parsed.values["memory-dir"],
      agentMemoryDir: agentId ? getMemoryRoot(agentId) : undefined,
      top: parsed.values.top,
      format: parsed.values.format,
      quiet: Boolean(parsed.values.quiet),
    });
  }

  if (!agentId) {
    console.error(
      "Missing agent id. Set LETTA_AGENT_ID or pass --agent/--agent-id.",
    );
    return 1;
  }

  try {
    if (action === "status") {
      if (!isGitRepo(agentId)) {
        console.log(
          JSON.stringify({ error: "Not a git repo", gitEnabled: false }),
        );
        return 1;
      }
      const status = await getMemoryGitStatus(agentId);
      console.log(JSON.stringify(status, null, 2));
      return status.dirty || status.aheadOfRemote ? 2 : 0;
    }

    if (action === "diff") {
      if (!isGitRepo(agentId)) {
        console.error("Not a git repo. Enable git-backed memory first.");
        return 1;
      }
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFile = promisify(execFileCb);
      const dir = getMemoryRepoDir(agentId);
      const { stdout } = await execFile("git", ["diff"], { cwd: dir });
      if (stdout.trim()) {
        console.log(stdout);
        return 2;
      }
      console.log("No changes.");
      return 0;
    }

    if (action === "pull") {
      if (!isGitRepo(agentId)) {
        console.error("Not a git repo. Enable git-backed memory first.");
        return 1;
      }
      const result = await pullMemory(agentId);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (action === "backup") {
      const root = getMemoryRoot(agentId);
      if (!existsSync(root)) {
        console.error(`Memory directory not found for agent ${agentId}.`);
        return 1;
      }
      const agentRoot = getAgentRoot(agentId);
      const backupName = `memory-backup-${formatBackupTimestamp()}`;
      const backupPath = join(agentRoot, backupName);
      if (existsSync(backupPath)) {
        console.error(`Backup already exists at ${backupPath}`);
        return 1;
      }
      cpSync(root, backupPath, { recursive: true });
      console.log(JSON.stringify({ backupName, backupPath }, null, 2));
      return 0;
    }

    if (action === "backups") {
      const backups = await listBackups(agentId);
      console.log(JSON.stringify({ backups }, null, 2));
      return 0;
    }

    if (action === "restore") {
      const from = parsed.values.from;
      if (!from) {
        console.error("Missing --from <backup>.");
        return 1;
      }
      if (!parsed.values.force) {
        console.error("Restore is destructive. Re-run with --force.");
        return 1;
      }
      const backupPath = resolveBackupPath(agentId, from);
      if (!existsSync(backupPath)) {
        console.error(`Backup not found: ${backupPath}`);
        return 1;
      }
      const stat = statSync(backupPath);
      if (!stat.isDirectory()) {
        console.error(`Backup path is not a directory: ${backupPath}`);
        return 1;
      }
      const root = getMemoryRoot(agentId);
      rmSync(root, { recursive: true, force: true });
      cpSync(backupPath, root, { recursive: true });
      console.log(JSON.stringify({ restoredFrom: backupPath }, null, 2));
      return 0;
    }

    if (action === "export") {
      const out = parsed.values.out;
      if (!out) {
        console.error("Missing --out <dir>.");
        return 1;
      }
      const root = getMemoryRoot(agentId);
      if (!existsSync(root)) {
        console.error(`Memory directory not found for agent ${agentId}.`);
        return 1;
      }
      if (existsSync(out)) {
        const stat = statSync(out);
        if (stat.isDirectory()) {
          const contents = await readdir(out);
          if (contents.length > 0) {
            console.error(`Export directory not empty: ${out}`);
            return 1;
          }
        } else {
          console.error(`Export path is not a directory: ${out}`);
          return 1;
        }
      } else {
        mkdirSync(out, { recursive: true });
      }
      cpSync(root, out, { recursive: true });
      console.log(
        JSON.stringify(
          { exportedFrom: root, exportedTo: out, agentId },
          null,
          2,
        ),
      );
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  console.error(`Unknown action: ${action}`);
  printUsage();
  return 1;
}
