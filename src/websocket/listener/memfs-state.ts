import type { ListenerRuntime } from "./types";

export function createListenerMemfsState(): {
  memfsSyncedAgents: Map<string, Promise<boolean>>;
  memfsDisabledAgents: Set<string>;
} {
  return {
    memfsSyncedAgents: new Map(),
    memfsDisabledAgents: new Set(),
  };
}

export function clearListenerMemfsState(
  runtime: Pick<ListenerRuntime, "memfsSyncedAgents" | "memfsDisabledAgents">,
): void {
  runtime.memfsSyncedAgents.clear();
  runtime.memfsDisabledAgents?.clear();
}

export function isListenerMemfsDisabled(
  runtime: Pick<ListenerRuntime, "memfsDisabledAgents">,
  agentId: string,
): boolean {
  return runtime.memfsDisabledAgents?.has(agentId) === true;
}

export function disableListenerMemfsForAgent(
  runtime: Pick<ListenerRuntime, "memfsSyncedAgents" | "memfsDisabledAgents">,
  agentId: string,
): void {
  runtime.memfsSyncedAgents.delete(agentId);
  runtime.memfsDisabledAgents?.add(agentId);
}

export function enableListenerMemfsForAgent(
  runtime: Pick<ListenerRuntime, "memfsDisabledAgents">,
  agentId: string,
): void {
  runtime.memfsDisabledAgents?.delete(agentId);
}
