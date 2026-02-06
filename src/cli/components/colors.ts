/**
 * Letta Code Color System
 *
 * This file defines all colors used in the application.
 * No colors should be hardcoded in components - all should reference this file.
 */

import { getTerminalTheme } from "../helpers/terminalTheme";

/**
 * Parse a hex color (#RRGGBB) to RGB components.
 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Convert a hex color (#RRGGBB) to an ANSI 24-bit background escape sequence.
 */
export function hexToBgAnsi(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Convert a hex color (#RRGGBB) to an ANSI 24-bit foreground escape sequence.
 */
export function hexToFgAnsi(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

// Brand colors (dark mode)
export const brandColors = {
  orange: "#FF5533", // dark orange
  blue: "#0707AC", // dark blue
  // text colors
  primaryAccent: "#8C8CF9", // lighter blue
  primaryAccentLight: "#BEBEEE", // even lighter blue
  textMain: "#DEE1E4", // white
  textSecondary: "#A5A8AB", // light grey
  textDisabled: "#46484A", // dark grey
  // status colors
  statusSuccess: "#64CF64", // green
  statusWarning: "#FEE19C", // yellow
  statusError: "#F1689F", // red
} as const;

// Brand colors (light mode)
export const brandColorsLight = {
  orange: "#FF5533", // dark orange
  blue: "#0707AC", // dark blue
  // text colors
  primaryAccent: "#3939BD", // lighter blue
  primaryAccentLight: "#A9A9DE", // even lighter blue
  textMain: "#202020", // white
  textSecondary: "#797B7D", // light grey
  textDisabled: "#A5A8AB", // dark grey
  // status colors
  statusSuccess: "#28A428", // green
  statusWarning: "#B98813", // yellow
  statusError: "#BA024C", // red
} as const;

// Semantic color system
const _colors = {
  // Welcome screen
  welcome: {
    border: brandColors.primaryAccent,
    accent: brandColors.primaryAccent,
  },

  // Selector boxes (model, agent, generic select)
  selector: {
    border: brandColors.primaryAccentLight,
    title: brandColors.primaryAccentLight,
    itemHighlighted: brandColors.primaryAccent,
    itemCurrent: brandColors.statusSuccess, // for "(current)" label
  },

  // Command autocomplete and command messages
  command: {
    selected: brandColors.primaryAccent,
    inactive: brandColors.textDisabled, // uses dimColor prop
    border: brandColors.textDisabled,
    running: brandColors.textSecondary,
    error: brandColors.statusError,
  },

  // Approval/HITL screens
  approval: {
    border: brandColors.primaryAccentLight,
    header: brandColors.primaryAccent,
  },

  // Code and markdown elements (use terminal theme colors)
  code: {
    inline: "green",
  },

  link: {
    text: "cyan",
    url: brandColors.primaryAccent,
  },

  heading: {
    primary: "cyan",
    secondary: brandColors.primaryAccent,
  },

  // Status indicators
  status: {
    error: brandColors.statusError,
    success: brandColors.statusSuccess,
    interrupt: brandColors.statusError,
    processing: brandColors.primaryAccent, // base text color
    processingShimmer: brandColors.primaryAccentLight, // shimmer highlight
  },

  // Tool calls
  tool: {
    pending: brandColors.textSecondary, // blinking dot (ready/waiting for approval)
    completed: brandColors.statusSuccess, // solid green dot (finished successfully)
    streaming: brandColors.textSecondary, // solid gray dot (streaming/in progress)
    running: brandColors.textSecondary, // blinking gray dot (executing)
    error: brandColors.statusError, // solid red dot (failed)
    memoryName: brandColors.primaryAccent, // memory tool name highlight (matches thinking spinner)
  },

  // Input box
  input: {
    border: brandColors.textDisabled,
    prompt: brandColors.textMain,
  },

  // Bash mode
  bash: {
    prompt: brandColors.statusError, // Red ! prompt
    border: brandColors.statusError, // Red horizontal bars
    dot: brandColors.statusError, // Red dot in output
  },

  // Todo list
  todo: {
    completed: brandColors.primaryAccent, // Same blue as in-progress, with strikethrough
    inProgress: brandColors.primaryAccent,
  },

  // Subagent display
  subagent: {
    header: brandColors.primaryAccent,
    running: brandColors.statusWarning,
    completed: brandColors.statusSuccess,
    error: brandColors.statusError,
    treeChar: brandColors.textSecondary,
    hint: "#808080", // Grey to match Ink's dimColor
  },

  // Info/modal views
  info: {
    border: brandColors.primaryAccent,
    prompt: brandColors.primaryAccent,
  },

  // Diff rendering
  diff: {
    addedLineBg: "#1a4d1a",
    addedWordBg: "#2d7a2d",
    removedLineBg: "#4d1a1a",
    removedWordBg: "#7a2d2d",
    contextLineBg: undefined,
    textOnDark: "white",
    textOnHighlight: "white",
    symbolAdd: "green",
    symbolRemove: "red",
    symbolContext: undefined,
  },

  // Error display
  error: {
    border: "red",
    text: "red",
  },

  // Generic text colors (used with dimColor prop or general text)
  text: {
    normal: "white",
    dim: "gray",
    bold: "white",
  },

  // Footer bar
  footer: {
    agentName: brandColors.primaryAccent,
  },

  // Context window breakdown categories
  contextBreakdown: {
    system: "#9070D0", // deep purple
    coreMemory: "#E0A040", // amber
    tools: "#40C8C8", // turquoise
    messages: "#E07050", // coral-red
    summaryMemory: "#70D080", // green
    other: "#D0B060", // gold
  },
} as const;

// Combine static colors with theme-aware dynamic properties
export const colors = {
  ..._colors,

  // User messages (past prompts) - theme-aware background
  // Uses getter to read theme at render time (after async init)
  get userMessage() {
    const theme = getTerminalTheme();
    return {
      background: theme === "light" ? "#dcddf2" : "#2d2d2d", // light purple for light, subtle gray for dark
      text: undefined, // use default terminal text color
    };
  },
};
