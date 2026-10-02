import type {
  ExternalToolDefinitionPayload,
  RuntimeExternalToolsUpdateGroup,
  RuntimeScope,
  RuntimeStartExternalToolsGroup,
} from "@/types/app-server-protocol";
import type {
  ChannelGatewayClient,
  ChannelGatewayToolScopeState,
} from "./gateway-types";
import type { ChannelTurnSource } from "./types";

const RETRY_DELAY_MS = 1000;

function runtimeKey(runtime: RuntimeScope<string | null>): string {
  return `${runtime.agent_id}:${runtime.conversation_id}`;
}

export type GatewayToolScope = ChannelGatewayToolScopeState;

type RuntimeToolState = {
  runtime: RuntimeScope<string | null>;
  scopes: Map<string, GatewayToolScope>;
  desiredUnscoped: readonly RuntimeStartExternalToolsGroup[];
};

export class GatewayRuntimeToolScopes {
  private readonly states = new Map<string, RuntimeToolState>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly client: ChannelGatewayClient) {}

  create(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[],
    automaticRelay: boolean,
    tool: ExternalToolDefinitionPayload | null,
  ): GatewayToolScope {
    const id = `channel-turn-${crypto.randomUUID()}`;
    const scope: GatewayToolScope = {
      id,
      runtime,
      sources: structuredClone(sources),
      automaticRelay,
      ...(tool
        ? { group: { scope_id: id, tools: [structuredClone(tool)] } }
        : {}),
    };
    this.retain(scope);
    return scope;
  }

  retain(scope: GatewayToolScope): void {
    this.getState(scope.runtime).scopes.set(scope.id, scope);
  }

  detach(scope: GatewayToolScope): GatewayToolScope {
    this.states.get(runtimeKey(scope.runtime))?.scopes.delete(scope.id);
    return scope;
  }

  release(scope: GatewayToolScope): void {
    this.states.get(runtimeKey(scope.runtime))?.scopes.delete(scope.id);
  }

  resolve(
    runtime: RuntimeScope<string | null>,
    scopeId: string,
  ): GatewayToolScope | null {
    return this.states.get(runtimeKey(runtime))?.scopes.get(scopeId) ?? null;
  }

  selection(scope: GatewayToolScope): string[] {
    return [scope.id];
  }

  hasRetainedScopes(runtime: RuntimeScope<string | null>): boolean {
    return (this.states.get(runtimeKey(runtime))?.scopes.size ?? 0) > 0;
  }

  registrationGroups(
    runtime: RuntimeScope<string | null>,
    includeUnscoped: boolean,
  ): readonly RuntimeStartExternalToolsGroup[] {
    const state = this.states.get(runtimeKey(runtime));
    if (!state) return [];
    const scoped = [...state.scopes.values()].flatMap((scope) =>
      scope.group ? [scope.group] : [],
    );
    return includeUnscoped ? [...scoped, ...state.desiredUnscoped] : scoped;
  }

  setDesiredUnscoped(
    runtime: RuntimeScope<string | null>,
    groups: readonly RuntimeStartExternalToolsGroup[],
  ): void {
    this.getState(runtime).desiredUnscoped = groups;
  }

  async updateDesiredUnscoped(
    updates: readonly RuntimeExternalToolsUpdateGroup[],
    isBusy: (runtime: RuntimeScope<string | null>) => boolean,
  ): Promise<void> {
    const immediateByTools = new Map<
      string,
      {
        runtimes: RuntimeScope<string | null>[];
        external_tools: readonly RuntimeStartExternalToolsGroup[];
      }
    >();
    for (const update of updates) {
      for (const runtime of update.runtimes) {
        this.getState(runtime).desiredUnscoped = update.external_tools;
        if (!isBusy(runtime)) {
          const externalTools = this.registrationGroups(runtime, true);
          const signature = JSON.stringify(externalTools);
          const existing = immediateByTools.get(signature);
          if (existing) existing.runtimes.push(runtime);
          else
            immediateByTools.set(signature, {
              runtimes: [runtime],
              external_tools: externalTools,
            });
        }
      }
    }
    const immediate = [...immediateByTools.values()];
    if (immediate.length === 0) return;
    const response = await this.client.runtimeExternalToolsUpdate({
      updates: immediate,
    });
    if (!response.success) {
      throw new Error(
        response.error ?? "Failed to update routed runtime tools",
      );
    }
  }

  flushWhenIdle(
    runtime: RuntimeScope<string | null>,
    isBusy: () => boolean,
    schedule: (task: () => Promise<void>) => Promise<void>,
  ): void {
    if (isBusy() || this.closed) return;
    void schedule(async () => {
      if (isBusy()) return;
      const response = await this.client.runtimeExternalToolsUpdate({
        updates: [
          {
            runtimes: [runtime],
            external_tools: this.registrationGroups(runtime, true),
          },
        ],
      });
      if (!response.success) {
        throw new Error(
          response.error ?? "Failed to update routed runtime tools",
        );
      }
    }).catch(() => {
      if (this.closed) return;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.flushWhenIdle(runtime, isBusy, schedule);
      }, RETRY_DELAY_MS);
      timer.unref?.();
      this.retryTimers.add(timer);
    });
  }

  forgetRuntime(runtime: RuntimeScope<string | null>): void {
    this.states.delete(runtimeKey(runtime));
  }

  close(): void {
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.states.clear();
  }

  private getState(runtime: RuntimeScope<string | null>): RuntimeToolState {
    const key = runtimeKey(runtime);
    let state = this.states.get(key);
    if (!state) {
      state = { runtime, scopes: new Map(), desiredUnscoped: [] };
      this.states.set(key, state);
    }
    return state;
  }
}
