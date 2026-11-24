import "@letta-ai/letta-client/resources/agents/messages";
import type { LocalCompactionSummarySource } from "@/backend/local/local-message";

declare module "@letta-ai/letta-client/resources/agents/messages" {
  interface ApprovalCreate {
    // Sent by letta-code for request correlation until the SDK schema includes it.
    otid?: string | null;
  }

  namespace SummaryMessage {
    interface CompactionStats {
      // Reported by the local backend: which request wrote the summary.
      summary_source?: LocalCompactionSummarySource;
    }
  }
}
