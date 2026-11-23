import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getStringField, parseFrontmatter } from "@/utils/frontmatter.js";
import { resolveGlobalConfigDir } from "@/utils/settings-path.js";

export const COMMANDS_DIR = ".commands";

export function getGlobalCommandsDir(): string {
  return join(resolveGlobalConfigDir(), "commands");
}

export interface CustomCommand {
  id: string;
  description: string;
  argumentHint?: string;
  namespace?: string;
  source: "project" | "user";
  path: string;
  content: string;
}

let cachedCommands: CustomCommand[] | null = null;

export async function getCustomCommands(): Promise<CustomCommand[]> {
  if (cachedCommands !== null) {
    return cachedCommands;
  }
  cachedCommands = await discoverCustomCommands();
  return cachedCommands;
}

export function refreshCustomCommands(): void {
  cachedCommands = null;
}

export async function discoverCustomCommands(
  projectPath: string = join(process.cwd(), COMMANDS_DIR),
): Promise<CustomCommand[]> {
  const commandsById = new Map<string, CustomCommand[]>();

  const userCommands = await discoverFromDirectory(
    getGlobalCommandsDir(),
    "user",
  );
  for (const cmd of userCommands) {
    const existing = commandsById.get(cmd.id) || [];
    existing.push(cmd);
    commandsById.set(cmd.id, existing);
  }

  const projectCommands = await discoverFromDirectory(projectPath, "project");
  for (const cmd of projectCommands) {
    const existing = commandsById.get(cmd.id) || [];
    existing.unshift(cmd);
    commandsById.set(cmd.id, existing);
  }

  const result: CustomCommand[] = [];
  for (const [_id, cmds] of commandsById) {
    result.push(...cmds);
  }

  return result;
}

async function discoverFromDirectory(
  dirPath: string,
  source: "project" | "user",
): Promise<CustomCommand[]> {
  if (!existsSync(dirPath)) {
    return [];
  }

  const commands: CustomCommand[] = [];
  await findCommandFiles(dirPath, dirPath, commands, source);
  return commands;
}

async function findCommandFiles(
  currentPath: string,
  rootPath: string,
  commands: CustomCommand[],
  source: "project" | "user",
): Promise<void> {
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await findCommandFiles(fullPath, rootPath, commands, source);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const cmd = await parseCommandFile(fullPath, rootPath, source);
          if (cmd) {
            commands.push(cmd);
          }
        } catch (_error) {}
      }
    }
  } catch (_error) {}
}

async function parseCommandFile(
  filePath: string,
  rootPath: string,
  source: "project" | "user",
): Promise<CustomCommand | null> {
  const content = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  const id = basename(filePath, ".md");

  const relativePath = dirname(filePath).slice(rootPath.length);
  const namespace = relativePath.replace(/^[/\\]/, "") || undefined;

  let description = getStringField(frontmatter, "description");
  if (!description) {
    const firstLine = body.split("\n")[0]?.trim();
    description = firstLine?.replace(/^#\s*/, "") || `Custom command: ${id}`;
  }

  const argumentHint = getStringField(frontmatter, "argument-hint");

  return {
    id,
    description,
    argumentHint,
    namespace,
    source,
    path: filePath,
    content: body,
  };
}

export function substituteArguments(content: string, args: string): string {
  let result = content;

  result = result.replace(/\$ARGUMENTS/g, args);

  const argParts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < 9; i++) {
    result = result.replace(new RegExp(`\\$${i + 1}`, "g"), argParts[i] || "");
  }

  return result;
}

export async function expandBashCommands(content: string): Promise<string> {
  const bashPattern = /!`([^`]+)`/g;
  const matches = [...content.matchAll(bashPattern)];

  if (matches.length === 0) {
    return content;
  }

  const { spawnCommand } = await import("@/tools/impl/bash.js");
  const { getShellEnv } = await import("@/tools/impl/shell-env.js");

  let result = content;

  for (const match of matches) {
    const fullMatch = match[0];
    const command = match[1];

    if (!command) continue;

    try {
      const cmdResult = await spawnCommand(command, {
        cwd: process.cwd(),
        env: getShellEnv(),
        timeout: 10000,
      });

      const output = (cmdResult.stdout + cmdResult.stderr).trim();
      result = result.replace(fullMatch, output);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      result = result.replace(
        fullMatch,
        `[Error executing ${command}: ${errMsg}]`,
      );
    }
  }

  return result;
}

export async function findCustomCommand(
  commandName: string,
): Promise<CustomCommand | undefined> {
  const commands = await getCustomCommands();

  const exactMatches = commands.filter((cmd) => cmd.id === commandName);
  if (exactMatches.length > 0) {
    return exactMatches.find((c) => c.source === "project") || exactMatches[0];
  }

  return undefined;
}
