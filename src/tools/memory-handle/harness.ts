/**
 * The script `harness` binding: a typed, read-only view of an agent's
 * memory-backed harness state at one revision, plus `edit()`, which writes
 * typed changes to that memory as one commit on a branch.
 *
 * Layout (MemFS v2), classified like the system-prompt compiler:
 * - `index`: root `MEMORY.md`, rendered under `<memory>`; not core memory.
 * - `core`: other root `*.md` files, each rendered as a core memory block.
 * - `memory`: deferred memory, every other `*.md` outside `skills/`.
 * - `skills`: `skills/<name>/SKILL.md` plus that folder's files.
 *
 * The underlying Git handle stays available as `repo` for branches, diffs,
 * history, and writes this view does not model.
 */

import { isCoreMemoryPath } from "@/agent/memory-format";
import { validateMemoryFileFrontmatter } from "@/memory-frontmatter";
import { parseFrontmatter } from "@/utils/frontmatter";
import type { openMemoryHandle } from "./memory-handle";
import { normalizeMemoryPath } from "./types";

type MemoryHandle = Awaited<ReturnType<typeof openMemoryHandle>>;

const INDEX_PATH = "MEMORY.md";
const SKILLS_PREFIX = "skills/";
const SKILL_FILE = "SKILL.md";
const CORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface HarnessCoreBlock {
  name: string;
  description: string;
  body: string;
  path: string;
}

export interface HarnessMemoryFile {
  path: string;
  /** Empty for directory indexes (`<dir>/MEMORY.md`), which have no frontmatter. */
  name: string;
  description: string;
  body: string;
}

export interface HarnessSkill {
  name: string;
  description: string;
  body: string;
  path: string;
  /** Every file in the skill folder, relative to the repository root. */
  files: string[];
}

function parseMarkdown(path: string, raw: string) {
  const { frontmatter, body } = parseFrontmatter(raw);
  const field = (key: string) =>
    typeof frontmatter[key] === "string"
      ? (frontmatter[key] as string).trim()
      : "";
  return {
    name: field("name") || path.split("/").at(-1)?.replace(/\.md$/, "") || "",
    description: field("description"),
    body,
  };
}

function scalar(value: unknown, key: string, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line.`);
  return value.trim();
}

function bodyOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("body must be a string.");
  return value.endsWith("\n") || value === "" ? value : `${value}\n`;
}

function entry(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} takes { description, body }.`);
  }
  return value as Record<string, unknown>;
}

