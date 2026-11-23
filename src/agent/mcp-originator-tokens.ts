import { registerMcpOriginatorTokenResolver } from "@/backend/api/mcp-originator-resolver";
import {
  admitMcpOriginatorDelivery,
  markMcpOriginatorHeaderless,
  markMcpOriginatorTerminal,
  mcpOriginatorAuthorityPermitsUse,
} from "./mcp-originator-authority";
import {
  startMcpOriginatorKeepalive,
  stopAllMcpOriginatorKeepalives,
  stopMcpOriginatorKeepalive,
} from "./mcp-originator-keepalive";

type McpOriginatorTokenEntry = {
  token: string | null;
  generation?: number;
};

const entriesBySuperRunId = new Map<string, McpOriginatorTokenEntry>();

export function getMcpOriginatorToken(
  superRunId: string | null | undefined,
): string | undefined {
  if (!superRunId) return undefined;
  const entry = entriesBySuperRunId.get(superRunId);
  if (!entry || entry.token === null) return undefined;
  if (!mcpOriginatorAuthorityPermitsUse(superRunId, entry.generation)) {
    deleteMcpOriginatorToken(superRunId);
    return undefined;
  }
  return entry.token;
}

registerMcpOriginatorTokenResolver(getMcpOriginatorToken);

export function setMcpOriginatorToken(superRunId: string, token: string): void {
  entriesBySuperRunId.set(superRunId, { token });
  startMcpOriginatorKeepalive(superRunId, keepaliveHooks(superRunId));
}

export function deleteMcpOriginatorToken(superRunId: string): void {
  entriesBySuperRunId.delete(superRunId);
  stopMcpOriginatorKeepalive(superRunId);
}

function keepaliveHooks(superRunId: string): {
  getToken: () => string | undefined;
  withdraw: () => void;
} {
  return {
    getToken: () => getMcpOriginatorToken(superRunId),
    withdraw: () => deleteMcpOriginatorToken(superRunId),
  };
}

export function clearMcpOriginatorTokens(): void {
  entriesBySuperRunId.clear();
  stopAllMcpOriginatorKeepalives();
}

export function mcpOriginatorTokenCount(): number {
  let count = 0;
  for (const entry of entriesBySuperRunId.values()) {
    if (entry.token !== null) count += 1;
  }
  return count;
}

export type McpOriginatorParsedDelivery = {
  superRunId?: string;
  token?: string;
  generation?: number;
  malformedGeneration?: boolean;
};

export function readMcpOriginatorDelivery(
  payload: unknown,
): McpOriginatorParsedDelivery {
  const wire =
    typeof payload === "object" && payload !== null
      ? (payload as {
          super_run_id?: unknown;
          mcp_originator_token?: unknown;
          mcp_originator_generation?: unknown;
        })
      : {};
  const superRunId =
    typeof wire.super_run_id === "string" && wire.super_run_id.length > 0
      ? wire.super_run_id
      : undefined;
  const token =
    typeof wire.mcp_originator_token === "string" &&
    wire.mcp_originator_token.length > 0
      ? wire.mcp_originator_token
      : undefined;
  const generation =
    typeof wire.mcp_originator_generation === "number" &&
    Number.isInteger(wire.mcp_originator_generation) &&
    wire.mcp_originator_generation >= 0 &&
    Number.isSafeInteger(wire.mcp_originator_generation)
      ? wire.mcp_originator_generation
      : undefined;
  return {
    ...(superRunId ? { superRunId } : {}),
    ...(token ? { token } : {}),
    ...(generation !== undefined ? { generation } : {}),
    ...(wire.mcp_originator_generation !== undefined && generation === undefined
      ? { malformedGeneration: true as const }
      : {}),
  };
}

function deliveryIsAtLeastAsNew(
  existing: McpOriginatorTokenEntry,
  incomingGeneration: number | undefined,
): boolean {
  if (existing.generation === undefined) return true;
  if (incomingGeneration === undefined) return false;
  return incomingGeneration >= existing.generation;
}

export type McpOriginatorDeliveryVerdict =
  | "admitted"
  | "denied_retryable"
  | "denied_permanent"
  | "none";

function denyMalformedGeneration(
  frame: unknown,
  delivery: McpOriginatorParsedDelivery,
  context: string,
): "denied_permanent" {
  const rawGeneration = (frame as { mcp_originator_generation?: unknown })
    ?.mcp_originator_generation;
  console.error(
    `[MCP originator] run ${delivery.superRunId}: ${context}denying delivery with malformed generation (type=${typeof rawGeneration}${
      typeof rawGeneration === "string" ? ` length=${rawGeneration.length}` : ""
    })`,
  );
  return "denied_permanent";
}

