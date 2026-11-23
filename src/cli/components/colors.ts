import {
  getTerminalBackgroundColor,
  getTerminalTheme,
  type TerminalRgb,
} from "@/cli/helpers/terminal-theme";

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: TerminalRgb): string {
  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isLightRgb({ r, g, b }: TerminalRgb): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b > 128;
}

function blendRgb(
  fg: TerminalRgb,
  bg: TerminalRgb,
  alpha: number,
): TerminalRgb {
  return {
    r: Math.floor(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.floor(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.floor(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

function getCodexUserMessageBackground(): string {
  const theme = getTerminalTheme();
  const terminalBg =
    getTerminalBackgroundColor() ??
    (theme === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 });
  const overlay = isLightRgb(terminalBg)
    ? { color: { r: 0, g: 0, b: 0 }, alpha: 0.04 }
    : { color: { r: 255, g: 255, b: 255 }, alpha: 0.12 };

  return rgbToHex(blendRgb(overlay.color, terminalBg, overlay.alpha));
}

export function hexToBgAnsi(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export function hexToFgAnsi(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export const brandColors = {
  orange: "#FF5533",
  blue: "#0707AC",
  primaryAccent: "#8C8CF9",
  primaryAccentLight: "#BEBEEE",
  textMain: "#DEE1E4",
  textSecondary: "#A5A8AB",
  textDisabled: "#46484A",
  statusSuccess: "#64CF64",
  statusWarning: "#FEE19C",
  statusError: "#F1689F",
} as const;

export const brandColorsLight = {
  orange: "#FF5533",
  blue: "#0707AC",
  primaryAccent: "#3939BD",
  primaryAccentLight: "#A9A9DE",
  textMain: "#202020",
  textSecondary: "#797B7D",
  textDisabled: "#A5A8AB",
  statusSuccess: "#28A428",
  statusWarning: "#B98813",
  statusError: "#BA024C",
} as const;

const _colors = {
  welcome: {
    border: brandColors.primaryAccent,
    accent: brandColors.primaryAccent,
  },

  selector: {
    border: brandColors.primaryAccentLight,
    title: brandColors.primaryAccentLight,
    itemHighlighted: brandColors.primaryAccent,
    itemCurrent: brandColors.statusSuccess,
  },

  command: {
    selected: brandColors.primaryAccent,
    inactive: brandColors.textDisabled,
    border: brandColors.textDisabled,
    running: brandColors.textSecondary,
    error: brandColors.statusError,
  },

  approval: {
    border: brandColors.primaryAccentLight,
    header: brandColors.primaryAccent,
  },

  code: {
    inline: "green",
  },

  link: {
    text: brandColors.primaryAccentLight,
    url: brandColors.primaryAccent,
  },

  heading: {
    primary: "cyan",
    secondary: brandColors.primaryAccent,
  },

  status: {
    error: brandColors.statusError,
    success: brandColors.statusSuccess,
    interrupt: brandColors.statusError,
    processing: brandColors.primaryAccent,
    processingShimmer: brandColors.primaryAccentLight,
  },

  tool: {
    pending: brandColors.textSecondary,
    completed: brandColors.statusSuccess,
    streaming: brandColors.textSecondary,
    running: brandColors.textSecondary,
    error: brandColors.statusError,
    memoryName: brandColors.primaryAccent,
  },

  input: {
    border: brandColors.textDisabled,
    prompt: brandColors.textMain,
  },

  bash: {
    prompt: brandColors.statusError,
    border: brandColors.statusError,
    dot: brandColors.statusError,
  },

  shellSyntaxDark: {
    prompt: "#cba6f7",
    text: "#cdd6f4",
    comment: "#6c7086",
    keyword: "#89b4fa",
    string: "#a6e3a1",
    number: "#fab387",
    literal: "#fab387",
    builtIn: "#f9e2af",
    variable: "#f5c2e7",
    title: "#94e2d5",
    attr: "#74c7ec",
    operator: "#bac2de",
    punctuation: "#bac2de",
    meta: "#f38ba8",
    substitution: "#f5c2e7",
  },
  shellSyntaxLight: {
    prompt: "#8839ef",
    text: "#4c4f69",
    comment: "#9ca0b0",
    keyword: "#1e66f5",
    string: "#40a02b",
    number: "#fe640b",
    literal: "#fe640b",
    builtIn: "#df8e1d",
    variable: "#ea76cb",
    title: "#179299",
    attr: "#209fb5",
    operator: "#5c5f77",
    punctuation: "#5c5f77",
    meta: "#d20f39",
    substitution: "#e64553",
  },

  todo: {
    completed: brandColors.primaryAccent,
    inProgress: brandColors.primaryAccent,
  },

  subagent: {
    header: brandColors.primaryAccent,
    running: brandColors.statusWarning,
    completed: brandColors.statusSuccess,
    error: brandColors.statusError,
    treeChar: brandColors.textSecondary,
    hint: "#808080",
  },

  bgSubagent: {
    label: "#87af87",
    spinner: "#5faf5f",
  },

  info: {
    border: brandColors.primaryAccent,
    prompt: brandColors.primaryAccent,
  },

  diff: {
    addedLineBg: "#213A2B",
    removedLineBg: "#4A221D",
    contextLineBg: undefined,
    addedWordBg: "#2d7a2d",
    removedWordBg: "#7a2d2d",
    textOnDark: "white",
    textOnHighlight: "white",
    symbolAdd: "green",
    symbolRemove: "red",
    symbolContext: undefined,
  },

  error: {
    border: "red",
    text: "red",
  },

  text: {
    normal: "white",
    dim: "gray",
    bold: "white",
  },

  footer: {
    agentName: brandColors.primaryAccent,
  },

  contextBreakdown: {
    system: "#E07050",
    coreMemory: "#E0A040",
    tools: "#20B2AA",
    messages: "#8C8CF9",
    summaryMemory: "#D0B060",
    other: "#A0A0A0",
  },
} as const;

export const colors = {
  ..._colors,

  get shellSyntax() {
    return getTerminalTheme() === "light"
      ? _colors.shellSyntaxLight
      : _colors.shellSyntaxDark;
  },

  get userMessage() {
    return {
      background: getCodexUserMessageBackground(),
      text: undefined,
    };
  },
};
