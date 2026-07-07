import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";

/**
 * A `--to` render target. In this pass, memory is refined in a single
 * reflection pass (Approach A): the reflection agent maintains the target doc
 * as an external memory file at `$MEMORY_DIR/<fileName>`, and we copy the
 * committed result out to `path` afterwards.
 *
 * Note: because the doc lives in the memfs, it is also compiled into the
 * agent's system prompt. That is acceptable for a dedicated dreaming agent
 * with a small doc; revisit (carve-out, or a separate projection pass) if
 * maintenance gets tedious or docs grow large/numerous.
 *
 * The memfs is the source of truth for the doc: the agent builds on its own
 * committed copy and we overwrite `path` with the result. This is cycle-free
 * (updates are gated by the reflection cursor — no new experience, no change)
 * but does NOT merge out-of-band edits made to `path` between runs. The dream
 * owns the generated doc; reconciling human edits or unmerged-PR drift is the
 * caller's responsibility (e.g. handled on the automation side), not here.
 */
export interface DreamTarget {
  /** Absolute or relative filesystem path to write the rendered doc to. */
  path: string;
  /** The file name the agent maintains inside `$MEMORY_DIR`. */
  fileName: string;
  kind: "agents-md" | "generic";
}

export function resolveDreamTarget(spec: string): DreamTarget {
  const fileName = basename(spec);
  if (!fileName) {
    throw new Error(`Invalid --to "${spec}": expected a file path`);
  }
  const lower = fileName.toLowerCase();
  const kind =
    lower === "agents.md" || lower === "agent.md" ? "agents-md" : "generic";
  return { path: spec, fileName, kind };
}

const AGENTS_MD_GUIDANCE = [
  "This file is an AGENTS.md — a README *for coding agents* (the agents.md",
  "open standard). Maintain it as durable, repo-level guidance an agent needs:",
  "build/test/setup COMMANDS (put these early), code-style conventions,",
  "testing instructions, security considerations, and commit/PR rules. Use",
  "plain Markdown with any headings. Do NOT duplicate human-README content",
  "(project pitch, quickstart, contribution guide). Prefer editing/merging",
  "existing sections over appending; remove guidance that new evidence",
  "contradicts.",
].join("\n");

const GENERIC_GUIDANCE = [
  "Maintain this markdown document as durable, forward-looking guidance",
  "distilled from the conversation(s). Prefer editing/merging existing",
  "sections over appending; remove content that new evidence contradicts.",
].join("\n");

/**
 * Build the instruction fragment that asks the reflection agent to maintain
 * the target doc as an external memory file, seeded with the current on-disk
 * content so human edits to the repo copy are respected.
 */
export function buildTargetInstruction(
  target: DreamTarget,
  existingContent: string | null,
): string {
  const guidance =
    target.kind === "agents-md" ? AGENTS_MD_GUIDANCE : GENERIC_GUIDANCE;
  const lines = [
    `In addition to updating memory, maintain an external memory file named "${target.fileName}" at $MEMORY_DIR/${target.fileName}.`,
    guidance,
    "",
    "The authoritative current content of this file is below. Treat it as the",
    "base to revise: apply only the changes the new experience warrants, using",
    "your judgment. Often no change is needed — if so, leave it as-is. Write the",
    `final version to $MEMORY_DIR/${target.fileName} (overwriting), then commit.`,
    "",
    `--- current ${target.fileName} (${existingContent === null ? "does not exist yet — create it" : "edit in place"}) ---`,
    existingContent ?? "(none)",
    `--- end ${target.fileName} ---`,
  ];
  return lines.join("\n");
}

/** Read the current on-disk target doc, or null if it doesn't exist. */
export async function readExistingTarget(
  target: DreamTarget,
): Promise<string | null> {
  try {
    return await readFile(target.path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read the doc the reflection agent committed into the agent's memory, or null
 * if it wasn't written.
 */
export function readTargetFromMemory(
  agentId: string,
  target: DreamTarget,
): string | null {
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  try {
    return execFileSync("git", ["show", `HEAD:${target.fileName}`], {
      cwd: memoryDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Write the rendered doc to the target path, creating parent dirs. */
export async function writeTarget(
  target: DreamTarget,
  content: string,
): Promise<void> {
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, content, "utf-8");
}
