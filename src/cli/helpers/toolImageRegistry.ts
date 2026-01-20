// Registry for images read by tools that need to be sent in the next user message turn.
// This is needed because tool returns only support string content - we can't return
// image data directly in tool results to the Letta API.

export interface QueuedToolImage {
  toolCallId: string;
  filePath: string;
  data: string; // base64
  mediaType: string;
  width: number;
  height: number;
}

const queuedImages: QueuedToolImage[] = [];

/**
 * Queue an image to be sent in the next user message.
 * Called by the Read tool when reading an image file.
 */
export function queueToolImage(image: QueuedToolImage): void {
  queuedImages.push(image);
}

/**
 * Get and clear all queued images.
 * Called when building the user message content.
 */
export function getAndClearQueuedToolImages(): QueuedToolImage[] {
  const images = [...queuedImages];
  queuedImages.length = 0;
  return images;
}

/**
 * Clear all queued images without returning them.
 * Called on conversation/agent switch to prevent memory leaks.
 */
export function clearQueuedToolImages(): void {
  queuedImages.length = 0;
}

/**
 * Check if there are any queued images.
 */
export function hasQueuedToolImages(): boolean {
  return queuedImages.length > 0;
}
