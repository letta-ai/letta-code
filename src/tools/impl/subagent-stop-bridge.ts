import type {
  SubagentStopCommand,
  SubagentStopResponse,
} from "@/types/subagent-protocol";

type Stop = (
  command: SubagentStopCommand,
) => Promise<SubagentStopResponse> | undefined;
const owners = new Map<string, Stop>();

/** An in-process listener can handle its own child's stop without a relay. */
export function registerLocalSubagentStop(
  connectionId: string,
  stop: Stop,
): () => void {
  owners.set(connectionId, stop);
  return () => {
    if (owners.get(connectionId) === stop) owners.delete(connectionId);
  };
}

export function stopLocalSubagent(
  connectionId: string,
  command: SubagentStopCommand,
): Promise<SubagentStopResponse> | undefined {
  return owners.get(connectionId)?.(command);
}
