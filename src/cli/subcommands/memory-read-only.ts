import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertMemoryRepoCleanForWrite,
  buildNonInteractiveGitEnv,
} from "@/agent/memory-git";
import {
  installPostCommitHook,
  installPreCommitHook,
} from "@/agent/memory-git-hooks";

const execFileAsync = promisify(execFile);

export interface ReadOnlyFrontmatterUpdate {
  content: string;
  changed: boolean;
  previous: boolean | null;
}

/** Update only the protected read_only key while preserving the rest verbatim. */
export function updateReadOnlyFrontmatter(
  content: string,
  readOnly: boolean,
): ReadOnlyFrontmatterUpdate {
  const match = content.match(/^(---(\r?\n))([\s\S]*?)(\r?\n)---(?=\r?\n|$)/);
  if (!match) {
    throw new Error("Memory file is missing required frontmatter.");
  }

  const newline = match[2] ?? "\n";
  const frontmatter = match[3] ?? "";
  if (/^description\s*:/m.exec(frontmatter) === null) {
    throw new Error("Memory file frontmatter is missing 'description'.");
  }

  const readOnlyLines = [
    ...frontmatter.matchAll(/^read_only\s*:\s*(.*?)\s*$/gm),
  ];
  if (readOnlyLines.length > 1) {
    throw new Error("Memory file has duplicate read_only fields.");
  }

  let previous: boolean | null = null;
  if (readOnlyLines.length === 1) {
    const value = readOnlyLines[0]?.[1]?.trim();
    if (value !== "true" && value !== "false") {
      throw new Error("Memory file read_only field must be true or false.");
    }
    previous = value === "true";
    if (previous === readOnly) {
      return { content, changed: false, previous };
    }
  }

  const updatedFrontmatter =
    previous === null
      ? `${frontmatter}${newline}read_only: ${readOnly}`
      : frontmatter.replace(
          /^read_only\s*:\s*(.*?)\s*$/m,
          `read_only: ${readOnly}`,
        );
  const updated = `${match[1]}${updatedFrontmatter}${match[4]}---${content.slice(match[0].length)}`;
  return { content: updated, changed: true, previous };
}

function resolveMemoryFile(
  memoryDir: string,
  inputPath: string,
): {
  absolutePath: string;
  relativePath: string;
} {
  if (!inputPath || isAbsolute(inputPath)) {
    throw new Error(
      "Memory file path must be relative to the memory directory.",
    );
  }

  const absolutePath = resolve(memoryDir, inputPath);
  const relativePath = relative(memoryDir, absolutePath).replace(/\\/g, "/");
  if (
    !relativePath ||
    relativePath.startsWith("../") ||
    /^(system|reference)\/.+\.md$/.exec(relativePath) === null
  ) {
    throw new Error(
      "Memory file must be a .md file under system/ or reference/.",
    );
  }
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
    throw new Error(`Memory file not found: ${relativePath}`);
  }

  const realRoot = realpathSync(memoryDir);
  const realFile = realpathSync(absolutePath);
  const realRelative = relative(realRoot, realFile);
  if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
    throw new Error("Memory file resolves outside the memory directory.");
  }

  return { absolutePath, relativePath };
}

async function commitReadOnlyToggle(args: {
  memoryDir: string;
  relativePath: string;
  agentId: string;
  reason: string;
}): Promise<string> {
  installPreCommitHook(args.memoryDir);
  installPostCommitHook(args.memoryDir);
  const runGit = (gitArgs: string[], env = process.env) =>
    execFileAsync("git", gitArgs, {
      cwd: args.memoryDir,
      env: buildNonInteractiveGitEnv(env),
      maxBuffer: 10 * 1024 * 1024,
    });

  await runGit(["add", "--", args.relativePath]);
  try {
    await runGit(
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        `user.name=${args.agentId}`,
        "-c",
        `user.email=${args.agentId}@letta.com`,
        "commit",
        "-m",
        args.reason,
      ],
      { ...process.env, LETTA_APPROVED_READ_ONLY_CHANGE: "1" },
    );
  } catch (error) {
    await runGit(["reset", "HEAD", "--", args.relativePath]).catch(() => {});
    throw error;
  }
  const { stdout } = await runGit(["rev-parse", "HEAD"]);
  return stdout.toString().trim();
}

export async function runMemoryReadOnlyAction(args: {
  agentId: string;
  memoryDir: string;
  path?: string;
  value?: string;
  extraPositionals: string[];
}): Promise<number> {
  if (!args.path || !args.value || args.extraPositionals.length > 0) {
    console.error(
      "Usage: letta memory read-only <system/or/reference/file.md> <true|false> --agent <id>",
    );
    return 1;
  }
  if (args.value !== "true" && args.value !== "false") {
    console.error("read-only value must be true or false.");
    return 1;
  }

  await assertMemoryRepoCleanForWrite(args.memoryDir);
  const { absolutePath, relativePath } = resolveMemoryFile(
    args.memoryDir,
    args.path,
  );
  const original = readFileSync(absolutePath, "utf8");
  const desired = args.value === "true";
  const update = updateReadOnlyFrontmatter(original, desired);
  if (!update.changed) {
    console.log(
      JSON.stringify(
        {
          agentId: args.agentId,
          path: relativePath,
          readOnly: desired,
          changed: false,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  writeFileSync(absolutePath, update.content, "utf8");
  try {
    const sha = await commitReadOnlyToggle({
      memoryDir: args.memoryDir,
      relativePath,
      agentId: args.agentId,
      reason: `${desired ? "Mark" : "Unmark"} ${relativePath} as read-only`,
    });
    console.log(
      JSON.stringify(
        {
          agentId: args.agentId,
          path: relativePath,
          readOnly: desired,
          changed: true,
          commit: sha,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    writeFileSync(absolutePath, original, "utf8");
    throw error;
  }
}
