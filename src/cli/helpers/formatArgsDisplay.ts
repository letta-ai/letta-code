// Utility to format tool argument JSON strings into a concise display label
// Copied from old letta-code repo to preserve exact formatting behavior

// Small helpers
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function formatArgsDisplay(argsJson: string): {
  display: string;
  parsed: Record<string, unknown>;
} {
  let parsed: Record<string, unknown> = {};
  let display = "…";
  try {
    if (argsJson?.trim()) {
      const p = JSON.parse(argsJson);
      if (isRecord(p)) {
        // Drop noisy keys for display
        const clone: Record<string, unknown> = { ...p } as Record<
          string,
          unknown
        >;
        if ("request_heartbeat" in clone) delete clone.request_heartbeat;
        parsed = clone;
        const keys = Object.keys(parsed);
        const firstKey = keys[0];
        if (
          keys.length === 1 &&
          firstKey &&
          ["query", "path", "file_path", "command", "label"].includes(firstKey)
        ) {
          const v = parsed[firstKey];
          display = typeof v === "string" ? v : String(v);
        } else {
          display = Object.entries(parsed)
            .map(([k, v]) => {
              if (v === undefined || v === null) return `${k}=${v}`;
              if (typeof v === "boolean" || typeof v === "number")
                return `${k}=${v}`;
              if (typeof v === "string")
                return v.length > 50 ? `${k}=…` : `${k}="${v}"`;
              if (Array.isArray(v)) return `${k}=[${v.length} items]`;
              if (typeof v === "object")
                return `${k}={${Object.keys(v as Record<string, unknown>).length} props}`;
              const str = JSON.stringify(v);
              return str.length > 50 ? `${k}=…` : `${k}=${str}`;
            })
            .join(", ");
        }
      }
    }
  } catch {
    // Fallback: try to extract common keys without full JSON parse
    try {
      const s = argsJson || "";
      const fp = /"file_path"\s*:\s*"([^"]+)"/.exec(s);
      const old = /"old_string"\s*:\s*"([\s\S]*?)"\s*(,|\})/.exec(s);
      const neu = /"new_string"\s*:\s*"([\s\S]*?)"\s*(,|\})/.exec(s);
      const cont = /"content"\s*:\s*"([\s\S]*?)"\s*(,|\})/.exec(s);
      const parts: string[] = [];
      if (fp) parts.push(`file_path="${fp[1]}"`);
      if (old) parts.push(`old_string=…`);
      if (neu) parts.push(`new_string=…`);
      if (cont) parts.push(`content=…`);
      if (parts.length) display = parts.join(", ");
    } catch {
      // If all else fails, use the ellipsis
    }
  }
  return { display, parsed };
}
