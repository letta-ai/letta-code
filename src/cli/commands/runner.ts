import type { MutableRefObject } from "react";
import type { Buffers, Line } from "../helpers/accumulator";

export type CommandPhase = "running" | "waiting" | "finished";

export type CommandUpdate = {
  output: string;
  phase?: CommandPhase;
  success?: boolean;
  dimOutput?: boolean;
  preformatted?: boolean;
};

export type CommandHandle = {
  id: string;
  input: string;
  update: (update: CommandUpdate) => void;
  finish: (
    output: string,
    success?: boolean,
    dimOutput?: boolean,
    preformatted?: boolean,
  ) => void;
  fail: (output: string) => void;
};

export type CommandFinishedEvent = {
  id: string;
  input: string;
  output: string;
  success: boolean;
  dimOutput?: boolean;
  preformatted?: boolean;
};

type CreateId = (prefix: string) => string;

type RunnerDeps = {
  buffersRef: MutableRefObject<Buffers>;
  refreshDerived: () => void;
  createId: CreateId;
  onCommandFinished?: (event: CommandFinishedEvent) => void;
};

function upsertCommandLine(
  buffers: Buffers,
  id: string,
  input: string,
  update: CommandUpdate,
): void {
  const existing = buffers.byId.get(id);
  const next: Line = {
    kind: "command",
    id,
    input: existing?.kind === "command" ? existing.input : input,
    output: update.output,
    phase: update.phase ?? "running",
    success: update.success,
    dimOutput: update.dimOutput,
    preformatted: update.preformatted,
  };
  buffers.byId.set(id, next);
}

export function createCommandRunner({
  buffersRef,
  refreshDerived,
  createId,
  onCommandFinished,
}: RunnerDeps) {
  function getHandle(id: string, input: string): CommandHandle {
    const update = (updateData: CommandUpdate) => {
      const previous = buffersRef.current.byId.get(id);
      const wasFinished =
        previous?.kind === "command" && previous.phase === "finished";

      upsertCommandLine(buffersRef.current, id, input, updateData);
      if (!buffersRef.current.order.includes(id)) {
        buffersRef.current.order.push(id);
      }

      const next = buffersRef.current.byId.get(id);
      const becameFinished =
        !wasFinished && next?.kind === "command" && next.phase === "finished";
      if (becameFinished) {
        onCommandFinished?.({
          id,
          input: next.input,
          output: next.output,
          success: next.success !== false,
          dimOutput: next.dimOutput,
          preformatted: next.preformatted,
        });
      }

      refreshDerived();
    };

    const finish = (
      finalOutput: string,
      success = true,
      dimOutput?: boolean,
      preformatted?: boolean,
    ) =>
      update({
        output: finalOutput,
        phase: "finished",
        success,
        dimOutput,
        preformatted,
      });

    const fail = (finalOutput: string) =>
      update({
        output: finalOutput,
        phase: "finished",
        success: false,
      });

    return { id, input, update, finish, fail };
  }

  function start(input: string, output: string): CommandHandle {
    const id = createId("cmd");
    const buffers = buffersRef.current;
    upsertCommandLine(buffers, id, input, {
      output,
      phase: "running",
    });
    buffers.order.push(id);
    refreshDerived();

    return getHandle(id, input);
  }

  return { start, getHandle };
}