export function installPreGatedMcpOriginatorDelivery(
  delivery: McpOriginatorParsedDelivery,
  options?: { allowCreate?: boolean; mayRecreateOwner?: () => boolean },
): void {
  if (!delivery.superRunId || delivery.malformedGeneration) return;
  const existing = entriesBySuperRunId.get(delivery.superRunId);
  if (delivery.token) {
    if (existing) {
      if (!deliveryIsAtLeastAsNew(existing, delivery.generation)) return;
    } else if (
      options?.allowCreate === false &&
      options?.mayRecreateOwner?.() !== true
    ) {
      return;
    }
    entriesBySuperRunId.set(delivery.superRunId, {
      token: delivery.token,
      ...(delivery.generation !== undefined
        ? { generation: delivery.generation }
        : existing?.generation !== undefined
          ? { generation: existing.generation }
          : {}),
    });
    startMcpOriginatorKeepalive(
      delivery.superRunId,
      keepaliveHooks(delivery.superRunId),
    );
    return;
  }
  if (!existing) return;
  if (!deliveryIsAtLeastAsNew(existing, delivery.generation)) return;
  entriesBySuperRunId.set(delivery.superRunId, {
    token: null,
    ...(delivery.generation !== undefined
      ? { generation: delivery.generation }
      : existing.generation !== undefined
        ? { generation: existing.generation }
        : {}),
  });
  stopMcpOriginatorKeepalive(delivery.superRunId);
}

export function recordMcpOriginatorDelivery(
  frame: unknown,
  options?: { allowCreate?: boolean; mayRecreateOwner?: () => boolean },
): McpOriginatorDeliveryVerdict {
  const delivery = readMcpOriginatorDelivery(frame);
  if (!delivery.superRunId) return "none";
  if (delivery.malformedGeneration) {
    return denyMalformedGeneration(frame, delivery, "");
  }
  const admission = admitMcpOriginatorDelivery(
    delivery.superRunId,
    delivery.generation,
  );
  if (!admission.admitted) {
    return admission.permanent ? "denied_permanent" : "denied_retryable";
  }
  installPreGatedMcpOriginatorDelivery(delivery, options);
  return "admitted";
}

export function gateMcpOriginatorDeliveryAdmission(frame: unknown): {
  verdict: McpOriginatorDeliveryVerdict;
  delivery?: McpOriginatorParsedDelivery;
} {
  const delivery = readMcpOriginatorDelivery(frame);
  if (!delivery.superRunId) return { verdict: "none" };
  if (delivery.malformedGeneration) {
    return {
      verdict: denyMalformedGeneration(frame, delivery, "pre-commit gate "),
    };
  }
  const admission = admitMcpOriginatorDelivery(
    delivery.superRunId,
    delivery.generation,
  );
  if (!admission.admitted) {
    return {
      verdict: admission.permanent ? "denied_permanent" : "denied_retryable",
    };
  }
  return { verdict: "admitted", delivery };
}

export function retireMcpOriginatorTokensOnOriginSwap(
  turnSuperRunId: string | null | undefined,
  queuedSuperRunId: string | null | undefined,
): void {
  if (queuedSuperRunId === turnSuperRunId) return;
  for (const runId of [turnSuperRunId, queuedSuperRunId]) {
    if (!runId) continue;
    const generation = entriesBySuperRunId.get(runId)?.generation;
    if (markMcpOriginatorHeaderless(runId, generation)) {
      deleteMcpOriginatorToken(runId);
    } else {
      console.error(
        `[mcp-originator-tokens] headerless mark for ${runId} is NOT durable; keeping the volatile entry (unusable in this process) so restart cannot resurrect authority`,
      );
    }
  }
}

export function retireMcpOriginatorTokenOnTerminal(
  superRunId: string | null | undefined,
): void {
  if (!superRunId) return;
  const generation = entriesBySuperRunId.get(superRunId)?.generation;
  if (markMcpOriginatorTerminal(superRunId, generation)) {
    deleteMcpOriginatorToken(superRunId);
  } else {
    console.error(
      `[mcp-originator-tokens] terminal mark for ${superRunId} is NOT durable; keeping the volatile entry (unusable in this process) so restart cannot resurrect authority`,
    );
  }
}

export function retireMcpOriginatorTokenOnMixedMerge(
  superRunId: string | null | undefined,
): void {
  if (!superRunId) return;
  const generation = entriesBySuperRunId.get(superRunId)?.generation;
  if (markMcpOriginatorHeaderless(superRunId, generation)) {
    deleteMcpOriginatorToken(superRunId);
  } else {
    console.error(
      `[mcp-originator-tokens] mixed-merge headerless mark for ${superRunId} is NOT durable; keeping the volatile entry (unusable in this process) so restart cannot resurrect authority`,
    );
  }
}
