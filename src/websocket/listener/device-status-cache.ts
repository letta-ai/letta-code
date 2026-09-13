import type { DeviceStatus } from "@/types/protocol_v2";
import type { ListenerTransport } from "./transport";

type DeviceStatusScope = {
  agent_id?: string | null;
  conversation_id?: string | null;
};

/** Per-transport, per-scope cache naturally released with the transport. */
const lastDeviceStatusByTransport = new WeakMap<
  ListenerTransport,
  Map<string, string>
>();

export function recordDeviceStatus(
  transport: ListenerTransport,
  scope: DeviceStatusScope,
  status: DeviceStatus,
): void {
  shouldEmitDeviceStatus(transport, scope, status, true);
}

export function shouldEmitDeviceStatus(
  transport: ListenerTransport,
  scope: DeviceStatusScope,
  status: DeviceStatus,
  force = false,
): boolean {
  const statusJson = JSON.stringify(status);
  const cacheKey = `${scope.agent_id ?? ""}:${scope.conversation_id ?? ""}`;
  let scopeCache = lastDeviceStatusByTransport.get(transport);
  if (!scopeCache) {
    scopeCache = new Map();
    lastDeviceStatusByTransport.set(transport, scopeCache);
  }
  if (!force && scopeCache.get(cacheKey) === statusJson) {
    return false;
  }
  scopeCache.set(cacheKey, statusJson);
  return true;
}
