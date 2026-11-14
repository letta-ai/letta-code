import { checkPermissionWithHooks } from "@/permissions/checker";
import { loadPermissions } from "@/permissions/loader";
import { permissionMode } from "@/permissions/mode";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import { parseFrontmatter } from "@/utils/frontmatter";
import { spawnCommand } from "./bash";
import { getShellEnv } from "./shell-env";

/** Expand skill-body commands after the caller has checked invocation eligibility. */
export async function expandSkillCommands(content: string): Promise<string> {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { body } = parseFrontmatter(normalized);
  const matches = [...body.matchAll(/!`([^`]+)`/g)];
  if (matches.length === 0) return content;

  const cwd = getCurrentWorkingDirectory();
  const context = getRuntimeContext();
  const permissions = await loadPermissions(cwd);
  // Check every command before executing any of them. Skill metadata grants no trust.
  for (const match of matches) {
    const command = match[1];
    if (!command) continue;
    const result = await checkPermissionWithHooks(
      "Bash",
      { command },
      permissions,
      cwd,
      { mode: context?.permissionMode ?? permissionMode.getMode() },
      context?.agentId ?? undefined,
    );
    if (result.decision !== "allow") {
      throw new Error(
        `Skill command requires Bash permission (${result.decision}): ${command}`,
      );
    }
  }

  let expanded = normalized.slice(0, normalized.length - body.length);
  let cursor = 0;
  for (const match of matches) {
    const command = match[1];
    if (!command) continue;
    const result = await spawnCommand(command, {
      cwd,
      env: getShellEnv(),
      timeout: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Skill command failed (exit ${result.exitCode}): ${command}`,
      );
    }
    expanded += body.slice(cursor, match.index);
    expanded += (result.stdout + result.stderr).trim();
    cursor = match.index + match[0].length;
  }
  return expanded + body.slice(cursor);
}
