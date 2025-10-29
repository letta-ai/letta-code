/**
 * Letta Code Color System
 *
 * This file defines all colors used in the application.
 * No colors should be hardcoded in components - all should reference this file.
 */

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
  statusWarning: "FEE19C", // yellow
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
export const colors = {
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
    running: brandColors.statusWarning,
    error: brandColors.statusError,
  },

  // Approval/HITL screens
  approval: {
    border: brandColors.primaryAccentLight,
    header: brandColors.primaryAccent,
  },

  // Code and markdown elements
  code: {
    inline: brandColors.statusSuccess,
  },

  link: {
    text: brandColors.primaryAccent,
    url: brandColors.primaryAccent,
  },

  heading: {
    primary: brandColors.primaryAccent,
    secondary: brandColors.blue,
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
    streaming: brandColors.textDisabled, // solid gray dot (streaming/in progress)
    running: brandColors.statusWarning, // blinking yellow dot (executing)
    error: brandColors.statusError, // solid red dot (failed)
  },

  // Input box
  input: {
    border: brandColors.textDisabled,
    prompt: brandColors.textMain,
  },

  // Todo list
  todo: {
    completed: brandColors.blue,
    inProgress: brandColors.primaryAccent,
  },

  // Info/modal views
  info: {
    border: brandColors.primaryAccent,
    prompt: "blue",
  },

  // Diff rendering
  diff: {
    addedLineBg: "#1a4d1a",
    addedWordBg: "#2d7a2d",
    removedLineBg: "#4d1a1a",
    removedWordBg: "#7a2d2d",
    contextLineBg: undefined,
    textOnDark: "white",
    textOnHighlight: "black",
    symbolAdd: "green",
    symbolRemove: "red",
    symbolContext: undefined,
  },

  // Error display
  error: brandColors.statusError,
  errorBox: {
    border: "red",
    text: "red",
  },

  // Generic text colors (used with dimColor prop or general text)
  text: {
    normal: "white",
    dim: "gray",
    bold: "white",
  },
} as const;
