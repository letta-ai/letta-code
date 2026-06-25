import type { Backend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ModCompactTrigger, ModContext } from "@/mods/types";

/**
 * Wires the local backend's internal lifecycle (compaction today) into a
 * surface's mod adapter. Compaction is owned by the local backend, so these
 * events only fire for local agents; on any other backend this is a no-op.
 *
 * The backend already guards each hook so a throwing/rejecting emit can never
 * break compaction.
 *
 * Returns a disposer that clears the hooks (a no-op on non-local backends).
 */
export function installLocalBackendModEventHooks(options: {
  backend: Backend;
  adapter: { events: ModAdapter["events"] };
  buildContext: (conversationId: string) => ModContext;
}): () => void {
  const { backend, adapter, buildContext } = options;
  if (!(backend instanceof LocalBackend)) return () => {};

  backend.setModEventHooks({
    onCompactStart: async (info) => {
      await adapter.events.emit(
        "compact_start",
        {
          agentId: info.agentId,
          conversationId: info.conversationId,
          trigger: info.trigger as ModCompactTrigger,
        },
        buildContext(info.conversationId),
      );
    },
    onCompactEnd: async (info) => {
      await adapter.events.emit(
        "compact_end",
        {
          agentId: info.agentId,
          conversationId: info.conversationId,
          trigger: info.trigger as ModCompactTrigger,
          messagesBefore: info.messagesBefore,
          messagesAfter: info.messagesAfter,
          contextTokensBefore: info.contextTokensBefore,
          contextTokensAfter: info.contextTokensAfter,
        },
        buildContext(info.conversationId),
      );
    },
  });

  return () => backend.setModEventHooks(undefined);
}
