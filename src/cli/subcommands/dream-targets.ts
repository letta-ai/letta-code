import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  getScopedMemoryFilesystemRoot,
  MEMORY_SYSTEM_DIR,
} from "@/agent/memory-filesystem";
import {
  assertMemfsV2MemoryPathIndexed,
  type LocalMemoryFormat,
  rootMemoryPathFromLegacyLabel,
} from "@/agent/memory-format";
import { commitMemoryWrite } from "@/agent/memory-git";
import {
  defaultMemoryName,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
} from "@/agent/memory-markdown";
import { parseFrontmatter } from "@/utils/frontmatter";

/**
 * A `--to` render target. Memory is refined in a single reflection pass
 * (Approach A): the reflection agent maintains the target doc as a file in the
 * agent's in-context memory at `$MEMORY_DIR/system/<fileName>`, and we copy the
 * committed result out to `path` afterwards.
 *
 * Each run syncs the doc into the memfs from `path` when the memfs has no copy
 * or `path` has changed (another agent's merged edits, or a human edit), so the
 * agent starts from the current shared state — the repo is the source of truth
 * for a doc shared across agents (one agent per user+repo). Updates to the doc
 * are gated by the reflection cursor (no new experience → no change), so this
 * is churn-free. Choosing which on-disk revision is "current" (base branch vs
 * an open PR branch carrying this agent's unmerged output) and resolving
 * cross-agent PR conflicts is the caller's (automation's) responsibility.
 *
 * Note: because the doc lives in `system/`, it is compiled into the agent's
 * system prompt. That is acceptable for a dedicated dreaming agent with a small
 * doc; revisit if docs grow large/numerous.
 */
export interface DreamTarget {
  /** Absolute or relative filesystem path to write the rendered doc to. */
  path: string;
  /** The file name maintained inside `$MEMORY_DIR/system/`. */
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

/** The doc's path inside the memfs, relative to `$MEMORY_DIR`. */
function memfsRelPath(
  target: DreamTarget,
  memoryFormat: LocalMemoryFormat,
): string {
  if (memoryFormat === "memfs-v2") {
    // MEMORY.md is the root index in v2; reject it (case-insensitive) so a
    // target like `memory.md` cannot overwrite the root index on macOS.
    if (target.fileName.toLowerCase() === "memory.md") {
      throw new Error(
        `Invalid --to "${target.path}": MEMORY.md is reserved as the root index and cannot be a dream target`,
      );
    }
    return rootMemoryPathFromLegacyLabel(target.fileName);
  }
  return `${MEMORY_SYSTEM_DIR}/${target.fileName}`;
}

const MANAGED_DESCRIPTION: Record<DreamTarget["kind"], string> = {
  "agents-md":
    "Repository guidance for coding agents, maintained by letta dream.",
  generic: "Document distilled by letta dream.",
};

/**
 * Files under `system/` must carry YAML frontmatter (enforced by the memfs
 * pre-commit hook). The target doc is plain markdown, so we add a managed
 * frontmatter block when seeding (unless one with a description already
 * exists) and strip it when copying the doc back out to `--to`.
 */
export function addManagedFrontmatter(
  content: string,
  kind: DreamTarget["kind"],
  memoryFormat: LocalMemoryFormat = "memfs-v1",
  relativePath = "document.md",
): string {
  if (memoryFormat === "memfs-v2") {
    // If the content already carries v2 frontmatter, parse it with
    // parseMemoryMarkdown so quoted values like name: "AGENTS" are properly
    // unquoted before re-rendering (avoids double-escaping).  If the content
    // does not start with frontmatter, treat it as plain body content.
    if (/^---\r?\n/.test(content)) {
      const parsed = parseMemoryMarkdown({
        content,
        relativePath,
        format: memoryFormat,
        errorPrefix: "dream target",
      });
      return renderMemoryMarkdown({
        frontmatter: {
          name:
            typeof parsed.frontmatter.name === "string" &&
            parsed.frontmatter.name
              ? parsed.frontmatter.name
              : defaultMemoryName(relativePath),
          description: MANAGED_DESCRIPTION[kind],
        },
        body: parsed.body,
        relativePath,
        format: memoryFormat,
        errorPrefix: "dream target",
      });
    }
    // Plain body content without frontmatter — add managed frontmatter.
    const { body } = parseFrontmatter(content);
    return renderMemoryMarkdown({
      frontmatter: {
        name: defaultMemoryName(relativePath),
        description: MANAGED_DESCRIPTION[kind],
      },
      body,
      relativePath,
      format: memoryFormat,
      errorPrefix: "dream target",
    });
  }
  const { frontmatter, body } = parseFrontmatter(content);
  if (typeof frontmatter.description === "string" && frontmatter.description) {
    return content;
  }
  return `---\ndescription: ${MANAGED_DESCRIPTION[kind]}\n---\n${body}`;
}

export function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).body;
}

const AGENTS_MD_GUIDANCE = [
  "This file is an AGENTS.md — a README *for coding agents* (the agents.md",
  "open standard). Maintain it as durable, repo-level guidance an agent needs:",
  "build/test/setup COMMANDS (put these early), code-style conventions,",
  "testing instructions, security considerations, and commit/PR rules. Use",
  "plain Markdown with any headings. Do NOT duplicate human-README content",
  "(project pitch, quickstart, contribution guide). Prefer editing/merging",
  "existing sections over appending; remove guidance that new evidence",
  "contradicts. Keep it concise and scannable — favor short bullets over prose",
  "so a coding agent can skim it quickly. Write timelessly: describe how the",
  "repo works, not how it recently changed, and avoid time-relative wording",
  "(currently, for now, no longer) that goes stale.",
].join("\n");

