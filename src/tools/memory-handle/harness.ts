/**
 * The script `harness` binding: typed views of an agent's memory-backed
 * harness at one revision, plus `edit()`, which stages typed changes and
 * commits them together to a branch.
 *
 * Three namespaces, classified like the MemFS v2 system-prompt compiler:
 * - `prompts`: root `<name>.md` files (except `MEMORY.md`), compiled into the
 *   system prompt every turn. Flat; no children.
 * - `memory`: a tree loaded on demand. A directory is a document (its
 *   `MEMORY.md`) with child files and directories; the root `MEMORY.md` is
 *   the root directory's document. The agent writes those documents itself;
 *   the harness only reports links that drift from the tree.
 * - `skills`: `skills/<name>/SKILL.md` plus attached files.
 *
 * Every namespace has the same four verbs: `get`, `put` (replace the node's
 * own document, never its children), `update(path, fn)`, and `delete`.
 */

import { posix } from "node:path";
import * as Diff from "diff";
import { isCoreMemoryPath } from "@/agent/memory-format";
import { validateMemoryFileFrontmatter } from "@/memory-frontmatter";
import { parseFrontmatter } from "@/utils/frontmatter";
import type { openMemoryHandle } from "./memory-handle";
import { merge3 } from "./merge3";
import { normalizeMemoryPath } from "./types";

export { swap } from "./swap";

type MemoryHandle = Awaited<ReturnType<typeof openMemoryHandle>>;

const DOC = "MEMORY.md";
const SKILLS = "skills";
const SKILL_FILE = "SKILL.md";
const PROMPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface HarnessFile {
  path: string;
  name: string;
  description: string;
  body: string;
}

export interface HarnessDirectory {
  path: string;
  /** The directory's `MEMORY.md`. */
  body: string;
  files: { path: string; name: string; description: string }[];
  directories: { path: string }[];
}

export interface HarnessSkill extends HarnessFile {
  /** Attached files, relative to the skill folder (without `SKILL.md`). */
  files: string[];
}

export interface HarnessLinkReport {
  path: string;
  /** Children the directory document does not link to. */
  unlinked: string[];
  /** Link targets that do not exist. */
  dangling: string[];
}

export interface HarnessChange {
  path: string;
  op: "add" | "modify" | "delete";
  before?: string;
  after?: string;
}

/** Repository path → content (`undefined` for files the harness does not read). */
type Tree = Map<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be an object.`);
  return value;
}

function scalar(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line.`);
  return value.trim();
}

function bodyOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("body must be a string.");
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

function parseMarkdown(path: string, raw: string) {
  const { frontmatter, body } = parseFrontmatter(raw);
  const field = (key: string) =>
    typeof frontmatter[key] === "string"
      ? (frontmatter[key] as string).trim()
      : "";
  return {
    name: field("name") || (posix.basename(path).replace(/\.md$/, "") ?? ""),
    description: field("description"),
    body,
  };
}

