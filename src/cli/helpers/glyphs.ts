/**
 * Central registry of CLI display glyphs.
 * Change these once to update every component that renders them.
 */
export const CLI_GLYPHS = {
  /** User input prompt character */
  prompt: "›",
  /** Bullet for assistant/tool/status messages */
  bullet: "•",
  /** Result continuation corner — aligns with continuation bar */
  result: "└",
  /** Multi-line command continuation bar */
  continuation: "│",
} as const;