/** Serialize and validate with the same checks the pre-commit hook runs. */
function memoryFile(
  path: string,
  name: string,
  description: string,
  body: string,
): string {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
  const errors = validateMemoryFileFrontmatter({
    path,
    content,
    previousContent: null,
    format: "memfs-v2",
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
  return content;
}

function isDeferredMemoryPath(path: string): boolean {
  return (
    path.endsWith(".md") &&
    path.includes("/") &&
    !path.startsWith(SKILLS_PREFIX)
  );
}

function defaultEditBranch(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `harness/edit-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadHarnessSnapshot(repo: MemoryHandle, ref?: string) {
  const sourceRef = ref ?? repo.defaultBranch;
  const [head] = await repo.log({ ref: sourceRef, limit: 1 });
  if (!head) throw new Error(`Unknown ref: ${sourceRef}`);
  const revision = head.sha;
  const paths = await repo.list({ ref: revision });
  if (!paths.includes(INDEX_PATH)) {
    throw new Error(
      "harness requires the MemFS v2 layout (a root MEMORY.md); use memory.open() for this repository.",
    );
  }
  const read = async (path: string) =>
    (await repo.read(path, { ref: revision })) ?? "";

  const corePaths = paths.filter(
    (path) => path !== INDEX_PATH && isCoreMemoryPath(path, "memfs-v2"),
  );
  const skillNames = paths
    .filter((path) => {
      const parts = path.split("/");
      return (
        parts.length === 3 && parts[0] === "skills" && parts[2] === SKILL_FILE
      );
    })
    .map((path) => path.split("/")[1] as string);
  const [index, coreFiles, skillFiles] = await Promise.all([
    read(INDEX_PATH),
    Promise.all(corePaths.map(async (path) => [path, await read(path)])),
    Promise.all(
      skillNames.map(async (name) => {
        const path = `${SKILLS_PREFIX}${name}/${SKILL_FILE}`;
        return [name, path, await read(path)];
      }),
    ),
  ]);

  const core: Record<string, HarnessCoreBlock> = {};
  for (const [path, raw] of coreFiles as [string, string][]) {
    const name = path.replace(/\.md$/, "");
    const parsed = parseMarkdown(path, raw);
    core[name] = {
      name,
      description: parsed.description,
      body: parsed.body,
      path,
    };
  }
  const skills: Record<string, HarnessSkill> = {};
  for (const [name, path, raw] of skillFiles as [string, string, string][]) {
    const parsed = parseMarkdown(path, raw);
    const folder = `${SKILLS_PREFIX}${name}/`;
    skills[name] = {
      name,
      description: parsed.description,
      body: parsed.body,
      path,
      files: paths.filter((candidate) => candidate.startsWith(folder)),
    };
  }
  const memoryPaths = paths.filter(isDeferredMemoryPath);
  const memory = Object.freeze({
    /** Deferred memory paths, optionally under one directory. */
    list(directory?: unknown): string[] {
      if (directory === undefined) return [...memoryPaths];
      const prefix = `${normalizeMemoryPath(directory).replace(/\/+$/, "")}/`;
      return memoryPaths.filter((path) => path.startsWith(prefix));
    },
    async get(path: unknown): Promise<HarnessMemoryFile | null> {
      const normalized = normalizeMemoryPath(path);
      if (!memoryPaths.includes(normalized)) return null;
      const raw = await read(normalized);
      if (normalized.endsWith(`/${INDEX_PATH}`)) {
        return { path: normalized, name: "", description: "", body: raw };
      }
      return { path: normalized, ...parseMarkdown(normalized, raw) };
    },
  });

  function edit(options?: unknown) {
    const parsed =
      options === undefined ? {} : entry(options, "edit() options");
    const message = scalar(parsed.message ?? "harness edit", "message");
    const branch =
      parsed.branch === undefined
        ? defaultEditBranch()
        : scalar(parsed.branch, "branch");
    if (branch === repo.defaultBranch) {
      throw new Error(
        `edit() writes to a branch, not ${repo.defaultBranch}; use repo.commit() to write ${repo.defaultBranch} directly.`,
      );
    }
    const commit = repo.commit({ message, branch, base: revision });
    // The final tree, for checks that span several staged changes.
    const tree = new Set(paths);
    const stage = (path: string, content?: string) => {
      if (content === undefined) {
        tree.delete(path);
        commit.delete(path);
      } else {
        tree.add(path);
        commit.put(path, content);
      }
    };
    let sent = false;
    const live = () => {
      if (sent) throw new Error("This edit was already sent.");
    };
    const editor = {
      branch,
      index: Object.freeze({
        set(text: unknown) {
          live();
          if (typeof text !== "string") {
            throw new Error("index.set() takes a string.");
          }
          if (text.startsWith("---")) {
            throw new Error("MEMORY.md must not have frontmatter.");
          }
          stage(INDEX_PATH, text);
          return editor;
        },
      }),
      core: Object.freeze({
        put(name: unknown, value: unknown) {
          live();
          const blockName = scalar(name, "core name");
          if (!CORE_NAME.test(blockName) || blockName === "MEMORY") {
            throw new Error(
              `Invalid core name: ${blockName}. Use letters, digits, '.', '_' or '-'; MEMORY is the index.`,
            );
          }
          const fields = entry(value, "core.put()");
          const path = `${blockName}.md`;
          stage(
            path,
            memoryFile(
              path,
              blockName,
              scalar(fields.description, "description"),
              bodyOf(fields.body),
            ),
          );
          return editor;
        },
        delete(name: unknown) {
          live();
          const blockName = scalar(name, "core name");
          if (!core[blockName]) throw new Error(`No core block ${blockName}.`);
          stage(`${blockName}.md`);
          return editor;
        },
      }),
      memory: Object.freeze({
        put(path: unknown, value: unknown) {
          live();
          const normalized = normalizeMemoryPath(path);
          if (!isDeferredMemoryPath(normalized)) {
            throw new Error(
              `memory.put() takes a .md path inside a directory, outside skills/ (got ${normalized}); use core or index for root files.`,
            );
          }
          if (normalized.endsWith(`/${INDEX_PATH}`)) {
            const text =
              typeof value === "string"
                ? value
                : bodyOf(entry(value, "memory.put()").body);
            if (text.startsWith("---")) {
              throw new Error("MEMORY.md must not have frontmatter.");
            }
            stage(normalized, text);
            return editor;
          }
          const fields = entry(value, "memory.put()");
          const name =
            fields.name === undefined
              ? (normalized.split("/").at(-1) as string).replace(/\.md$/, "")
              : scalar(fields.name, "name");
          stage(
            normalized,
            memoryFile(
              normalized,
              name,
              scalar(fields.description, "description"),
              bodyOf(fields.body),
            ),
          );
          return editor;
        },
        delete(path: unknown) {
          live();
          const normalized = normalizeMemoryPath(path);
          if (!memoryPaths.includes(normalized)) {
            throw new Error(`No deferred memory file ${normalized}.`);
          }
          stage(normalized);
          return editor;
        },
      }),
      skills: Object.freeze({
        put(name: unknown, value: unknown) {
          live();
          const skillName = scalar(name, "skill name");
          if (!SKILL_NAME.test(skillName)) {
            throw new Error(
              `Invalid skill name: ${skillName}. Use lowercase letters, digits and '-'.`,
            );
          }
          const fields = entry(value, "skills.put()");
          const description = scalar(fields.description, "description");
          const folder = `${SKILLS_PREFIX}${skillName}/`;
          stage(
            `${folder}${SKILL_FILE}`,
            `---\nname: ${skillName}\ndescription: ${description}\n---\n${bodyOf(fields.body)}`,
          );
          if (fields.files !== undefined) {
            const files = entry(fields.files, "skills.put() files");
            for (const [relative, content] of Object.entries(files)) {
              const path = normalizeMemoryPath(`${folder}${relative}`);
              if (
                !path.startsWith(folder) ||
                path === `${folder}${SKILL_FILE}`
              ) {
                throw new Error(`Invalid skill file path: ${relative}`);
              }
              if (typeof content !== "string") {
                throw new Error(`Skill file ${relative} must be a string.`);
              }
              stage(path, content);
            }
          }
          return editor;
        },
        delete(name: unknown) {
          live();
          const skillName = scalar(name, "skill name");
          const skill = skills[skillName];
          if (!skill) throw new Error(`No skill ${skillName}.`);
          for (const path of skill.files) stage(path);
          return editor;
        },
      }),
      async send() {
        live();
        // Deferred files are projected only under indexed directories; the
        // pre-commit hook enforces this, so report it before Git does.
        const missing = new Set<string>();
        for (const path of tree) {
          if (!isDeferredMemoryPath(path)) continue;
          const parts = path.split("/").slice(0, -1);
          for (let depth = 1; depth <= parts.length; depth++) {
            const index = `${parts.slice(0, depth).join("/")}/${INDEX_PATH}`;
            if (!tree.has(index)) missing.add(index);
          }
        }
        if (missing.size > 0) {
          throw new Error(
            `Deferred memory needs a directory index; add ${[...missing].sort().join(", ")} with memory.put().`,
          );
        }
        sent = true;
        const result = await commit.send();
        return {
          sha: result.sha,
          branch: result.branch,
          base: revision,
          changed: result.changed,
        };
      },
    };
    return editor;
  }

  return Object.freeze({
    ref: sourceRef,
    revision,
    index,
    core: Object.freeze(core),
    memory,
    skills: Object.freeze(skills),
    edit,
    repo,
  });
}
