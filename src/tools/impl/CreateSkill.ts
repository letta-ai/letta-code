import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function toArray<T>(x: T | T[] | undefined): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function findFileRecursive(
  root: string,
  predicate: (dir: string, name: string) => boolean,
): Promise<string | null> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        if (predicate(dir, ent.name)) {
          return full;
        }
      }
    }
  }
  return null;
}

export async function create_skill(args: Record<string, unknown>) {
  const task = String(args.task ?? "").trim();
  if (!task) {
    throw new Error("Missing required param: task");
  }

  const src = String(args.source_repo_path ?? "").trim();
  const dest = String(args.dest_skills_path ?? "").trim();
  const overwrite = Boolean(args.overwrite ?? false);

  // Resolve defaults
  const cwd = process.cwd();
  const sourceRepoPath = src
    ? resolve(cwd, src)
    : existsSync(join(cwd, "terminal-bench-skills"))
      ? resolve(cwd, "terminal-bench-skills")
      : null;

  if (!sourceRepoPath || !existsSync(sourceRepoPath)) {
    throw new Error(
      "terminal-bench-skills repo not found. Pass source_repo_path or clone it locally.",
    );
  }

  const skillsRoot = join(sourceRepoPath, "skills");
  if (!existsSync(skillsRoot)) {
    throw new Error(
      `No skills directory found at ${skillsRoot}. Expected terminal-bench-skills layout.`,
    );
  }

  // Look for an existing SKILL.md in the repo (case-insensitive), under a dir named <task>
  const skillFile = await findFileRecursive(skillsRoot, (dir, name) => {
    const isSkillFile = name.toUpperCase() === "SKILL.MD";
    if (!isSkillFile) return false;
    const segments = dir.split("/");
    const last = segments[segments.length - 1] || "";
    return last === task;
  });

  const destSkillsPath = dest ? resolve(cwd, dest) : resolve(cwd, ".skills");
  const destDir = join(destSkillsPath, task);
  const destFile = join(destDir, "SKILL.MD");

  await mkdir(destDir, { recursive: true });

  if (skillFile && existsSync(skillFile)) {
    // Copy content
    const content = await readFile(skillFile, "utf-8");
    if (existsSync(destFile) && !overwrite) {
      return {
        toolReturn: `Skill already exists at ${destFile}. Use overwrite=true to replace.`,
        status: "success" as const,
      };
    }
    await writeFile(destFile, content, "utf-8");
    return {
      toolReturn: `Imported skill '${task}' to ${destFile}`,
      status: "success" as const,
    };
  }

  // Fallback: create a minimal skeleton if no curated SKILL.md found
  const skeleton = `---
id: ${task}
name: ${task.replace(/-/g, " ")}
description: "[TODO] Fill with insights derived from past trajectories for '${task}'."
tags:
  - terminal-bench
  - generated
---

# ${task}

This skill was initialized because no curated SKILL.md was found in the provided terminal-bench-skills repo.

Next steps:
- Summarize past trajectories and add guidance/tips
- Reference any helper files as needed
`;
  if (existsSync(destFile) && !overwrite) {
    return {
      toolReturn: `No curated SKILL.md found. A skeleton already exists at ${destFile}. Use overwrite=true to replace.`,
      status: "success" as const,
    };
  }
  await writeFile(destFile, skeleton, "utf-8");
  return {
    toolReturn: `Created skeleton skill for '${task}' at ${destFile}`,
    status: "success" as const,
  };
}

