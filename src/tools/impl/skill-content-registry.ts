interface QueuedSkillContent {
  toolCallId: string;
  content: string;
}

let queuedContent: QueuedSkillContent[] = [];

export function queueSkillContent(toolCallId: string, content: string): void {
  queuedContent.push({ toolCallId, content });
}

export function consumeQueuedSkillContent(): QueuedSkillContent[] {
  const consumed = queuedContent;
  queuedContent = [];
  return consumed;
}
