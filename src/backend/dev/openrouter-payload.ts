import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

import { isRecord } from "@/utils/type-guards";

export function withOpenRouterDefaultMaxTokensSanitizer(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  enabled: boolean,
): SimpleStreamOptions["onPayload"] | undefined {
  if (!enabled) return existing;
  return async (payload, model) => {
    const upstream = await existing?.(payload, model);
    const next = upstream ?? payload;
    if (!isRecord(next)) return upstream !== undefined ? upstream : undefined;

    let changed = false;
    const sanitized = { ...next };
    for (const key of ["max_tokens", "max_completion_tokens"] as const) {
      if (key in sanitized) {
        delete sanitized[key];
        changed = true;
      }
    }
    return changed ? sanitized : upstream !== undefined ? upstream : undefined;
  };
}
