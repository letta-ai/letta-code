export function createLifecycleMessageBase<TMessageType extends string>(
  messageType: TMessageType,
  runId?: string | null,
): {
  id: string;
  date: string;
  message_type: TMessageType;
  run_id?: string;
} {
  return {
    id: `lifecycle-${crypto.randomUUID()}`,
    date: new Date().toISOString(),
    message_type: messageType,
    ...(runId ? { run_id: runId } : {}),
  };
}
