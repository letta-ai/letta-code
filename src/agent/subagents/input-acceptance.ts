import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";

/** Internal child-process setting, never a model-facing Agent argument. */
export const SUBAGENT_INITIAL_INPUT_ENV = "LETTA_SUBAGENT_INITIAL_INPUT";

export interface SubagentInputAcceptance {
  clientMessageId: string;
  onInputAccepted(receipt: EnqueueReceipt): Promise<void>;
}

function initialInput(env: NodeJS.ProcessEnv) {
  const text = env[SUBAGENT_INITIAL_INPUT_ENV];
  if (!text) return undefined;
  const value = JSON.parse(text) as {
    conversationId?: unknown;
    clientMessageId?: unknown;
  };
  if (
    typeof value.conversationId !== "string" ||
    typeof value.clientMessageId !== "string" ||
    !value.clientMessageId
  )
    throw new Error("Invalid subagent initial input configuration");
  return value as { conversationId: string; clientMessageId: string };
}

export function subagentInitialInputId(
  conversationId: string,
  fallback: string,
  env = process.env,
): string {
  const configured = initialInput(env);
  return configured?.conversationId === conversationId
    ? configured.clientMessageId
    : fallback;
}

/** This frame reports a completed Cloud enqueue, never merely a process/link. */
export async function emitSubagentInputAccepted(
  receipt: EnqueueReceipt,
  env = process.env,
  write = (text: string) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(text, (error) =>
        error ? reject(error) : resolve(),
      );
    }),
): Promise<void> {
  const configured = initialInput(env);
  if (
    !configured ||
    configured.conversationId !== receipt.conversation_id ||
    configured.clientMessageId !== receipt.client_message_id
  )
    return;
  await write(
    `${JSON.stringify({ type: "system", subtype: "input_accepted", receipt })}\n`,
  );
}

export function createSubagentInputObserver(
  acceptance?: SubagentInputAcceptance,
) {
  let pending: Promise<void> | undefined;
  return {
    observe(receipt: EnqueueReceipt | null | undefined) {
      if (!acceptance || !receipt || pending) return;
      pending = Promise.resolve().then(() =>
        acceptance.onInputAccepted(receipt),
      );
      // The execution owner awaits this promise before completing the task.
      void pending.catch(() => {});
    },
    async finish() {
      await pending;
    },
  };
}
