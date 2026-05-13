import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type WebSocket from "ws";
import { getGitContext } from "../../../cli/helpers/gitContext";
import {
  isCheckoutBranchCommand,
  isSearchBranchesCommand,
} from "../protocol-inbound";
import { emitDeviceStatusUpdate } from "../protocol-outbound";
import type { ListenerRuntime } from "../types";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

type GitBranchCommandContext = {
  socket: WebSocket;
  runtime: ListenerRuntime;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export function handleGitBranchCommand(
  parsed: unknown,
  context: GitBranchCommandContext,
): boolean {
  const { socket, runtime, safeSocketSend, runDetachedListenerTask } = context;

  if (isSearchBranchesCommand(parsed)) {
    runDetachedListenerTask("search_branches", async () => {
      try {
        const cwd = parsed.cwd ?? runtime.bootWorkingDirectory;
        const maxResults = parsed.max_results ?? 20;
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync(
          "git",
          ["branch", "-a", "--format=%(refname:short)\t%(HEAD)"],
          {
            cwd,
            encoding: "utf-8",
            timeout: 5000,
          },
        );

        const query = parsed.query.toLowerCase();
        const branches = stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            const parts = line.split("\t");
            const trimmedName = (parts[0] ?? "").trim();
            const isRemote = trimmedName.startsWith("origin/");
            return {
              name: trimmedName,
              is_current: parts[1]?.trim() === "*",
              is_remote: isRemote,
            };
          })
          .filter(
            (branch) =>
              query.length === 0 || branch.name.toLowerCase().includes(query),
          )
          .slice(0, maxResults);

        safeSocketSend(
          socket,
          {
            type: "search_branches_response",
            request_id: parsed.request_id,
            branches,
            success: true,
          },
          "listener_search_branches_send_failed",
          "listener_search_branches",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "search_branches_response",
            request_id: parsed.request_id,
            branches: [],
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to search branches",
          },
          "listener_search_branches_send_failed",
          "listener_search_branches",
        );
      }
    });
    return true;
  }

  if (isCheckoutBranchCommand(parsed)) {
    runDetachedListenerTask("checkout_branch", async () => {
      try {
        const cwd = parsed.cwd ?? runtime.bootWorkingDirectory;
        const execFileAsync = promisify(execFile);

        const args = parsed.create
          ? ["checkout", "-b", parsed.branch]
          : ["checkout", parsed.branch];

        await execFileAsync("git", args, {
          cwd,
          encoding: "utf-8",
          timeout: 10000,
        });

        const gitCtx = getGitContext(cwd);

        safeSocketSend(
          socket,
          {
            type: "checkout_branch_response",
            request_id: parsed.request_id,
            branch: gitCtx?.branch ?? parsed.branch,
            success: true,
          },
          "listener_checkout_branch_send_failed",
          "listener_checkout_branch",
        );

        emitDeviceStatusUpdate(socket, runtime);
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "checkout_branch_response",
            request_id: parsed.request_id,
            branch: parsed.branch,
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to checkout branch",
          },
          "listener_checkout_branch_send_failed",
          "listener_checkout_branch",
        );
      }
    });
    return true;
  }

  return false;
}