/** Serialize a frontmatter file with the checks the pre-commit hook runs. */
function markdownFile(path: string, value: unknown, defaultName: string) {
  const fields = record(value, `put(${JSON.stringify(path)}) value`);
  const name =
    fields.name === undefined ? defaultName : scalar(fields.name, "name");
  const description = scalar(fields.description, "description");
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n${bodyOf(fields.body)}`;
  const errors = validateMemoryFileFrontmatter({
    path,
    content,
    previousContent: null,
    format: "memfs-v2",
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
  return content;
}

function directoryDocument(value: unknown): string {
  const fields = record(value, "directory value");
  if (fields.description !== undefined) {
    throw new Error(
      "Directories have no description; describe them in the parent directory's body.",
    );
  }
  const body = bodyOf(fields.body);
  if (body.startsWith("---")) {
    throw new Error("A directory body (MEMORY.md) must not have frontmatter.");
  }
  return body;
}

/** Memory node path: '' for the root, otherwise a path without `.md`. */
function memoryPath(path: unknown): string {
  if (path === "") return "";
  const normalized = normalizeMemoryPath(path).replace(/\/+$/, "");
  if (normalized.endsWith(".md")) {
    throw new Error(
      `Memory paths have no .md extension: use ${JSON.stringify(normalized.slice(0, -3))}.`,
    );
  }
  const parts = normalized.split("/");
  if (parts.includes("MEMORY")) {
    throw new Error(
      "MEMORY.md is a directory's body: get or put the directory path instead.",
    );
  }
  if (parts[0] === SKILLS) {
    throw new Error("skills/ is not memory; use harness skills.");
  }
  return normalized;
}

function promptName(name: unknown): string {
  const value = scalar(name, "prompt name");
  if (!PROMPT_NAME.test(value) || value === "MEMORY" || value === SKILLS) {
    throw new Error(
      `Invalid prompt name: ${value}. Use letters, digits, '.', '_' or '-'; MEMORY and skills are reserved.`,
    );
  }
  return value;
}

/** Skill path: `name` for the skill, `name/<file>` for an attachment. */
function skillPath(path: unknown): { name: string; file?: string } {
  const normalized = normalizeMemoryPath(path).replace(/\/+$/, "");
  const [name, ...rest] = normalized.split("/");
  if (!name || !SKILL_NAME.test(name)) {
    throw new Error(
      `Invalid skill name: ${name}. Use lowercase letters, digits and '-'.`,
    );
  }
  if (rest.length === 0) return { name };
  const file = rest.join("/");
  if (file === SKILL_FILE) {
    throw new Error(`Use the skill path ${JSON.stringify(name)} for SKILL.md.`);
  }
  return { name, file };
}

function children(tree: Tree, prefix: string): string[] {
  return [...tree.keys()].filter((path) => path.startsWith(prefix));
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Read-only namespaces over one tree (a snapshot or an edit's staged tree). */
function createViews(tree: Tree) {
  const text = (path: string) => tree.get(path) ?? "";
  const isDirectory = (path: string) =>
    path === "" || tree.has(`${path}/${DOC}`);

  function file(path: string, filePath: string): HarnessFile {
    return Object.freeze({ path, ...parseMarkdown(filePath, text(filePath)) });
  }

  function directory(path: string): HarnessDirectory {
    const prefix = path ? `${path}/` : "";
    const files: HarnessDirectory["files"] = [];
    const directories = new Set<string>();
    for (const key of tree.keys()) {
      if (!key.startsWith(prefix)) continue;
      const [head, ...rest] = key.slice(prefix.length).split("/");
      if (!head) continue;
      if (rest.length === 0) {
        // Root .md files are prompts, not memory files.
        if (path && head.endsWith(".md") && head !== DOC) {
          const {
            path: child,
            name,
            description,
          } = file(`${prefix}${head.slice(0, -3)}`, key);
          files.push(Object.freeze({ path: child, name, description }));
        }
      } else if (!(path === "" && head === SKILLS)) {
        if (isDirectory(`${prefix}${head}`))
          directories.add(`${prefix}${head}`);
      }
    }
    return Object.freeze({
      path,
      body: text(path ? `${path}/${DOC}` : DOC),
      files: Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path))),
      directories: Object.freeze(
        [...directories].sort().map((child) => Object.freeze({ path: child })),
      ),
    }) as HarnessDirectory;
  }

  function memoryNode(path: string): HarnessDirectory | HarnessFile | null {
    if (isDirectory(path)) return directory(path);
    if (path.includes("/") && tree.has(`${path}.md`)) {
      return file(path, `${path}.md`);
    }
    return null;
  }

  function skill(name: string): HarnessSkill | null {
    const folder = `${SKILLS}/${name}/`;
    if (!tree.has(`${folder}${SKILL_FILE}`)) return null;
    return Object.freeze({
      ...file(name, `${folder}${SKILL_FILE}`),
      files: Object.freeze(
        children(tree, folder)
          .map((path) => path.slice(folder.length))
          .filter((path) => path !== SKILL_FILE)
          .sort(),
      ),
    }) as HarnessSkill;
  }

  const promptPaths = () =>
    [...tree.keys()].filter(
      (path) => path !== DOC && isCoreMemoryPath(path, "memfs-v2"),
    );

  return {
    isDirectory,
    memoryNode,
    skill,
    prompts: Object.freeze({
      /** A prompt by name, or `{ files }` listing every prompt. */
      get(name?: unknown) {
        if (name === undefined) {
          return Object.freeze({
            files: Object.freeze(
              promptPaths()
                .sort()
                .map((path) => {
                  const {
                    path: child,
                    name,
                    description,
                  } = file(path.slice(0, -3), path);
                  return Object.freeze({ path: child, name, description });
                }),
            ),
          });
        }
        const value = promptName(name);
        return tree.has(`${value}.md`) ? file(value, `${value}.md`) : null;
      },
    }),
    memory: Object.freeze({
      /** A directory (`''` is the root) or file, or null. */
      get(path: unknown) {
        return memoryNode(memoryPath(path));
      },
    }),
    skills: Object.freeze({
      /** A skill, an attachment's text (`name/file`), or `{ directories }`. */
      get(path?: unknown) {
        if (path === undefined) {
          const names = new Set(
            children(tree, `${SKILLS}/`)
              .filter(
                (key) =>
                  key.split("/").length === 3 && key.endsWith(`/${SKILL_FILE}`),
              )
              .map((key) => key.split("/")[1] as string),
          );
          return Object.freeze({
            directories: Object.freeze(
              [...names].sort().map((name) => Object.freeze({ path: name })),
            ),
          });
        }
        const { name, file: attachment } = skillPath(path);
        if (attachment === undefined) return skill(name);
        const full = `${SKILLS}/${name}/${attachment}`;
        return tree.has(full) ? text(full) : null;
      },
    }),
  };
}

/** Markdown link targets and backticked tokens in a directory body. */
function references(body: string) {
  const links = [...body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)]
    .map((match) => match[1] as string)
    .filter(
      (target) =>
        !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#"),
    )
    .map((target) => target.replace(/[#?].*$/, ""))
    .filter(Boolean);
  const mentions = [...body.matchAll(/`([^`\s]+)`/g)].map(
    (match) => match[1] as string,
  );
  return { links, mentions };
}

