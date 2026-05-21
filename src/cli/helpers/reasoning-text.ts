export function trimFinishedReasoningText(text: string): string {
  return text.replace(/\n+$/g, "");
}
