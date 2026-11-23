import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCloudRepositoryNames } from "@/utils/cloud-repository-roots";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

type NativeSessionSource = "claude_code" | "codex";
export interface NativeSessionOwner {
  agentId: string;
  conversationId: string;
  actingUserId?: string | null;
  cloudSkillRepositories?: string[];
  /** The Agent task description the session was launched for. */
  description?: string;
}

function ownerPath(source: NativeSessionSource, sessionId: string): string {
  const id = createHash("sha256")
    .update(`${source}:${sessionId}`)
    .digest("hex");
  return join(resolveGlobalConfigDir(), "native-session-owners", `${id}.json`);
}

export function readNativeSessionOwner(
  source: NativeSessionSource,
  sessionId: string,
): NativeSessionOwner | undefined {
  try {
    const owner = JSON.parse(
      readFileSync(ownerPath(source, sessionId), "utf8"),
    );
    if (
      typeof owner.agentId === "string" &&
      typeof owner.conversationId === "string" &&
      (owner.cloudSkillRepositories === undefined ||
        isCloudRepositoryNames(owner.cloudSkillRepositories))
    )
      return owner;
    throw new Error("Invalid native session owner record");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

export function persistNativeSessionOwner(
  source: NativeSessionSource,
  sessionId: string,
  scope: NativeSessionOwner,
): void {
  const path = ownerPath(source, sessionId);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify(scope), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function clearNativeSessionOwnersForTests(): void {
  rmSync(join(resolveGlobalConfigDir(), "native-session-owners"), {
    recursive: true,
    force: true,
  });
}
