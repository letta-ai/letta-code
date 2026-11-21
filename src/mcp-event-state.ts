import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import { isRecord } from "@/utils/type-guards";

const checkpoint = z.object({
  cursor: z.string().optional(),
  ids: z.array(z.string()).max(1000),
});

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function openMcpEventState(identity?: unknown[], configDir?: string) {
  const directory =
    identity && join(configDir ?? resolveGlobalConfigDir(), "mcp-event-state");
  const path =
    directory &&
    join(
      directory,
      `${createHash("sha256")
        .update(JSON.stringify(canonical(identity)))
        .digest("hex")}.json`,
    );
  let cursor: string | undefined;
  let ids = new Set<string>();
  if (path) {
    try {
      const saved = checkpoint.parse(JSON.parse(readFileSync(path, "utf8")));
      cursor = saved.cursor;
      ids = new Set(saved.ids);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  function save() {
    if (!path || !directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify({ cursor, ids: [...ids] }), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    cursor: () => cursor ?? null,
    advance(next: string | null) {
      if (cursor === (next ?? undefined)) return;
      cursor = next ?? undefined;
      save();
    },
    seen: (id: string) => ids.has(id),
    mark(id: string) {
      if (ids.has(id)) return;
      ids.add(id);
      const oldest = ids.values().next().value;
      if (ids.size > 1000 && oldest !== undefined) ids.delete(oldest);
      save();
    },
  };
}
