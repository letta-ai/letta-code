import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { debugWarn } from "./debug.js";
import { resolveGlobalConfigDir } from "./settings-path.js";

/**
 * Which conversation this process has open, in `<config dir>/sessions/<pid>.json`.
 *
 * The project record (`.letta/settings.local.json`) says which conversation a folder opened
 * last. Every letta in that folder shares it, and the home folder keeps none, so a tool that
 * looks at one running letta (a terminal client showing that pane's chat) cannot tell from it
 * which conversation the process is on now. This file is that process's own: rewritten on start
 * and on every switch, removed when the process exits.
 *
 * `started_at` is when this process started (epoch ms), so a reader can tell the file from one a
 * process that had the same pid left behind.
 */
export interface ProcessSessionRecord {
  pid: number;
  started_at: number;
  agent_id: string;
  conversation_id: string;
  updated_at: number;
}

let removeOnExit = false;

export function processSessionPath(pid: number = process.pid): string {
  return join(resolveGlobalConfigDir(), "sessions", `${pid}.json`);
}

export function recordProcessSession(
  agentId: string,
  conversationId: string,
): void {
  const path = processSessionPath();
  const record: ProcessSessionRecord = {
    pid: process.pid,
    started_at: Math.round(performance.timeOrigin),
    agent_id: agentId,
    conversation_id: conversationId,
    updated_at: Date.now(),
  };
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    // whole or not at all: a reader never sees half a record
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    debugWarn("settings", "Could not record this process's session: %s", error);
    return;
  }
  if (!removeOnExit) {
    removeOnExit = true;
    process.once("exit", () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // best effort: the pid and start time tell a reader the file is stale
      }
    });
  }
}
