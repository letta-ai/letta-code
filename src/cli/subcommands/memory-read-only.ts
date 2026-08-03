import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertMemoryRepoCleanForWrite,
  commitMemoryWrite,
} from "@/agent/memory-git";
import { isLocalBackendEnvEnabled } from "@/backend/local/paths";

export function updateReadOnlyFrontmatter(
  content: string,
  value: boolean,
): string | null {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
  if (!frontmatter) throw new Error("Memory file is missing frontmatter.");

  const field = /^read_only\s*:\s*(.*?)\s*$/m.exec(frontmatter[0]);
  if (field && field[1] !== "true" && field[1] !== "false") {
    throw new Error("Memory file read_only must be true or false.");
  }
  if (field?.[1] === String(value)) return null;
  if (field) {
    return content.replace(
      /^read_only\s*:\s*(?:true|false)\s*$/m,
      `read_only: ${value}`,
    );
  }

  const newline = frontmatter[0].includes("\r\n") ? "\r\n" : "\n";
  const closing = frontmatter.index + frontmatter[0].length - 3;
  return `${content.slice(0, closing)}read_only: ${value}${newline}${content.slice(closing)}`;
}

function resolveMemoryFile(memoryDir: string, input: string) {
  if (isAbsolute(input)) throw new Error("Memory path must be relative.");
  const absolutePath = resolve(memoryDir, input);
  const relativePath = relative(memoryDir, absolutePath).replace(/\\/g, "/");
  if (!/^(system|reference)\/.+\.md$/.test(relativePath)) {
    throw new Error(
      "Memory path must be a .md file under system/ or reference/.",
    );
  }
  if (!existsSync(absolutePath))
    throw new Error(`Memory file not found: ${input}`);
  if (
    relative(realpathSync(memoryDir), realpathSync(absolutePath)).startsWith(
      "..",
    )
  ) {
    throw new Error("Memory file resolves outside the memory directory.");
  }
  return { absolutePath, relativePath };
}

export async function runMemoryReadOnlyAction(args: {
  agentId: string;
  memoryDir: string;
  path?: string;
  value?: string;
  extraPositionals: string[];
}): Promise<number> {
  if (!args.path || !args.value || args.extraPositionals.length) {
    console.error("Usage: letta memory read-only <path> <true|false>");
    return 1;
  }
  if (args.value !== "true" && args.value !== "false") {
    console.error("read-only value must be true or false.");
    return 1;
  }

  await assertMemoryRepoCleanForWrite(args.memoryDir);
  const file = resolveMemoryFile(args.memoryDir, args.path);
  const original = readFileSync(file.absolutePath, "utf8");
  const desired = args.value === "true";
  const updated = updateReadOnlyFrontmatter(original, desired);
  if (updated === null) return 0;

  writeFileSync(file.absolutePath, updated, "utf8");
  const previousApproval = process.env.LETTA_APPROVED_READ_ONLY_CHANGE;
  process.env.LETTA_APPROVED_READ_ONLY_CHANGE = "1";
  try {
    const result = await commitMemoryWrite({
      memoryDir: args.memoryDir,
      pathspecs: [file.relativePath],
      reason: `${desired ? "Mark" : "Unmark"} ${file.relativePath} as read-only`,
      author: {
        agentId: args.agentId,
        authorName: args.agentId,
        authorEmail: `${args.agentId}@letta.com`,
      },
      syncMode: isLocalBackendEnvEnabled() ? "local" : "remote",
    });
    if (!result.committed) {
      writeFileSync(file.absolutePath, original, "utf8");
      return 1;
    }
    console.log(
      JSON.stringify({ ...result, path: file.relativePath, readOnly: desired }),
    );
    return 0;
  } catch (error) {
    writeFileSync(file.absolutePath, original, "utf8");
    throw error;
  } finally {
    if (previousApproval === undefined)
      delete process.env.LETTA_APPROVED_READ_ONLY_CHANGE;
    else process.env.LETTA_APPROVED_READ_ONLY_CHANGE = previousApproval;
  }
}
