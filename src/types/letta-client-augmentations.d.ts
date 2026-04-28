import "@letta-ai/letta-client/resources/agents/messages";

declare module "@letta-ai/letta-client/resources/agents/messages" {
  interface ApprovalCreate {
    // Sent by letta-code for request correlation until the SDK schema includes it.
    otid?: string | null;
  }
}
