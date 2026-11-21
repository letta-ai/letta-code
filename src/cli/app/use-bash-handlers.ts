
import { type Dispatch, type MutableRefObject, useCallback } from "react";
import { appendStreamingOutput, type Buffers } from "@/cli/helpers/accumulator";
import { INTERRUPTED_BY_USER } from "@/constants";

import { uid } from "./ids";

type BashCommandCacheEntry = {
  input: string;
  output: string;
};

type BashHandlersContext = {
  bashAbortControllerRef: MutableRefObject<AbortController | null>;
  bashCommandCacheRef: MutableRefObject<BashCommandCacheEntry[]>;
  bashRunning: boolean;
  buffersRef: MutableRefObject<Buffers>;
  refreshDerived: () => void;
  refreshDerivedStreaming: () => void;
  setBashRunning: Dispatch<boolean>;
};

export function useBashHandlers(ctx: BashHandlersContext) {
  const {
    bashAbortControllerRef,
    bashCommandCacheRef,
    bashRunning,
    buffersRef,
    refreshDerived,
    refreshDerivedStreaming,
    setBashRunning,
  } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: bash refs are stable objects; .current is read dynamically at command execution time.
  const handleBashSubmit = useCallback(
    async (command: string) => {
      if (bashRunning) return;

      const cmdId = uid("bash");
      const startTime = Date.now();

      setBashRunning(true);
      bashAbortControllerRef.current = new AbortController();

      buffersRef.current.byId.set(cmdId, {
        kind: "bash_command",
        id: cmdId,
        input: command,
        output: "",
        phase: "running",
        streaming: {
          tailLines: [],
          partialLine: "",
          partialIsStderr: false,
          totalLineCount: 0,
          startTime,
        },
      });
      buffersRef.current.order.push(cmdId);
      refreshDerived();

      try {
        const { expandAliases } = await import("@/cli/helpers/shell-aliases");
        const expanded = expandAliases(command);

        const finalCommand = expanded.functionDef
          ? `${expanded.functionDef}\n${expanded.command}`
          : expanded.command;

        const { spawnCommand } = await import("@/tools/impl/bash.js");
        const { getShellEnv } = await import("@/tools/impl/shell-env.js");

        const result = await spawnCommand(finalCommand, {
          cwd: process.cwd(),
          env: getShellEnv(),
          timeout: 0, // No timeout - user must ESC to interrupt (LET-7199)
          signal: bashAbortControllerRef.current.signal,
          onOutput: (chunk, stream) => {
            const entry = buffersRef.current.byId.get(cmdId);
            if (entry && entry.kind === "bash_command") {
              const newStreaming = appendStreamingOutput(
                entry.streaming,
                chunk,
                startTime,
                stream === "stderr",
              );
              buffersRef.current.byId.set(cmdId, {
                ...entry,
                streaming: newStreaming,
              });
              refreshDerivedStreaming();
            }
          },
        });

        const output = (result.stdout + result.stderr).trim();
        const success = result.exitCode === 0;

        const displayOutput =
          output ||
          (success
            ? "(Command completed with no output)"
            : `Exit code: ${result.exitCode}`);
        buffersRef.current.byId.set(cmdId, {
          kind: "bash_command",
          id: cmdId,
          input: command,
          output: displayOutput,
          phase: "finished",
          success,
          streaming: undefined,
        });

        bashCommandCacheRef.current.push({
          input: command,
          output: displayOutput,
        });
      } catch (error: unknown) {
        const err = error as { name?: string; code?: string; message?: string };
        const isAbort =
          bashAbortControllerRef.current?.signal.aborted ||
          err.code === "ABORT_ERR" ||
          err.name === "AbortError" ||
          err.message === "The operation was aborted";

        let errOutput: string;
        if (isAbort) {
          errOutput = INTERRUPTED_BY_USER;
        } else {
          errOutput =
            error instanceof Error
              ? (error as { stderr?: string; stdout?: string }).stderr ||
                (error as { stdout?: string }).stdout ||
                error.message
              : String(error);
        }

        buffersRef.current.byId.set(cmdId, {
          kind: "bash_command",
          id: cmdId,
          input: command,
          output: errOutput,
          phase: "finished",
          success: false,
          streaming: undefined,
        });

        bashCommandCacheRef.current.push({ input: command, output: errOutput });
      } finally {
        setBashRunning(false);
        bashAbortControllerRef.current = null;
      }

      refreshDerived();
    },
    [
      bashRunning,
      refreshDerived,
      refreshDerivedStreaming,
      bashAbortControllerRef,
      setBashRunning,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: bashAbortControllerRef is stable; .current is read dynamically when ESC is pressed.
  const handleBashInterrupt = useCallback(() => {
    if (bashAbortControllerRef.current) {
      bashAbortControllerRef.current.abort();
    }
  }, []);

  return {
    handleBashSubmit,
    handleBashInterrupt,
  };
}
