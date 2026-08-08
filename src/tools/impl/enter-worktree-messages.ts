import { readFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS, truncateByChars } from "./truncation.js";

export interface ProjectInstructions {
  content: string;
  truncated: boolean;
}

export async function readProjectInstructions(
  worktreePath: string,
): Promise<ProjectInstructions | null> {
  try {
    const content = (
      await readFile(path.join(worktreePath, "AGENTS.md"), "utf8")
    ).trim();
    if (!content) return null;
    const truncated = truncateByChars(
      content,
      LIMITS.READ_OUTPUT_CHARS,
      "EnterWorktree",
    );
    return {
      content: truncated.content,
      truncated: truncated.wasTruncated,
    };
  } catch {
    return null;
  }
}

function appendProjectInstructions(
  lines: string[],
  instructions: ProjectInstructions | null,
): void {
  if (!instructions) return;
  lines.push(
    "",
    "Root project instructions loaded automatically from AGENTS.md:",
    "--- BEGIN AGENTS.md ---",
    instructions.content,
    "--- END AGENTS.md ---",
  );
  if (instructions.truncated) {
    lines.push("AGENTS.md was truncated. Read the file before continuing.");
  }
}

export function buildCreatedWorktreeMessage(params: {
  worktreePath: string;
  branchName: string;
  baseRef: string;
  switchedCwd: boolean;
  provisionNotes: string[];
  linkedDependencies: boolean;
  projectInstructions: ProjectInstructions | null;
}): string {
  const provisioning =
    params.provisionNotes.length > 0
      ? [
          "",
          "Provisioning:",
          ...params.provisionNotes.map((note) => `- ${note}`),
        ]
      : ["", "Provisioning: nothing to copy, symlink, or link."];

  // The dependency directories are SYMLINKED to the primary checkout, so a
  // package install in this worktree writes through to the primary checkout's
  // node_modules. Tell the agent how to opt out when it needs its own deps.
  const dependencyStep = params.linkedDependencies
    ? "- Dependencies (e.g. node_modules) are symlinked from the primary checkout and ready to use. Do NOT run a package install here — it would modify the primary checkout's dependencies. If this worktree needs different or isolated packages, recreate it with `symlink_dependencies: false` and install fresh."
    : "- Dependencies were not symlinked. Follow the loaded project instructions for dependency setup. If they define no setup command, use the repository's package manager before building or testing.";

  const lines = [
    "Created worktree.",
    "",
    `Path: ${params.worktreePath}`,
    `Branch: ${params.branchName}`,
    `Base: ${params.baseRef}`,
    ...provisioning,
    "",
    params.switchedCwd
      ? "This conversation's working directory is now the new worktree."
      : "The conversation working directory was left unchanged.",
    "",
    "Next steps:",
    "- Confirm you are in the new worktree with `git status` before editing.",
    "- Read README, AGENTS.md, or other project setup docs before running commands.",
    dependencyStep,
    "- Git hooks and ignored files listed in .worktreeinclude are provisioned automatically.",
    "- Then make changes, test, commit, and push from this worktree.",
  ];
  appendProjectInstructions(lines, params.projectInstructions);
  return lines.join("\n");
}

export function buildEnteredWorktreeMessage(params: {
  worktreePath: string;
  branchName?: string;
  switchedCwd: boolean;
  lockNote?: string;
  projectInstructions: ProjectInstructions | null;
}): string {
  const lines = [
    "Switched to existing worktree.",
    "",
    `Path: ${params.worktreePath}`,
    `Branch: ${params.branchName ?? "(detached)"}`,
  ];
  if (params.lockNote) {
    lines.push(`Lock: ${params.lockNote}`);
  }
  lines.push(
    "",
    params.switchedCwd
      ? "This conversation's working directory is now this worktree."
      : "The conversation working directory was left unchanged.",
    "",
    "Next steps:",
    "- Confirm you are in the worktree with `git status` before editing.",
    "- This worktree already existed, so it was not re-provisioned; its dependencies, hooks, and ignored files are whatever it already had.",
  );
  appendProjectInstructions(lines, params.projectInstructions);
  return lines.join("\n");
}