const GENERIC_GUIDANCE = [
  "Maintain this markdown document as durable, forward-looking guidance",
  "distilled from the conversation(s). Prefer editing/merging existing",
  "sections over appending; remove content that new evidence contradicts.",
].join("\n");

/**
 * Build the instruction fragment that asks the reflection agent to maintain
 * the target doc at `$MEMORY_DIR/system/<fileName>`. When the on-disk target
 * exists it has already been synced there and the agent edits it in place;
 * when it does not, the agent creates it — but only if the new experience
 * actually yields durable guidance, so a no-signal run leaves the target
 * absent (no file → no diff → no PR downstream) rather than committing a
 * "nothing learned yet" placeholder.
 */
export function buildTargetInstruction(
  target: DreamTarget,
  memoryFormat: LocalMemoryFormat = "memfs-v1",
): string {
  const guidance =
    target.kind === "agents-md" ? AGENTS_MD_GUIDANCE : GENERIC_GUIDANCE;
  const relPath = memfsRelPath(target, memoryFormat);
  return [
    `In addition to updating memory, maintain the file at $MEMORY_DIR/${relPath}.`,
    guidance,
    "",
    `If $MEMORY_DIR/${relPath} already exists, revise it in place: apply only`,
    "the changes the new experience warrants, using your judgment. Often no",
    "change is needed — if so, leave it as-is. Keep the YAML frontmatter block",
    "(--- ... ---) at the top intact and edit only the body below it.",
    "",
    "If it does not exist, create it ONLY when the new experience yields",
    "durable, forward-looking guidance worth recording, and begin the file with",
    memoryFormat === "memfs-v2"
      ? "frontmatter containing exactly `name` and `description`."
      : "a YAML frontmatter block (a --- ... --- header with a short `description:`).",
    "If there is nothing substantive to record yet, do NOT create the file —",
    "leave it absent rather than writing a placeholder that says nothing was",
    "learned. The file should first appear on a run that produces real guidance.",
    "",
    "Commit when done.",
  ].join("\n");
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

/** The committed memfs content at `relPath` (via `git show HEAD:…`), or null. */
function readMemfsHead(memoryDir: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${relPath}`], {
      cwd: memoryDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Sync the on-disk target doc into the agent's memory at `system/<fileName>`:
 * write it when the memfs has no copy OR the on-disk copy differs from the
 * memfs copy (e.g. another agent's merged edits, or a human edit landed in the
 * repo). The repo is the source of truth for a doc shared across agents (one
 * agent per user+repo), so each run starts from the current shared state; the
 * agent's durable knowledge still lives in its memory blocks. Bodies are
 * compared (the memfs copy carries managed frontmatter the on-disk copy lacks).
 *
 * Must run before the reflection worktree is created, since the worktree is
 * checked out from HEAD. Selecting which on-disk revision counts as "current"
 * (base branch vs an open PR branch with this agent's unmerged output) is the
 * caller's responsibility.
 */
export async function syncTargetIntoMemory(
  agentId: string,
  target: DreamTarget,
  content: string | null,
  memoryFormat: LocalMemoryFormat = "memfs-v1",
): Promise<{ synced: boolean }> {
  if (content === null) {
    return { synced: false };
  }
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  const relPath = memfsRelPath(target, memoryFormat);

  // For v2, ensure the root MEMORY.md marker exists before writing.
  if (memoryFormat === "memfs-v2") {
    assertMemfsV2MemoryPathIndexed(memoryDir, relPath);
  }

  const committed = readMemfsHead(memoryDir, relPath);
  if (
    committed !== null &&
    stripFrontmatter(committed) === stripFrontmatter(content)
  ) {
    return { synced: false };
  }

  const absPath = join(memoryDir, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(
    absPath,
    addManagedFrontmatter(content, target.kind, memoryFormat, relPath),
    "utf-8",
  );
  try {
    const { getBackend } = await import("@/backend");
    const syncMode = getBackend().capabilities.localMemfs ? "local" : "remote";
    const result = await commitMemoryWrite({
      memoryDir,
      pathspecs: [relPath],
      reason: `dream: sync ${target.fileName} from target`,
      author: {
        agentId,
        authorName: agentId,
        authorEmail: `${agentId}@letta.com`,
      },
      syncMode,
    });
    return { synced: result.committed };
  } catch (error) {
    // Roll back the uncommitted file so the parent memfs stays clean — a dirty
    // parent would block the reflection worktree merge.
    await rm(absPath, { force: true });
    throw error;
  }
}

/**
 * Read the doc the reflection agent committed into the agent's memory, or null
 * if it wasn't written.
 */
export function readTargetFromMemory(
  agentId: string,
  target: DreamTarget,
  memoryFormat: LocalMemoryFormat = "memfs-v1",
): string | null {
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  const committed = readMemfsHead(
    memoryDir,
    memfsRelPath(target, memoryFormat),
  );
  if (committed === null) {
    return null;
  }
  // Strip the managed frontmatter so the exported doc is plain markdown.
  // parseFrontmatter trims the body; restore a trailing newline.
  const body = stripFrontmatter(committed);
  return body.length > 0 ? `${body}\n` : body;
}

/** Write the rendered doc to the target path, creating parent dirs. */
export async function writeTarget(
  target: DreamTarget,
  content: string,
): Promise<void> {
  await mkdir(dirname(target.path), { recursive: true });
  await writeFile(target.path, content, "utf-8");
}