/** Links resolve root-relative or relative to the directory. */
function candidates(directory: string, target: string): string[] {
  const clean = (path: string) =>
    posix
      .normalize(path)
      .replace(/^\.\/|^\/+/, "")
      .replace(/\/+$/, "");
  return [clean(target), clean(posix.join(directory, target))].filter(
    (path) => path && path !== "." && !path.startsWith(".."),
  );
}

function linkReport(
  tree: Tree,
  views: ReturnType<typeof createViews>,
  path: string,
): HarnessLinkReport {
  const node = views.memoryNode(path) as HarnessDirectory;
  const { links, mentions } = references(node.body);
  const resolved = new Set(
    [...links, ...mentions].flatMap((target) => candidates(path, target)),
  );
  const childPaths = [
    ...node.files.map((child) => child.path),
    ...node.directories.map((child) => child.path),
  ];
  const unlinked = childPaths.filter(
    (child) =>
      !resolved.has(child) &&
      !resolved.has(`${child}.md`) &&
      !resolved.has(`${child}/${DOC}`),
  );
  const exists = (candidate: string) =>
    tree.has(candidate) || children(tree, `${candidate}/`).length > 0;
  const dangling = [
    ...new Set(
      links.filter((target) => !candidates(path, target).some(exists)),
    ),
  ];
  return { path, unlinked, dangling };
}

