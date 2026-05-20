/**
 * Side-channel registry for skill content injection.
 *
 * When the Skill tool reads a SKILL.md file, it queues the content here.
 * The harness (App.tsx / headless.ts) consumes the queue after tool execution
 * and injects the content as a user message part alongside the tool result.
 *
 * This pattern matches toolImageRegistry.ts - tools return strings only,
 * rich content is queued and injected at the harness level.
 */

interface QueuedSkillContent {
  toolCallId: string;
  content: string;
}

let queuedContent: QueuedSkillContent[] = [];

/**
 * Queue skill content for injection by the harness.
 * Called by the Skill tool handler after reading SKILL.md.
 */
export function queueSkillContent(toolCallId: string, content: string): void {
  queuedContent.push({ toolCallId, content });
}

/**
 * Consume all queued skill content.
 * Returns the queue and clears it. Order is preserved (push order = execution order).
 */
export function consumeQueuedSkillContent(): QueuedSkillContent[] {
  const consumed = queuedContent;
  queuedContent = [];
  return consumed;
}
