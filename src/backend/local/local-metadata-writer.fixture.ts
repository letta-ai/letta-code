import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Independent-process fixture. Only scheduling and observation are patched;
// the backend, persisted reads, append implementation and lock are real.
const [directory, kind, id, tag, ready, release, contending] =
  process.argv.slice(2) as string[];
if (!directory || !kind || !id || !tag || !ready || !release || !contending)
  throw new Error("Missing writer arguments");
if (tag === "second") {
  const fs = require("node:fs/promises");
  const open = fs.open;
  fs.open = async (...args: unknown[]) => {
    try {
      return await open(...args);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        String(args[0]).endsWith(".lock")
      )
        writeFileSync(contending, "waiting");
      throw error;
    }
  };
  syncBuiltinESMExports();
}
const { HeadlessBackend } = await import("@/backend/dev/fake-headless-backend");
const backend = new HeadlessBackend("agent-test", undefined, {
  storageDir: directory,
});
const store = Reflect.get(backend, "store");
if (tag === "first") {
  const method =
    kind === "agent"
      ? "refreshAgentRecordFromStorage"
      : "refreshConversationRecordFromStorage";
  const original = store[method].bind(store);
  let held = false;
  store[method] = (...args: unknown[]) => {
    const record = original(...args);
    if (!held && record) {
      held = true;
      writeFileSync(ready, "read");
      const deadline = Date.now() + 10_000;
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error("Release gate timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return record;
  };
}
if (kind === "agent") await backend.updateAgent(id, { tags_to_add: [tag] });
else await backend.updateConversation(id, { tags_to_add: [tag] });