function defaultEditBranch(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `harness/edit-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function isHarnessPath(path: string): boolean {
  return path.endsWith(".md") || path.startsWith(`${SKILLS}/`);
}

async function readTree(repo: MemoryHandle, ref: string) {
  const [head] = await repo.log({ ref, limit: 1 });
  if (!head) throw new Error(`Unknown ref: ${ref}`);
  const revision = head.sha;
  const paths = await repo.list({ ref: revision });
  if (!paths.includes(DOC)) {
    throw new Error("harness requires the MemFS v2 layout (a root MEMORY.md).");
  }
  const tree: Tree = new Map(
    await Promise.all(
      paths.map(
        async (path) =>
          [
            path,
            isHarnessPath(path)
              ? ((await repo.read(path, { ref: revision })) ?? "")
              : undefined,
          ] as const,
      ),
    ),
  );
  return { revision, tree };
}

/** File-level changes from one tree to another, sorted by path. */
function treeChanges(from: Tree, to: Tree): HarnessChange[] {
  const result: HarnessChange[] = [];
  for (const path of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const inFrom = from.has(path);
    const inTo = to.has(path);
    const before = from.get(path);
    const after = to.get(path);
    if (inFrom && !inTo) {
      result.push({
        path,
        op: "delete",
        ...(before !== undefined ? { before } : {}),
      });
    } else if (!inFrom && inTo) {
      result.push({ path, op: "add", after: after ?? "" });
    } else if (before !== after) {
      result.push({
        path,
        op: "modify",
        before: before ?? "",
        after: after ?? "",
      });
    }
  }
  return result;
}

/**
 * Typed changes between two revisions: what `ref` changed relative to
 * `base`. Pass a proposal's `base` (its edit's loaded revision) to read
 * exactly what that proposal did.
 */
export async function diffHarness(
  repo: MemoryHandle,
  base: string,
  ref: string,
) {
  const [from, to] = await Promise.all([
    readTree(repo, base),
    readTree(repo, ref),
  ]);
  return {
    base: from.revision,
    ref: to.revision,
    changes: treeChanges(from.tree, to.tree),
  };
}

/** Fast-forward `main` to `ref` only while main is still at `expect`. */
export async function acceptHarness(
  repo: MemoryHandle,
  ref: string,
  expect: string,
) {
  const result = await repo.promote({ ref, expect });
  return { sha: result.sha, changed: result.changed };
}

export async function loadHarnessSnapshot(repo: MemoryHandle, ref?: string) {
  const sourceRef = ref ?? repo.defaultBranch;
  const { revision, tree: base } = await readTree(repo, sourceRef);
  const snapshot = createViews(base);

  function edit(options?: unknown) {
    const parsed =
      options === undefined ? {} : record(options, "edit() options");
    const branch =
      parsed.branch === undefined
        ? defaultEditBranch()
        : scalar(parsed.branch, "branch");
    if (branch === repo.defaultBranch) {
      throw new Error(
        `edit() commits to a branch, not ${repo.defaultBranch}; harness.accept() moves ${repo.defaultBranch} to it.`,
      );
    }
    const staged: Tree = new Map(base);
    const views = createViews(staged);
    // "committing" blocks staging while send() is in flight; a rejected
    // send returns to "open" so the staged edits can be retried.
    let state: "open" | "committing" | "committed" = "open";
    const live = () => {
      if (state === "committing") {
        throw new Error("This edit is being committed.");
      }
      if (state === "committed") {
        throw new Error("This edit was already committed.");
      }
    };
    const removeUnder = (prefix: string) => {
      for (const path of children(staged, prefix)) staged.delete(path);
    };
    const nonEmpty = (prefix: string, own: string) =>
      children(staged, prefix).some((path) => path !== own);

    function putMemory(path: string, value: unknown) {
      const directory = views.isDirectory(path);
      const fileExists = path !== "" && staged.has(`${path}.md`);
      const wantsDirectory = isRecord(value) && value.directory === true;
      if (directory || (!fileExists && wantsDirectory)) {
        if (fileExists) throw new Error(`${path} is a file, not a directory.`);
        if (!directory) {
          if (!views.isDirectory(parentOf(path))) {
            throw new Error(
              `No directory ${parentOf(path)}; put it with { directory: true, body } first.`,
            );
          }
          if (path === "") throw new Error("The memory root always exists.");
        }
        staged.set(path ? `${path}/${DOC}` : DOC, directoryDocument(value));
        return;
      }
      if (!path.includes("/")) {
        throw new Error(
          `Root files are prompts: use prompts.put(${JSON.stringify(path)}), or pass { directory: true } to create a directory.`,
        );
      }
      if (!fileExists) {
        if (!views.isDirectory(parentOf(path))) {
          throw new Error(
            `No directory ${parentOf(path)}; put it with { directory: true, body } first.`,
          );
        }
        if (children(staged, `${path}/`).length > 0) {
          throw new Error(`${path} already exists as a directory.`);
        }
      }
      if (wantsDirectory)
        throw new Error(`${path} is a file, not a directory.`);
      staged.set(
        `${path}.md`,
        markdownFile(`${path}.md`, value, posix.basename(path)),
      );
    }

    function deleteMemory(path: string, recursive: boolean) {
      if (path === "") throw new Error("The memory root cannot be deleted.");
      if (views.isDirectory(path)) {
        const prefix = `${path}/`;
        if (!recursive && nonEmpty(prefix, `${prefix}${DOC}`)) {
          throw new Error(
            `${path} is not empty; pass { recursive: true } to delete it and everything under it.`,
          );
        }
        removeUnder(prefix);
        return;
      }
      if (!path.includes("/") || !staged.has(`${path}.md`)) {
        throw new Error(`No memory node ${path}.`);
      }
      staged.delete(`${path}.md`);
    }

    function putPrompt(name: string, value: unknown) {
      if (
        !staged.has(`${name}.md`) &&
        children(staged, `${name}/`).length > 0
      ) {
        throw new Error(`${name} already exists as a memory directory.`);
      }
      staged.set(`${name}.md`, markdownFile(`${name}.md`, value, name));
    }

    function putSkill(path: unknown, value: unknown) {
      const { name, file } = skillPath(path);
      const folder = `${SKILLS}/${name}/`;
      if (file === undefined) {
        const fields = record(value, "skill value");
        if (fields.name !== undefined && fields.name !== name) {
          throw new Error(`A skill's name must match its folder (${name}).`);
        }
        staged.set(
          `${folder}${SKILL_FILE}`,
          `---\nname: ${name}\ndescription: ${scalar(fields.description, "description")}\n---\n${bodyOf(fields.body)}`,
        );
        return;
      }
      if (!staged.has(`${folder}${SKILL_FILE}`)) {
        throw new Error(`No skill ${name}; put it first.`);
      }
      const full = normalizeMemoryPath(`${folder}${file}`);
      if (!full.startsWith(folder)) {
        throw new Error(`Invalid skill file path: ${file}`);
      }
      if (typeof value !== "string") {
        throw new Error(`Skill file ${file} must be a string.`);
      }
      staged.set(full, value);
    }

    function deleteSkill(path: unknown, recursive: boolean) {
      const { name, file } = skillPath(path);
      const folder = `${SKILLS}/${name}/`;
      if (file === undefined) {
        if (!staged.has(`${folder}${SKILL_FILE}`)) {
          throw new Error(`No skill ${name}.`);
        }
        if (!recursive && nonEmpty(folder, `${folder}${SKILL_FILE}`)) {
          throw new Error(
            `Skill ${name} has files; pass { recursive: true } to delete it.`,
          );
        }
        removeUnder(folder);
        return;
      }
      if (!staged.has(`${folder}${file}`)) {
        throw new Error(`No skill file ${name}/${file}.`);
      }
      staged.delete(`${folder}${file}`);
    }

    function changes(): HarnessChange[] {
      return treeChanges(base, staged);
    }

    function validDocument(path: string, content: string): boolean {
      if (!path.endsWith(".md") || path.startsWith(`${SKILLS}/`)) return true;
      if (path === DOC || path.endsWith(`/${DOC}`)) {
        return !content.startsWith("---");
      }
      return (
        validateMemoryFileFrontmatter({
          path,
          content,
          previousContent: null,
          format: "memfs-v2",
        }).length === 0
      );
    }

    /**
     * Replay changes (from `harness.diff` or another edit's `diff()`) onto
     * the staged tree. A change applies when the node still matches its
     * `before`; concurrent edits to one document merge line by line when
     * they touch different lines; anything else is returned as a conflict
     * and left untouched.
     */
    function apply(input: unknown) {
      if (!Array.isArray(input)) {
        throw new Error("apply() takes an array of changes.");
      }
      const applied: string[] = [];
      const merged: string[] = [];
      const conflicts: {
        path: string;
        base?: string;
        ours?: string;
        theirs?: string;
      }[] = [];
      for (const raw of input) {
        const change = record(raw, "change");
        const path = normalizeMemoryPath(change.path);
        if (!isHarnessPath(path)) {
          throw new Error(`${path} is outside prompts, memory, and skills.`);
        }
        const op = change.op;
        if (op !== "add" && op !== "modify" && op !== "delete") {
          throw new Error(`Invalid change op for ${path}: ${String(op)}`);
        }
        const text = (key: "before" | "after") => {
          const value = change[key];
          if (value !== undefined && typeof value !== "string") {
            throw new Error(`${path} ${key} must be a string.`);
          }
          return value as string | undefined;
        };
        const before = op === "add" ? undefined : (text("before") ?? "");
        const after = op === "delete" ? undefined : (text("after") ?? "");
        const ours = staged.has(path) ? (staged.get(path) ?? "") : undefined;
        const set = (value: string | undefined) => {
          if (value === undefined) staged.delete(path);
          else staged.set(path, value);
        };
        if (ours === after) {
          applied.push(path);
          continue;
        }
        if (ours === before) {
          set(after);
          applied.push(path);
          continue;
        }
        const combined =
          op === "modify" && ours !== undefined && before !== undefined
            ? merge3(before, ours, after ?? "")
            : null;
        if (combined !== null && validDocument(path, combined)) {
          set(combined);
          merged.push(path);
          continue;
        }
        conflicts.push({
          path,
          ...(before !== undefined ? { base: before } : {}),
          ...(ours !== undefined ? { ours } : {}),
          ...(after !== undefined ? { theirs: after } : {}),
        });
      }
      return { applied, merged, conflicts };
    }

    /** Link reports for directories whose body or direct children changed. */
    function links(changed: HarnessChange[]): HarnessLinkReport[] {
      const directories = new Set<string>();
      for (const { path } of changed) {
        if (path.startsWith(`${SKILLS}/`) || !path.endsWith(".md")) continue;
        if (path === DOC) {
          directories.add("");
        } else if (path.endsWith(`/${DOC}`)) {
          const directory = path.slice(0, -DOC.length - 1);
          directories.add(directory);
          directories.add(parentOf(directory));
        } else if (path.includes("/")) {
          directories.add(parentOf(path));
        }
      }
      return [...directories]
        .filter((path) => views.isDirectory(path))
        .sort()
        .map((path) => linkReport(staged, views, path))
        .filter(
          (report) => report.unlinked.length > 0 || report.dangling.length > 0,
        );
    }

    function namespace<Read extends { get: (path?: unknown) => unknown }>(
      read: Read,
      put: (path: unknown, value: unknown) => void,
      remove: (path: unknown, recursive: boolean) => void,
    ) {
      const ns = {
        get: read.get as Read["get"],
        put(path: unknown, value: unknown) {
          live();
          put(path, value);
          return editor;
        },
        update(path: unknown, fn: unknown) {
          live();
          if (typeof fn !== "function") {
            throw new Error("update(path, fn) takes a function.");
          }
          const current = read.get(path);
          if (current === null || current === undefined) {
            throw new Error(`Nothing to update at ${JSON.stringify(path)}.`);
          }
          put(path, fn(current));
          return editor;
        },
        delete(path: unknown, options?: unknown) {
          live();
          remove(path, isRecord(options) && options.recursive === true);
          return editor;
        },
      };
      return Object.freeze(ns);
    }

    const editor = {
      branch,
      base: revision,
      prompts: namespace(
        views.prompts,
        (name, value) => putPrompt(promptName(name), value),
        (name) => {
          const value = promptName(name);
          if (!staged.has(`${value}.md`))
            throw new Error(`No prompt ${value}.`);
          staged.delete(`${value}.md`);
        },
      ),
      memory: namespace(
        views.memory,
        (path, value) => putMemory(memoryPath(path), value),
        (path, recursive) => deleteMemory(memoryPath(path), recursive),
      ),
      skills: namespace(views.skills, putSkill, deleteSkill),
      apply(changes: unknown) {
        live();
        return apply(changes);
      },
      /** Staged changes, a unified diff, and link drift in changed directories. */
      diff() {
        const changed = changes();
        const text = changed
          .map(({ path, before, after }) =>
            Diff.createTwoFilesPatch(
              `a/${path}`,
              `b/${path}`,
              before ?? "",
              after ?? "",
              undefined,
              undefined,
              { context: 3 },
            ),
          )
          .join("");
        return { changes: changed, text, links: links(changed) };
      },
      async commit(message?: unknown) {
        live();
        const commitMessage =
          message === undefined ? "harness edit" : scalar(message, "message");
        const changed = changes();
        if (changed.length === 0) throw new Error("edit has no changes.");
        let branchHead: string | undefined;
        try {
          branchHead = (await repo.log({ ref: branch, limit: 1 }))[0]?.sha;
        } catch {
          branchHead = undefined;
        }
        if (branchHead && branchHead !== revision) {
          throw new Error(
            `Branch ${branch} already exists at ${branchHead.slice(0, 12)}, not this edit's base ${revision.slice(0, 12)}; use another branch.`,
          );
        }
        const commit = repo.commit({
          message: commitMessage,
          branch,
          base: revision,
        });
        for (const change of changed) {
          if (change.op === "delete") commit.delete(change.path);
          else commit.put(change.path, change.after ?? "");
        }
        state = "committing";
        let result: Awaited<ReturnType<typeof commit.send>>;
        try {
          result = await commit.send();
        } catch (error) {
          state = "open";
          throw error;
        }
        state = "committed";
        return {
          sha: result.sha,
          branch: result.branch,
          base: revision,
          changed: changed.map((change) => change.path),
          links: links(changed),
        };
      },
    };
    return editor;
  }

  return Object.freeze({
    ref: sourceRef,
    revision,
    prompts: snapshot.prompts,
    memory: snapshot.memory,
    skills: snapshot.skills,
    edit,
  });
}
