// Import useInput from vendored Ink for bracketed paste support

import { EventEmitter } from "node:events";
import { stdin } from "node:process";
import chalk from "chalk";
import { Box, useInput } from "ink";
import Link from "ink-link";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import stringWidth from "string-width";
import type { ModelReasoningEffort } from "@/agent/model";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { bytesToTokens, formatCompact } from "@/cli/helpers/format";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { formatGoalStatusIndicator } from "@/cli/helpers/goal-command";
import { shouldHideReasoningForModelDisplay } from "@/cli/helpers/startup-model-display";
import { getRandomThinkingTip } from "@/cli/helpers/thinking-messages";
import {
  ELAPSED_DISPLAY_THRESHOLD_MS,
  TOKEN_DISPLAY_THRESHOLD,
} from "@/constants";
import type { PermissionMode } from "@/permissions/mode";
import { permissionMode } from "@/permissions/mode";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import { settingsManager } from "@/settings-manager";
import type { QueuedMessage } from "@/utils/message-queue-bridge";
import { colors } from "./colors";
import { InputAssist } from "./InputAssist";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { ProductStatusRow } from "./ProductStatusRow";
import { QueuedMessages } from "./QueuedMessages";
import { ShimmerText } from "./ShimmerText";
import {
  contextTierFromRatio,
  spinnerWidthForTier,
} from "./spinners/animations.js";
import { StreamingStatusSpinner } from "./spinners/StreamingStatusSpinner.js";
import { Text } from "./Text";

// Window for double-escape to clear input
const ESC_CLEAR_WINDOW_MS = 2500;
const FOOTER_WIDTH_STREAMING_DELTA = 2;
const EMPTY_COMPOSER_PROMPT_ROTATION_MS = 6000;
const EMPTY_COMPOSER_PROMPT_HINTS = [
  'Try "help me understand this codebase"',
  'Try "help me organize my desktop"',
  'Try "debug this error"',
  'Try "explain what this function does"',
  'Try "review this pull request"',
];

function truncateEnd(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function getReasoningEffortTag(
  effort: ModelReasoningEffort | null | undefined,
): string | null {
  if (effort === "none") return null;
  if (effort === "xhigh") return "xhigh";
  if (effort === "max") return "max";
  if (effort === "minimal") return "minimal";
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  return null;
}

/**
 * Represents a visual line segment in the text.
 * A visual line ends at either a newline character or when it reaches lineWidth.
 */
interface VisualLine {
  start: number; // Start index in text
  end: number; // End index (exclusive, not including \n)
}

/**
 * Computes visual lines from text, accounting for both hard breaks (\n)
 * and soft wrapping at lineWidth.
 */
function getVisualLines(text: string, lineWidth: number): VisualLine[] {
  const lines: VisualLine[] = [];
  let lineStart = 0;

  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    const lineLength = i - lineStart;

    if (char === "\n" || i === text.length) {
      // Hard break or end of text
      lines.push({ start: lineStart, end: i });
      lineStart = i + 1;
    } else if (lineLength >= lineWidth && lineWidth > 0) {
      // Soft wrap - line is full
      lines.push({ start: lineStart, end: i });
      lineStart = i;
    }
  }

  // Ensure at least one line for empty text
  if (lines.length === 0) {
    lines.push({ start: 0, end: 0 });
  }

  return lines;
}

/**
 * Finds which visual line the cursor is on and the column within that line.
 */
function findCursorLine(
  cursorPos: number,
  visualLines: VisualLine[],
): { lineIndex: number; column: number } {
  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i];
    if (line && cursorPos >= line.start && cursorPos <= line.end) {
      return { lineIndex: i, column: cursorPos - line.start };
    }
  }
  // Fallback to last line
  const lastLine = visualLines[visualLines.length - 1];
  return {
    lineIndex: visualLines.length - 1,
    column: Math.max(0, cursorPos - (lastLine?.start ?? 0)),
  };
}

// Combined regex for ANSI colors (256-color and 24-bit) and OSC 8 hyperlinks
// Captures: p1[;p2[;p3[;p4[;p5]]]]m
// 256-color fg: 38;5;N     → p1=38, p2=5,  p3=N
// 256-color bg: 48;5;N     → p1=48, p2=5,  p3=N
// 24-bit fg:    38;2;R;G;B → p1=38, p2=2,  p3=R, p4=G, p5=B
// 24-bit bg:    48;2;R;G;B → p1=48, p2=2,  p3=R, p4=G, p5=B
// Reset:        0m         → p1=0
// OSC 8: \x1b]8;;URL\x1b\DISPLAY\x1b]8;;\x1b\
const COMBINED_STYLE_REGEX =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape sequences require control characters
  /\x1b\[(\d+)(?:;(\d+)(?:;(\d+)(?:;(\d+)(?:;(\d+))?)?)?)?m|\x1b\]8;;([^\x1b]*)\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g;

// 256-color palette lookup (simplified - standard xterm colors 0-255)
// Returns hex color for palette index
function get256Color(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined;

  // Standard 16 colors (0-15)
  const standardColors = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];
  if (index < 16) return standardColors[index];

  // 216 color cube (16-231): 6x6x6 cube
  if (index < 232) {
    const cubeIndex = index - 16;
    const r = Math.floor(cubeIndex / 36) % 6;
    const g = Math.floor(cubeIndex / 6) % 6;
    const b = cubeIndex % 6;
    // Convert 0-5 to 0-255 range (0, 95, 135, 175, 215, 255)
    const values = [0, 95, 135, 175, 215, 255];
    const toHex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${toHex(values[r] ?? 0)}${toHex(values[g] ?? 0)}${toHex(values[b] ?? 0)}`;
  }

  // Grayscale (232-255): 24 shades from black to white
  const grayValue = 8 + (index - 232) * 10;
  const hex = grayValue.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

function parseStyledLine(line: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let currentColor: string | undefined;
  let currentBgColor: string | undefined;

  const regex = new RegExp(COMBINED_STYLE_REGEX.source, "g");

  for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
    const fullMatch = match[0];

    // Handle OSC 8 hyperlink: groups 6=URL, 7=display text
    const osc8Url = match[6];
    const osc8Display = match[7];
    if (osc8Url !== undefined && osc8Display !== undefined) {
      // Flush any pending text with current color before the link
      if (match.index > lastIndex) {
        const text = line.slice(lastIndex, match.index);
        if (text || currentColor || currentBgColor) {
          parts.push(
            <Text
              key={`${keyPrefix}-${lastIndex}`}
              color={currentColor}
              backgroundColor={currentBgColor}
            >
              {text}
            </Text>,
          );
        }
      }
      // Create link with display text (ANSI colors inside link text not supported for now)
      parts.push(
        <Link key={`${keyPrefix}-${match.index}`} url={osc8Url}>
          <Text color={currentColor} backgroundColor={currentBgColor}>
            {osc8Display}
          </Text>
        </Link>,
      );
      lastIndex = match.index + fullMatch.length;
      continue;
    }

    const code = parseInt(match[1] ?? "0", 10);

    // Handle reset
    if (code === 0) {
      if (lastIndex > 0 || currentColor || currentBgColor) {
        const text = line.slice(lastIndex, match.index);
        if (text || currentColor || currentBgColor) {
          parts.push(
            <Text
              key={`${keyPrefix}-${lastIndex}`}
              color={currentColor}
              backgroundColor={currentBgColor}
            >
              {text}
            </Text>,
          );
        }
      }
      lastIndex = match.index + fullMatch.length;
      currentColor = undefined;
      currentBgColor = undefined;
      continue;
    }

    // Handle 24-bit foreground color: 38;2;R;G;B → p1=38,p2=2,p3=R,p4=G,p5=B
    if (code === 38 && match[2] === "2") {
      const r = match[3];
      const g = match[4];
      const b = match[5];
      if (r && g && b) {
        const text = line.slice(lastIndex, match.index);
        if (text || currentColor || currentBgColor) {
          parts.push(
            <Text
              key={`${keyPrefix}-${lastIndex}`}
              color={currentColor}
              backgroundColor={currentBgColor}
            >
              {text}
            </Text>,
          );
        }
        lastIndex = match.index + fullMatch.length;
        currentColor = `#${parseInt(r, 10).toString(16).padStart(2, "0")}${parseInt(g, 10).toString(16).padStart(2, "0")}${parseInt(b, 10).toString(16).padStart(2, "0")}`;
        continue;
      }
    }

    // Handle 256-color foreground: 38;5;N
    if (code === 38 && match[2] === "5") {
      const n = match[3];
      if (n) {
        const text = line.slice(lastIndex, match.index);
        if (text || currentColor || currentBgColor) {
          parts.push(
            <Text
              key={`${keyPrefix}-${lastIndex}`}
              color={currentColor}
              backgroundColor={currentBgColor}
            >
              {text}
            </Text>,
          );
        }
        lastIndex = match.index + fullMatch.length;
        const color256 = get256Color(parseInt(n, 10));
        if (color256) currentColor = color256;
        continue;
      }
    }

    // Handle 24-bit background color: 48;2;R;G;B → p1=48,p2=2,p3=R,p4=G,p5=B
    if (code === 48 && match[2] === "2") {
      const r = match[3];
      const g = match[4];
      const b = match[5];
      if (r && g && b) {
        const text = line.slice(lastIndex, match.index);
        if (text || currentColor || currentBgColor) {
          parts.push(
            <Text
              key={`${keyPrefix}-${lastIndex}`}
              color={currentColor}
              backgroundColor={currentBgColor}
            >
              {text}
            </Text>,
          );
        }
        lastIndex = match.index + fullMatch.length;
        currentBgColor = `#${parseInt(r, 10).toString(16).padStart(2, "0")}${parseInt(g, 10).toString(16).padStart(2, "0")}${parseInt(b, 10).toString(16).padStart(2, "0")}`;
        continue;
      }
    }

    // Handle 256-color background: 48;5;N
    if (code === 48 && match[2] === "5") {
      const n = match[3];
      if (n) {
        const text = line.slice(lastIndex, match.index);
        if (text || currentColor || currentBgColor) {
          parts.push(
            <Text
              key={`${keyPrefix}-${lastIndex}`}
              color={currentColor}
              backgroundColor={currentBgColor}
            >
              {text}
            </Text>,
          );
        }
        lastIndex = match.index + fullMatch.length;
        const color256 = get256Color(parseInt(n, 10));
        if (color256) currentBgColor = color256;
      }
    }

    // Fallback: unrecognized SGR code (bold, underline, standard 16-color, etc.)
    // Advance lastIndex past the matched sequence so raw escape bytes don't leak into rendered text
    lastIndex = match.index + fullMatch.length;
  }

  // Add remaining text with current color
  if (lastIndex < line.length) {
    const text = line.slice(lastIndex);
    if (text || currentColor || currentBgColor) {
      parts.push(
        <Text
          key={`${keyPrefix}-${lastIndex}`}
          color={currentColor}
          backgroundColor={currentBgColor}
        >
          {text}
        </Text>,
      );
    }
  }

  if (parts.length === 0) {
    parts.push(<Text key={keyPrefix}>{line}</Text>);
  }

  return parts;
}

function formatModeLabel(modeName: string, modeGlyph?: string | null): string {
  if (modeGlyph === "") {
    return modeName;
  }
  if (modeGlyph === "⚡︎") {
    return `${modeGlyph}${modeName}`;
  }
  return `${modeGlyph ?? "⏵⏵"} ${modeName}`;
}

function StatusLineContent({
  text,
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
}: {
  text: string;
  modeName: string | null;
  modeColor: string | null;
  modeGlyph?: string | null;
  showExitHint: boolean;
}) {
  const lines = text.split("\n");
  const parts: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      parts.push("\n");
    }
    parts.push(...parseStyledLine(lines[i] ?? "", `l${i}`));
  }
  return (
    <Text wrap="wrap">
      <Text>{parts}</Text>
      {modeName && modeColor && (
        <>
          {"\n"}
          <Text color={modeColor}>{formatModeLabel(modeName, modeGlyph)}</Text>
          <Text color={modeColor} dimColor>
            {" "}
            (shift+tab to {showExitHint ? "exit" : "cycle"})
          </Text>
        </>
      )}
    </Text>
  );
}

type StatuslinePreemption =
  | { type: "confirm-exit" }
  | { type: "confirm-clear" }
  | { type: "bash-mode" }
  | {
      type: "mode-hint";
      modeName: string;
      modeColor: string;
      modeGlyph?: string | null;
      showExitHint: boolean;
    }
  | { type: "footer-notification"; message: string }
  | {
      type: "queued-message-hint";
      queueMode: "immediate" | "defer";
      deferModeSupported: boolean;
    };

function getStatuslinePreemption({
  ctrlCPressed,
  escapePressed,
  isBashMode,
  statusLineText,
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
  footerNotification,
  hasQueuedMessages,
  queueMode,
  deferModeSupported,
}: {
  ctrlCPressed: boolean;
  escapePressed: boolean;
  isBashMode: boolean;
  statusLineText?: string;
  modeName: string | null;
  modeColor: string | null;
  modeGlyph?: string | null;
  showExitHint: boolean;
  footerNotification?: string | null;
  hasQueuedMessages: boolean;
  queueMode: "immediate" | "defer";
  deferModeSupported: boolean;
}): StatuslinePreemption | null {
  if (ctrlCPressed) {
    return { type: "confirm-exit" };
  }

  if (escapePressed) {
    return { type: "confirm-clear" };
  }

  if (isBashMode) {
    return { type: "bash-mode" };
  }

  // Preserve current behavior: a configured statusline owns the slot over
  // non-armed host interaction hints.
  if (statusLineText) {
    return null;
  }

  if (modeName && modeColor) {
    return {
      type: "mode-hint",
      modeName,
      modeColor,
      modeGlyph,
      showExitHint,
    };
  }

  if (footerNotification) {
    return { type: "footer-notification", message: footerNotification };
  }

  if (hasQueuedMessages) {
    return {
      type: "queued-message-hint",
      queueMode,
      deferModeSupported,
    };
  }

  return null;
}

function StatuslinePreemptionView({
  preemption,
}: {
  preemption: StatuslinePreemption;
}) {
  switch (preemption.type) {
    case "confirm-exit":
      return <Text dimColor>Press CTRL-C again to exit</Text>;
    case "confirm-clear":
      return <Text dimColor>Press Esc again to clear</Text>;
    case "bash-mode":
      return (
        <Text>
          <Text color={colors.bash.prompt}>⏵⏵ bash mode</Text>
          <Text color={colors.bash.prompt} dimColor>
            {" "}
            (backspace to exit)
          </Text>
        </Text>
      );
    case "mode-hint":
      return (
        <Text>
          <Text color={preemption.modeColor}>
            {formatModeLabel(preemption.modeName, preemption.modeGlyph)}
          </Text>
          <Text color={preemption.modeColor} dimColor>
            {" "}
            (shift+tab to {preemption.showExitHint ? "exit" : "cycle"})
          </Text>
        </Text>
      );
    case "footer-notification":
      return (
        <Text color={colors.status.processingShimmer}>
          {preemption.message}
        </Text>
      );
    case "queued-message-hint":
      return (
        <Text dimColor>
          {preemption.deferModeSupported
            ? preemption.queueMode === "defer"
              ? "press ↑ to edit queued message · ctrl+d to release queue"
              : "press ↑ to edit queued message · ctrl+d to hold queue until done"
            : "press ↑ to edit queued message"}
        </Text>
      );
  }
}

function DefaultOrExtensionStatusline({
  statusLineText,
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
}: {
  statusLineText?: string;
  modeName: string | null;
  modeColor: string | null;
  modeGlyph?: string | null;
  showExitHint: boolean;
}) {
  if (statusLineText) {
    return (
      <StatusLineContent
        text={statusLineText}
        modeName={modeName}
        modeColor={modeColor}
        modeGlyph={modeGlyph}
        showExitHint={showExitHint}
      />
    );
  }

  return <Text dimColor>Press / for commands</Text>;
}

/**
 * Bottom statusline slot. The default/custom statusline owns this row in the
 * idle/base state, while host-owned input states can preempt it.
 */
const StatuslineSlot = memo(function StatuslineSlot({
  ctrlCPressed,
  escapePressed,
  isBashMode,
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
  agentName,
  currentModel,
  currentReasoningEffort,
  isOpenAICodexProvider,
  isByokProvider,
  isLocalBackend = false,
  hasTemporaryModelOverride,
  hideFooter,
  rightColumnWidth,
  statusLineText,
  statusLineRight,
  footerNotification,
  hasQueuedMessages = false,
  queueMode = "immediate",
  deferModeSupported = false,
}: {
  ctrlCPressed: boolean;
  escapePressed: boolean;
  isBashMode: boolean;
  modeName: string | null;
  modeColor: string | null;
  modeGlyph?: string | null;
  showExitHint: boolean;
  agentName: string | null | undefined;
  currentModel: string | null | undefined;
  currentReasoningEffort?: ModelReasoningEffort | null;
  isOpenAICodexProvider: boolean;
  isByokProvider: boolean;
  isLocalBackend?: boolean;
  hasTemporaryModelOverride?: boolean;
  hideFooter: boolean;
  rightColumnWidth: number;
  statusLineText?: string;
  statusLineRight?: string;
  footerNotification?: string | null;
  hasQueuedMessages?: boolean;
  queueMode?: "immediate" | "defer";
  deferModeSupported?: boolean;
}) {
  const hideFooterContent = hideFooter;

  const preemption = getStatuslinePreemption({
    ctrlCPressed,
    escapePressed,
    isBashMode,
    statusLineText,
    modeName,
    modeColor,
    modeGlyph,
    showExitHint,
    footerNotification,
    hasQueuedMessages,
    queueMode,
    deferModeSupported,
  });
  const leftContent = preemption ? (
    <StatuslinePreemptionView preemption={preemption} />
  ) : (
    <DefaultOrExtensionStatusline
      statusLineText={statusLineText}
      modeName={modeName}
      modeColor={modeColor}
      modeGlyph={modeGlyph}
      showExitHint={showExitHint}
    />
  );

  const maxAgentChars = Math.max(10, Math.floor(rightColumnWidth * 0.45));
  const displayAgentName = truncateEnd(agentName || "Unnamed", maxAgentChars);
  const reasoningTag = shouldHideReasoningForModelDisplay(currentModel)
    ? null
    : getReasoningEffortTag(currentReasoningEffort);
  const byokExtraChars = isByokProvider ? 2 : 0; // " ▲"
  const tempOverrideExtraChars = hasTemporaryModelOverride ? 2 : 0; // " ▲"

  const baseReservedChars =
    displayAgentName.length + byokExtraChars + tempOverrideExtraChars + 4;
  const modelWithReasoning =
    (currentModel ?? "unknown") + (reasoningTag ? ` (${reasoningTag})` : "");

  const maxModelChars = Math.max(8, rightColumnWidth - baseReservedChars);
  const displayModel = truncateEnd(modelWithReasoning, maxModelChars);
  const rightTextLength =
    displayAgentName.length +
    displayModel.length +
    byokExtraChars +
    tempOverrideExtraChars +
    3;
  const rightPrefixSpaces = Math.max(0, rightColumnWidth - rightTextLength);

  // Agent label without leading spaces (used for the default right-side label)
  const rightLabelCore = useMemo(() => {
    const parts: string[] = [];
    parts.push(chalk.hex(colors.footer.agentName)(displayAgentName));
    parts.push(chalk.dim(" ["));
    parts.push(chalk.dim(displayModel));
    if (isByokProvider) {
      parts.push(chalk.dim(" "));
      parts.push(
        isOpenAICodexProvider ? chalk.hex("#74AA9C")("▲") : chalk.yellow("▲"),
      );
    }
    if (hasTemporaryModelOverride) {
      parts.push(chalk.dim(" "));
      parts.push(chalk.yellow("▲"));
    }
    parts.push(chalk.dim("]"));
    if (isLocalBackend) {
      parts.push(chalk.dim(" · "));
      parts.push(chalk.hex(colors.status.success)("local"));
    }
    return parts.join("");
  }, [
    displayAgentName,
    displayModel,
    isByokProvider,
    isOpenAICodexProvider,
    isLocalBackend,
    hasTemporaryModelOverride,
  ]);

  const rightLabel = useMemo(() => {
    return " ".repeat(rightPrefixSpaces) + rightLabelCore;
  }, [rightPrefixSpaces, rightLabelCore]);

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexGrow={1} paddingRight={1}>
        {hideFooterContent ? <Text> </Text> : leftContent}
      </Box>
      <Box
        flexDirection="column"
        alignItems="flex-end"
        width={
          statusLineRight && !hideFooterContent ? undefined : rightColumnWidth
        }
        flexShrink={0}
      >
        {hideFooterContent ? (
          <Text>{" ".repeat(rightColumnWidth)}</Text>
        ) : statusLineRight ? (
          statusLineRight.split("\n").map((line, i) => (
            <Text key={`${i}-${line}`} wrap="truncate-end">
              {parseStyledLine(line, `r${i}`)}
            </Text>
          ))
        ) : (
          <Text>{rightLabel}</Text>
        )}
      </Box>
    </Box>
  );
});

const StreamingStatus = memo(function StreamingStatus({
  streaming,
  visible,
  tokenCount,
  usedContextTokens,
  contextWindowSize,
  elapsedBaseMs,
  thinkingMessage,
  includeSystemPromptUpgradeTip,
  agentName,
  interruptRequested,
  networkPhase,
  terminalWidth,
  shouldAnimate,
}: {
  streaming: boolean;
  visible: boolean;
  tokenCount: number;
  usedContextTokens: number;
  contextWindowSize: number | null | undefined;
  elapsedBaseMs: number;
  thinkingMessage: string;
  includeSystemPromptUpgradeTip: boolean;
  agentName: string | null | undefined;
  interruptRequested: boolean;
  networkPhase: "upload" | "download" | "error" | null;
  terminalWidth: number;
  shouldAnimate: boolean;
}) {
  // While the user is actively resizing the terminal, Ink can struggle to
  // clear/redraw rapidly-changing animated output (spinner/shimmer).
  // Freeze animations briefly during resize to keep output stable.
  const [isResizing, setIsResizing] = useState(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWidthRef = useRef<number>(terminalWidth);

  useEffect(() => {
    if (terminalWidth === lastWidthRef.current) return;
    lastWidthRef.current = terminalWidth;

    setIsResizing(true);
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null;
      setIsResizing(false);
    }, 750);
  }, [terminalWidth]);

  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, []);

  const animate = shouldAnimate && !isResizing;

  // Context-usage tier drives both the spinner animation and its column
  // width — wider as the conversation fills up.
  const contextRatio =
    contextWindowSize && contextWindowSize > 0
      ? usedContextTokens / contextWindowSize
      : 0;
  const contextTier = contextTierFromRatio(contextRatio);
  const spinnerColumnWidth = spinnerWidthForTier(contextTier) + 1;

  // Bump a counter on each false→true streaming edge so the spinner
  // remounts (via key={}) and re-picks from its tier pool. Without this
  // the useState initializer can persist a pick across messages when
  // the JSX shape and tier value are unchanged between streams.
  const [streamSeed, setStreamSeed] = useState(0);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      setStreamSeed((s) => s + 1);
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

  const [shimmerOffset, setShimmerOffset] = useState(-3);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [tipMessage, setTipMessage] = useState("");
  const streamStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!streaming || !visible || !animate) return;

    const id = setInterval(() => {
      setShimmerOffset((prev) => {
        // Include agent name length (+1 for space) in shimmer cycle
        const prefixLen = agentName ? agentName.length + 1 : 0;
        const len = prefixLen + thinkingMessage.length;
        const next = prev + 1;
        return next > len + 3 ? -3 : next;
      });
    }, 120); // Speed of shimmer animation

    return () => clearInterval(id);
  }, [streaming, thinkingMessage, visible, agentName, animate]);

  useEffect(() => {
    if (!animate) {
      setShimmerOffset(-3);
    }
  }, [animate]);

  // Elapsed time tracking: pause updates during resize, but do not reset.
  useEffect(() => {
    if (!streaming || !visible || isResizing) {
      return;
    }

    if (streamStartRef.current === null) {
      streamStartRef.current = performance.now();
    }

    const id = setInterval(() => {
      if (streamStartRef.current !== null) {
        setElapsedMs(performance.now() - streamStartRef.current);
      }
    }, 1000);

    return () => clearInterval(id);
  }, [streaming, visible, isResizing]);

  useEffect(() => {
    if (streaming && visible) {
      return;
    }
    streamStartRef.current = null;
    setElapsedMs(0);
  }, [streaming, visible]);

  useEffect(() => {
    if (streaming && visible) {
      setTipMessage(getRandomThinkingTip({ includeSystemPromptUpgradeTip }));
    }
  }, [streaming, visible, includeSystemPromptUpgradeTip]);

  const estimatedTokens = bytesToTokens(tokenCount);
  const totalElapsedMs = elapsedBaseMs + elapsedMs;
  const shouldShowTokenCount =
    streaming && estimatedTokens > TOKEN_DISPLAY_THRESHOLD;
  const shouldShowElapsed =
    streaming && totalElapsedMs > ELAPSED_DISPLAY_THRESHOLD_MS;
  const elapsedLabel = formatElapsedLabel(totalElapsedMs);

  const networkArrow = useMemo(() => {
    if (!networkPhase) return "";
    if (networkPhase === "upload") return "↑";
    if (networkPhase === "download") return "↑"; // Use ↑ for both to avoid distracting flip (change to ↓ to restore)
    return "↑\u0338";
  }, [networkPhase]);
  const showErrorArrow = networkArrow === "↑\u0338";
  // Avoid painting into the terminal's last column; some terminals will soft-wrap
  // padded Ink rows at the edge which breaks Ink's line-clearing accounting and
  // leaves duplicate status rows behind during streaming/resizes.
  const statusContentWidth = Math.max(
    0,
    terminalWidth - 1 - spinnerColumnWidth,
  );
  const minMessageWidth = 12;
  const statusHintParts = useMemo(() => {
    const parts: string[] = [];
    if (shouldShowElapsed) {
      parts.push(elapsedLabel);
    }
    if (shouldShowTokenCount) {
      parts.push(
        `${formatCompact(estimatedTokens)}${networkArrow ? ` ${networkArrow}` : ""}`,
      );
    } else if (showErrorArrow) {
      parts.push(networkArrow);
    }
    return parts;
  }, [
    shouldShowElapsed,
    elapsedLabel,
    shouldShowTokenCount,
    estimatedTokens,
    networkArrow,
    showErrorArrow,
  ]);
  const statusHintSuffix = statusHintParts.length
    ? ` · ${statusHintParts.join(" · ")}`
    : "";
  const statusHintPlain = interruptRequested
    ? ` (interrupting${statusHintSuffix})`
    : ` (esc to interrupt${statusHintSuffix})`;
  const statusHintWidth = Array.from(statusHintPlain).length;
  const maxHintWidth = Math.max(0, statusContentWidth - minMessageWidth);
  const hintColumnWidth = Math.max(0, Math.min(statusHintWidth, maxHintWidth));
  const maxMessageWidth = Math.max(0, statusContentWidth - hintColumnWidth);
  const statusLabel = `${agentName ? `${agentName} ` : ""}${thinkingMessage}…`;
  const statusLabelWidth = Array.from(statusLabel).length;
  const messageColumnWidth = Math.max(
    0,
    Math.min(maxMessageWidth, Math.max(minMessageWidth, statusLabelWidth)),
  );

  // Build the status hint text (esc to interrupt · 2m · 1.2k ↑)
  // Uses chalk.dim to match reasoning text styling
  // Memoized to prevent unnecessary re-renders during shimmer updates
  const statusHintText = useMemo(() => {
    const hintColor = chalk.hex(colors.subagent.hint);
    const hintBold = hintColor.bold;
    const suffix = `${statusHintSuffix})`;
    if (interruptRequested) {
      return hintColor(` (interrupting${suffix}`);
    }
    return (
      hintColor(" (") + hintBold("esc") + hintColor(` to interrupt${suffix}`)
    );
  }, [interruptRequested, statusHintSuffix]);
  const tipLineText = useMemo(() => {
    return truncateEnd(
      `${CLI_GLYPHS.result}  Tip: ${tipMessage}`,
      statusContentWidth,
    );
  }, [tipMessage, statusContentWidth]);

  if (!streaming || !visible) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Box width={spinnerColumnWidth} flexShrink={0}>
          <Text color={colors.status.processing}>
            {animate ? (
              <StreamingStatusSpinner
                tier={contextTier}
                streamSeed={streamSeed}
              />
            ) : (
              CLI_GLYPHS.bullet
            )}
          </Text>
        </Box>
        <Box width={statusContentWidth} flexShrink={0} flexDirection="row">
          <Box width={messageColumnWidth} flexShrink={0}>
            <ShimmerText
              boldPrefix={agentName || undefined}
              message={thinkingMessage}
              shimmerOffset={animate ? shimmerOffset : -3}
              wrap="truncate-end"
            />
          </Box>
          {hintColumnWidth > 0 && (
            <Box width={hintColumnWidth} flexShrink={0}>
              <Text wrap="truncate-end">{statusHintText}</Text>
            </Box>
          )}
          <Box flexGrow={1} />
        </Box>
      </Box>
      <Box flexDirection="row">
        <Box width={spinnerColumnWidth} flexShrink={0} />
        <Box width={statusContentWidth} flexShrink={0}>
          <Text color={colors.subagent.hint} wrap="truncate-end">
            {tipLineText}
          </Text>
        </Box>
      </Box>
    </Box>
  );
});

// Increase max listeners to accommodate multiple useInput hooks
// (5 in this component + autocomplete components)
stdin.setMaxListeners(20);

// Also set default max listeners on EventEmitter prototype to prevent warnings
// from any EventEmitters that might not have their limit set properly
EventEmitter.defaultMaxListeners = 20;

export function Input({
  visible = true,
  streaming,
  tokenCount,
  usedContextTokens = 0,
  contextWindowSize,
  elapsedBaseMs = 0,
  thinkingMessage,
  includeSystemPromptUpgradeTip = true,
  onSubmit,
  onBashSubmit,
  bashRunning = false,
  onBashInterrupt,
  inputEnabled = true,
  collapseInputWhenDisabled = false,
  permissionMode: externalMode,
  onPermissionModeChange,
  onExit,
  onInterrupt,
  onCtrlO,
  onCtrlD,
  queueMode = "immediate",
  deferModeSupported = false,
  interruptRequested = false,
  agentId,
  agentName,
  currentModel,
  currentModelProvider,
  isLocalBackend = false,
  hasTemporaryModelOverride = false,
  currentReasoningEffort,
  messageQueue,
  onQueueEdit,
  onEscapeCancel,
  onEscapeCommandCancel,
  inputDisabled = false,
  goalLoopActive = false,
  onGoalLoopExit,
  conversationId,
  onPasteError,
  restoredInput,
  onRestoredInputConsumed,
  networkPhase = null,
  terminalWidth,
  shouldAnimate = true,
  statusLineText,
  statusLineRight,
  statusLinePrompt,
  onCycleReasoningEffort,
  footerNotification,
  showInspirationalPromptHints = false,
}: {
  visible?: boolean;
  streaming: boolean;
  tokenCount: number;
  usedContextTokens?: number;
  contextWindowSize?: number | null;
  elapsedBaseMs?: number;
  thinkingMessage: string;
  includeSystemPromptUpgradeTip?: boolean;
  onSubmit: (message?: string) => Promise<{ submitted: boolean }>;
  onBashSubmit?: (command: string) => Promise<void>;
  bashRunning?: boolean;
  onBashInterrupt?: () => void;
  inputEnabled?: boolean;
  collapseInputWhenDisabled?: boolean;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onExit?: () => void;
  onInterrupt?: () => void;
  onCtrlO?: () => void;
  onCtrlD?: () => void;
  queueMode?: "immediate" | "defer";
  deferModeSupported?: boolean;
  interruptRequested?: boolean;
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentModelProvider?: string | null;
  isLocalBackend?: boolean;
  hasTemporaryModelOverride?: boolean;
  currentReasoningEffort?: ModelReasoningEffort | null;
  messageQueue?: QueuedMessage[];
  onQueueEdit?: () => string;
  onEscapeCancel?: () => void;
  onEscapeCommandCancel?: () => boolean;
  inputDisabled?: boolean;
  goalLoopActive?: boolean;
  onGoalLoopExit?: () => void;
  conversationId?: string;
  onPasteError?: (message: string) => void;
  restoredInput?: string | null;
  onRestoredInputConsumed?: () => void;
  networkPhase?: "upload" | "download" | "error" | null;
  terminalWidth: number;
  shouldAnimate?: boolean;
  statusLineText?: string;
  statusLineRight?: string;
  statusLinePrompt?: string;
  onCycleReasoningEffort?: () => void;
  footerNotification?: string | null;
  showInspirationalPromptHints?: boolean;
}) {
  const [value, setValue] = useState("");
  const [escapePressed, setEscapePressed] = useState(false);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ctrlCPressed, setCtrlCPressed] = useState(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousValueRef = useRef(value);
  const [currentMode, setCurrentMode] = useState<PermissionMode>(
    externalMode || permissionMode.getMode(),
  );
  const [emptyPromptHintIndex, setEmptyPromptHintIndex] = useState(0);
  const [emptyPromptHintReady, setEmptyPromptHintReady] = useState(false);
  const [isAutocompleteActive, setIsAutocompleteActive] = useState(false);
  const [cursorPos, setCursorPos] = useState<number | undefined>(undefined);
  const [currentCursorPosition, setCurrentCursorPosition] = useState(0);

  // Terminal width is sourced from App.tsx to avoid duplicate resize subscriptions.
  const columns = terminalWidth;

  // During shrink drags, Ink's incremental clear can leave stale rows behind.
  // The worst offender is the full-width divider line, which wraps as the
  // terminal shrinks and appears to "spam" into the transcript.
  // Hide dividers during shrink gestures; restore after the width settles.
  const [suppressDividers, setSuppressDividers] = useState(false);
  const resizeDividersTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastColumnsRef = useRef(columns);

  // Bash mode state (declared early so prompt width can feed into contentWidth)
  const [isBashMode, setIsBashMode] = useState(false);
  const [bashExitArmed, setBashExitArmed] = useState(false);

  useEffect(() => {
    const prev = lastColumnsRef.current;
    if (columns === prev) return;
    lastColumnsRef.current = columns;

    const isShrinking = columns < prev;
    if (isShrinking) {
      setSuppressDividers(true);
    }

    if (resizeDividersTimerRef.current) {
      clearTimeout(resizeDividersTimerRef.current);
    }
    resizeDividersTimerRef.current = setTimeout(() => {
      resizeDividersTimerRef.current = null;
      setSuppressDividers(false);
    }, 250);

    return;
  }, [columns]);

  useEffect(() => {
    return () => {
      if (resizeDividersTimerRef.current) {
        clearTimeout(resizeDividersTimerRef.current);
        resizeDividersTimerRef.current = null;
      }
    };
  }, []);

  const promptChar = isBashMode ? "!" : statusLinePrompt || ">";
  const promptVisualWidth = stringWidth(promptChar) + 1; // +1 for trailing space
  const contentWidth = Math.max(0, columns - promptVisualWidth);

  const interactionEnabled = visible && inputEnabled && !inputDisabled;
  const reserveInputSpace = !collapseInputWhenDisabled;
  const hideFooter = !interactionEnabled || value.startsWith("/");
  const inputRowLines = useMemo(() => {
    return Math.max(1, getVisualLines(value, contentWidth).length);
  }, [value, contentWidth]);
  const inputChromeHeight = inputRowLines + 3; // top divider + input rows + bottom divider + footer
  const computedFooterRightColumnWidth = useMemo(
    () => Math.max(28, Math.min(72, Math.floor(columns * 0.45))),
    [columns],
  );
  const [footerRightColumnWidth, setFooterRightColumnWidth] = useState(
    computedFooterRightColumnWidth,
  );
  const debugFlicker = process.env.LETTA_DEBUG_FLICKER === "1";

  useEffect(() => {
    if (!streaming) {
      setFooterRightColumnWidth(computedFooterRightColumnWidth);
      return;
    }

    // While streaming, keep the right column width stable to avoid occasional
    // right-edge jitter. Allow significant shrink (terminal got smaller),
    // defer growth until streaming ends.
    if (computedFooterRightColumnWidth >= footerRightColumnWidth) {
      const growthDelta =
        computedFooterRightColumnWidth - footerRightColumnWidth;
      if (debugFlicker && growthDelta >= FOOTER_WIDTH_STREAMING_DELTA) {
        // eslint-disable-next-line no-console
        console.error(
          `[debug:flicker:footer-width] defer growth ${footerRightColumnWidth} -> ${computedFooterRightColumnWidth} (delta=${growthDelta})`,
        );
      }
      return;
    }

    const shrinkDelta = footerRightColumnWidth - computedFooterRightColumnWidth;
    if (shrinkDelta < FOOTER_WIDTH_STREAMING_DELTA) {
      if (debugFlicker && shrinkDelta > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[debug:flicker:footer-width] ignore minor shrink ${footerRightColumnWidth} -> ${computedFooterRightColumnWidth} (delta=${shrinkDelta})`,
        );
      }
      return;
    }

    if (debugFlicker) {
      // eslint-disable-next-line no-console
      console.error(
        `[debug:flicker:footer-width] shrink ${footerRightColumnWidth} -> ${computedFooterRightColumnWidth} (delta=${shrinkDelta})`,
      );
    }
    setFooterRightColumnWidth(computedFooterRightColumnWidth);
  }, [
    streaming,
    computedFooterRightColumnWidth,
    footerRightColumnWidth,
    debugFlicker,
  ]);

  // Command history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState("");

  // Track if we just moved to a boundary (for two-step history navigation)
  const [atStartBoundary, setAtStartBoundary] = useState(false);
  const [atEndBoundary, setAtEndBoundary] = useState(false);

  // Track preferred column for vertical navigation (sticky column behavior)
  const [preferredColumn, setPreferredColumn] = useState<number | null>(null);

  // Restore input from error (only if current value is empty)
  useEffect(() => {
    if (restoredInput && value === "") {
      setValue(restoredInput);
      onRestoredInputConsumed?.();
    } else if (restoredInput && value !== "") {
      // Input has content, don't clobber - just consume the restored value
      onRestoredInputConsumed?.();
    }
  }, [restoredInput, value, onRestoredInputConsumed]);

  useEffect(() => {
    if (!showInspirationalPromptHints || value !== "") {
      setEmptyPromptHintIndex(0);
      setEmptyPromptHintReady(false);
      return;
    }

    const timer = setTimeout(() => {
      setEmptyPromptHintReady(true);
    }, EMPTY_COMPOSER_PROMPT_ROTATION_MS);

    return () => clearTimeout(timer);
  }, [showInspirationalPromptHints, value]);

  useEffect(() => {
    if (
      !showInspirationalPromptHints ||
      value !== "" ||
      !emptyPromptHintReady
    ) {
      return;
    }

    const timer = setInterval(() => {
      setEmptyPromptHintIndex(
        (prev) => (prev + 1) % EMPTY_COMPOSER_PROMPT_HINTS.length,
      );
    }, EMPTY_COMPOSER_PROMPT_ROTATION_MS);

    return () => clearInterval(timer);
  }, [showInspirationalPromptHints, value, emptyPromptHintReady]);

  const inspirationalPlaceholder = showInspirationalPromptHints
    ? (EMPTY_COMPOSER_PROMPT_HINTS[emptyPromptHintIndex] ?? undefined)
    : undefined;
  const showInspirationalPlaceholder =
    showInspirationalPromptHints &&
    emptyPromptHintReady &&
    value === "" &&
    !!inspirationalPlaceholder;

  const handleBangAtEmpty = useCallback(() => {
    if (isBashMode) return false;
    setIsBashMode(true);
    // Arm immediately so initial empty backspace exits in one press.
    setBashExitArmed(true);
    return true;
  }, [isBashMode]);

  const handleBackspaceAtEmpty = useCallback(() => {
    if (!isBashMode) return false;
    if (!bashExitArmed) {
      setBashExitArmed(true);
      return true;
    }
    setIsBashMode(false);
    setBashExitArmed(false);
    return true;
  }, [isBashMode, bashExitArmed]);

  // Reset cursor position after it's been applied
  useEffect(() => {
    if (cursorPos !== undefined) {
      const timer = setTimeout(() => setCursorPos(undefined), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [cursorPos]);

  // Reset bash exit arming when leaving bash mode
  useEffect(() => {
    if (!isBashMode && bashExitArmed) {
      setBashExitArmed(false);
    }
  }, [isBashMode, bashExitArmed]);

  // If user types after first backspace-at-empty, disarm exit intent
  useEffect(() => {
    if (bashExitArmed && value.length > 0) {
      setBashExitArmed(false);
    }
  }, [value, bashExitArmed]);

  // Reset boundary flags and preferred column when cursor moves or value changes
  useEffect(() => {
    if (currentCursorPosition !== 0) {
      setAtStartBoundary(false);
    }
    if (currentCursorPosition !== value.length) {
      setAtEndBoundary(false);
    }
    // Reset preferred column - it will be set again when vertical navigation starts
    setPreferredColumn(null);
  }, [currentCursorPosition, value.length]);

  // Sync with external mode changes.
  useEffect(() => {
    if (externalMode !== undefined) {
      setCurrentMode(externalMode);
    }
  }, [externalMode]);

  useEffect(() => {
    if (!interactionEnabled) {
      setIsAutocompleteActive(false);
    }
  }, [interactionEnabled]);

  const interactionEnabledRef = useRef(interactionEnabled);
  useEffect(() => {
    interactionEnabledRef.current = interactionEnabled;
  }, [interactionEnabled]);

  const onEscapeCommandCancelRef = useRef(onEscapeCommandCancel);
  useEffect(() => {
    onEscapeCommandCancelRef.current = onEscapeCommandCancel;
  }, [onEscapeCommandCancel]);

  useEffect(() => {
    const handleRawInput = (data: Buffer | string) => {
      if (!interactionEnabledRef.current) return;
      if (data.toString("utf8") !== "\u001b") return;
      onEscapeCommandCancelRef.current?.();
    };

    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
    };
  }, []);

  // Get server URL (same logic as client.ts)
  const settings = settingsManager.getSettings();
  const serverUrl =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;

  // Handle profile confirmation: Enter confirms, any other key cancels
  // When onEscapeCancel is provided, TextInput is unfocused so we handle all keys here
  useInput((_input, key) => {
    if (!interactionEnabled) return;
    if (!onEscapeCancel) return;

    // Enter key confirms the action - trigger submit with empty input
    if (key.return) {
      onSubmit("");
      return;
    }

    // Any other key cancels
    onEscapeCancel();
  });

  // Handle escape key for interrupt (when streaming) or double-escape-to-clear (when not)
  useInput((_input, key) => {
    if (!interactionEnabled) return;
    // Debug logging for escape key detection
    if (process.env.LETTA_DEBUG_KEYS === "1" && key.escape) {
      // eslint-disable-next-line no-console
      console.error(
        `[debug:InputRich:escape] escape=${key.escape} visible=${visible} onEscapeCancel=${!!onEscapeCancel} streaming=${streaming}`,
      );
    }
    // Skip if onEscapeCancel is provided - handled by the confirmation handler above
    if (onEscapeCancel) return;

    if (key.escape) {
      // When bash command running, use Esc to interrupt (LET-7199)
      if (bashRunning && onBashInterrupt) {
        onBashInterrupt();
        return;
      }

      // When agent streaming, use Esc to interrupt
      if (streaming && onInterrupt && !interruptRequested) {
        onInterrupt();
        // Don't load queued messages into input - let the dequeue effect
        // in App.tsx process them automatically after the interrupt completes.
        return;
      }

      if (onEscapeCommandCancel?.()) {
        return;
      }

      // When input is non-empty, use double-escape to clear
      if (value) {
        if (escapePressed) {
          // Second escape - clear input
          setValue("");
          setEscapePressed(false);
          if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
        } else {
          // First escape - start timer to allow double-escape to clear
          setEscapePressed(true);
          if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
          escapeTimerRef.current = setTimeout(() => {
            setEscapePressed(false);
          }, ESC_CLEAR_WINDOW_MS);
        }
      }
    }
  });

  useInput((input, key) => {
    // Handle CTRL-D to toggle queue defer mode — works even while agent is running
    // since that's exactly when messages are queued and the toggle is useful.
    if (
      input === "d" &&
      key.ctrl &&
      (messageQueue?.filter((m) => m.kind === "user").length ?? 0) > 0
    ) {
      if (onCtrlD) onCtrlD();
      return;
    }

    if (!interactionEnabled) return;

    // Handle CTRL-O to expand/collapse the last tool call output
    if (input === "o" && key.ctrl) {
      if (onCtrlO) onCtrlO();
      return;
    }

    // Handle CTRL-C for double-ctrl-c-to-exit
    // In bash mode, CTRL-C wipes input but doesn't exit bash mode
    if (input === "c" && key.ctrl) {
      // If a bash command is running, Ctrl+C interrupts it (same as Esc)
      if (bashRunning && onBashInterrupt) {
        onBashInterrupt();
        return;
      }

      if (ctrlCPressed) {
        // Second CTRL-C - call onExit callback which handles stats and exit
        if (onExit) onExit();
      } else {
        // First CTRL-C - wipe input and start 1-second timer
        // Note: In bash mode, this clears input but keeps bash mode active
        setValue("");
        setBashExitArmed(false);
        setCtrlCPressed(true);
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = setTimeout(() => {
          setCtrlCPressed(false);
        }, 1000);
      }
    }
  });

  // Note: bash mode entry/exit is implemented inside PasteAwareTextInput so we can
  // consume the keystroke before it renders (no flicker).

  // Handle Shift+Tab for permission mode cycling (or goal loop exit)
  useInput((_input, key) => {
    if (!interactionEnabled) return;

    // Tab (no shift): cycle reasoning effort tiers for the current model (when idle).
    // Only trigger when autocomplete is NOT active.
    if (
      key.tab &&
      !key.shift &&
      !isAutocompleteActive &&
      !streaming &&
      onCycleReasoningEffort
    ) {
      onCycleReasoningEffort();
      return;
    }

    // Debug logging for shift+tab detection
    if (process.env.LETTA_DEBUG_KEYS === "1" && (key.shift || key.tab)) {
      // eslint-disable-next-line no-console
      console.error(
        `[debug:InputRich] shift=${key.shift} tab=${key.tab} visible=${visible}`,
      );
    }

    if (key.shift && key.tab) {
      // If a goal loop is active, pause it before cycling permission mode.
      if (goalLoopActive && onGoalLoopExit) {
        onGoalLoopExit();
        return;
      }

      // Cycle through permission modes
      const modes: PermissionMode[] = [
        "unrestricted",
        "acceptEdits",
        "standard",
      ];
      const currentIndex = modes.indexOf(currentMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      const nextMode = modes[nextIndex] ?? "unrestricted";

      // Update both singleton and local state
      permissionMode.setMode(nextMode);
      setCurrentMode(nextMode);

      // Notify parent of mode change
      if (onPermissionModeChange) {
        onPermissionModeChange(nextMode);
      }
    }
  });

  // Handle up/down arrow keys for wrapped text navigation and command history
  useInput((_input, key) => {
    if (!interactionEnabled) return;
    // Don't interfere with autocomplete navigation, BUT allow history navigation
    // when we're already browsing history (historyIndex !== -1)
    if (isAutocompleteActive && historyIndex === -1) {
      return;
    }

    if (key.upArrow || key.downArrow) {
      // Calculate visual lines accounting for both soft wrapping and hard newlines
      const visualLines = getVisualLines(value, contentWidth);
      const { lineIndex, column } = findCursorLine(
        currentCursorPosition,
        visualLines,
      );

      // Use preferred column if set (for sticky column behavior), otherwise current column
      const targetColumn = preferredColumn ?? column;

      if (key.upArrow) {
        const targetLine = visualLines[lineIndex - 1];
        if (lineIndex > 0 && targetLine) {
          // Not on first visual line - move cursor up one visual line
          // Set preferred column if not already set
          if (preferredColumn === null) {
            setPreferredColumn(column);
          }
          const targetLineLength = targetLine.end - targetLine.start;
          const newColumn = Math.min(targetColumn, targetLineLength);
          setCursorPos(targetLine.start + newColumn);
          setAtStartBoundary(false); // Reset boundary flag
          return; // Don't trigger history
        }

        // On first wrapped line
        // First press: move to start, second press: queue edit or history
        // Skip the two-step behavior if already browsing history - go straight to navigation
        if (
          currentCursorPosition > 0 &&
          !atStartBoundary &&
          historyIndex === -1
        ) {
          // First press - move cursor to start
          setCursorPos(0);
          setAtStartBoundary(true);
          return;
        }

        // Check if we should load queued messages into input for editing.
        // Fire when already at position 0 (empty input or after first Up moved us here).
        if (
          messageQueue &&
          messageQueue.filter((m) => m.kind === "user").length > 0 &&
          onQueueEdit &&
          (atStartBoundary || currentCursorPosition === 0)
        ) {
          setAtStartBoundary(false);
          const combined = onQueueEdit();
          if (combined) {
            setValue(combined);
            setCursorPos(combined.length);
          }
          return;
        }

        // Otherwise, trigger history navigation
        if (history.length === 0) return;

        setAtStartBoundary(false); // Reset for next time

        if (historyIndex === -1) {
          // Starting to navigate history - save current input
          setTemporaryInput(value);
          // Go to most recent command
          setHistoryIndex(history.length - 1);
          const historyEntry = history[history.length - 1] ?? "";
          setValue(historyEntry);
          setCursorPos(historyEntry.length); // Cursor at end (traditional terminal behavior)
        } else if (historyIndex > 0) {
          // Go to older command
          setHistoryIndex(historyIndex - 1);
          const olderEntry = history[historyIndex - 1] ?? "";
          setValue(olderEntry);
          setCursorPos(olderEntry.length); // Cursor at end (traditional terminal behavior)
        }
      } else if (key.downArrow) {
        const targetLine = visualLines[lineIndex + 1];
        if (lineIndex < visualLines.length - 1 && targetLine) {
          // Not on last visual line - move cursor down one visual line
          // Set preferred column if not already set
          if (preferredColumn === null) {
            setPreferredColumn(column);
          }
          const targetLineLength = targetLine.end - targetLine.start;
          const newColumn = Math.min(targetColumn, targetLineLength);
          setCursorPos(targetLine.start + newColumn);
          setAtEndBoundary(false); // Reset boundary flag
          return; // Don't trigger history
        }

        // On last wrapped line
        // First press: move to end, second press: navigate history
        // Skip the two-step behavior if already browsing history - go straight to navigation
        if (
          currentCursorPosition < value.length &&
          !atEndBoundary &&
          historyIndex === -1
        ) {
          // First press - move cursor to end
          setCursorPos(value.length);
          setAtEndBoundary(true);
          return;
        }

        // Second press or already at end - trigger history navigation
        setAtEndBoundary(false); // Reset for next time

        if (historyIndex === -1) return; // Not in history mode

        if (historyIndex < history.length - 1) {
          // Go to newer command
          setHistoryIndex(historyIndex + 1);
          const newerEntry = history[historyIndex + 1] ?? "";
          setValue(newerEntry);
          setCursorPos(newerEntry.length); // Cursor at end (traditional terminal behavior)
        } else {
          // At the end of history - restore temporary input
          setHistoryIndex(-1);
          setValue(temporaryInput);
          setCursorPos(temporaryInput.length); // Cursor at end for user's draft
        }
      }
    }
  });

  // Reset escape and ctrl-c state when user types (value changes)
  useEffect(() => {
    if (value !== previousValueRef.current && value !== "") {
      setEscapePressed(false);
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      setCtrlCPressed(false);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
    }
    // Reset boundary flags when value changes (user is typing)
    if (value !== previousValueRef.current) {
      setAtStartBoundary(false);
      setAtEndBoundary(false);
    }
    previousValueRef.current = value;
  }, [value]);

  // Exit history mode when user starts typing
  useEffect(() => {
    // If user is in history mode and the value changes (they're typing)
    // Exit history mode but keep the modified text
    if (historyIndex !== -1 && value !== history[historyIndex]) {
      setHistoryIndex(-1);
      setTemporaryInput("");
    }
  }, [value, historyIndex, history]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
    };
  }, []);

  const handleSubmit = useCallback(async () => {
    // Don't submit if autocomplete is active with matches
    if (isAutocompleteActive) {
      return;
    }

    const previousValue = value;

    // Handle bash mode submission
    if (isBashMode) {
      if (!previousValue.trim()) return;

      // Input locking - don't accept new commands while one is running (LET-7199)
      if (bashRunning) return;

      // Add to history if not empty and not a duplicate of the last entry
      setHistory((prev) => {
        if (previousValue.trim() === prev[prev.length - 1]) return prev;
        return [...prev, previousValue];
      });

      // Reset history navigation
      setHistoryIndex(-1);
      setTemporaryInput("");

      setValue(""); // Clear immediately for responsiveness
      // Stay in bash mode - user exits with backspace on empty input
      if (onBashSubmit) {
        await onBashSubmit(previousValue);
      }
      return;
    }

    // Add to history if not empty and not a duplicate of the last entry
    if (previousValue.trim()) {
      setHistory((prev) => {
        if (previousValue === prev[prev.length - 1]) return prev;
        return [...prev, previousValue];
      });
    }

    // Reset history navigation
    setHistoryIndex(-1);
    setTemporaryInput("");

    setValue(""); // Clear immediately for responsiveness
    const result = await onSubmit(previousValue);
    // If message was NOT submitted (e.g. pending approval), restore it
    if (!result.submitted) {
      setValue(previousValue);
    }
  }, [
    isAutocompleteActive,
    value,
    isBashMode,
    bashRunning,
    onBashSubmit,
    onSubmit,
  ]);

  // Handle file selection from autocomplete
  const handleFileSelect = useCallback(
    (selectedPath: string) => {
      // Find the last "@" and replace everything after it with the selected path
      const atIndex = value.lastIndexOf("@");
      if (atIndex === -1) return;

      const beforeAt = value.slice(0, atIndex);
      const afterAt = value.slice(atIndex + 1);
      const spaceIndex = afterAt.indexOf(" ");

      let newValue: string;
      let newCursorPos: number;

      // Replace the query part with the selected path
      if (spaceIndex === -1) {
        // No space after @query, replace to end
        newValue = `${beforeAt}@${selectedPath} `;
        newCursorPos = newValue.length;
      } else {
        // Space exists, replace only the query part
        const afterQuery = afterAt.slice(spaceIndex);
        newValue = `${beforeAt}@${selectedPath}${afterQuery}`;
        newCursorPos = beforeAt.length + selectedPath.length + 1; // After the path
      }

      setValue(newValue);
      setCursorPos(newCursorPos);
    },
    [value],
  );

  // Handle slash command selection from autocomplete (Enter key - execute)
  const handleCommandSelect = useCallback(
    async (selectedCommand: string) => {
      // For slash commands, submit immediately when selected via Enter
      // This provides a better UX - pressing Enter on /model should open the model selector
      const commandToSubmit = selectedCommand.trim();

      // Add to history if not a duplicate of the last entry
      if (commandToSubmit) {
        setHistory((prev) => {
          if (commandToSubmit === prev[prev.length - 1]) return prev;
          return [...prev, commandToSubmit];
        });
      }

      // Reset history navigation
      setHistoryIndex(-1);
      setTemporaryInput("");

      setValue(""); // Clear immediately for responsiveness
      await onSubmit(commandToSubmit);
    },
    [onSubmit],
  );

  // Handle slash command autocomplete (Tab key - fill text only)
  const handleCommandAutocomplete = useCallback((selectedCommand: string) => {
    // Just fill in the command text without executing
    // User can then press Enter to execute or continue typing arguments
    setValue(selectedCommand);
    setCursorPos(selectedCommand.length);
  }, []);

  // Get display name and color for permission mode
  // Memoized to prevent unnecessary footer re-renders
  const modeInfo = useMemo<{
    name: string;
    color: string;
    glyph?: string;
    showExitHint?: boolean;
  } | null>(() => {
    // Fall through to permission modes
    switch (currentMode) {
      case "acceptEdits":
        return { name: "accept edits", color: colors.status.processing };
      case "standard":
        return {
          name: "standard (request approval) mode",
          color: colors.status.processingShimmer,
          glyph: "▶",
        };
      case "unrestricted":
        // Default mode — show nothing so "Press / for commands" renders instead
        return null;
      default:
        return null;
    }
  }, [currentMode]);

  // Goal product status text. Stored in state (rather than recomputed every
  // render) so we only trigger a re-render when the displayed string actually
  // changes. The previous implementation used setGoalFooterTick + setInterval
  // which forced a full Input re-render every second while a goal was active,
  // matching the flicker pattern documented in review-knowledge.md.
  const currentGoal = conversationId
    ? settingsManager.getConversationGoal(conversationId)
    : null;
  const goalStatus = currentGoal?.status ?? null;
  const goalActiveStartedAt = currentGoal?.activeStartedAt ?? null;
  const goalIsActive = goalStatus === "active";

  const [goalStatusText, setGoalStatusText] = useState<string | null>(() =>
    currentGoal ? formatGoalStatusIndicator(currentGoal) : null,
  );

  // Sync on prop-driven changes (status transitions, clear, pause, complete).
  // goalStatus and goalActiveStartedAt are intentional triggers — they detect
  // transitions even though the effect body re-reads via getConversationGoal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are change triggers, not values used in the effect body
  useEffect(() => {
    const goal = conversationId
      ? settingsManager.getConversationGoal(conversationId)
      : null;
    const nextText = goal ? formatGoalStatusIndicator(goal) : null;
    setGoalStatusText((prev) => (prev === nextText ? prev : nextText));
  }, [conversationId, goalStatus, goalActiveStartedAt]);

  // While the goal is active, re-check the formatted string each second but
  // only re-render when it actually changes. Combined with the fixed-width
  // format from formatGoalElapsedSeconds, the string changes at most once per
  // second and the change is always same-width, so no product row flicker.
  useEffect(() => {
    if (!goalIsActive || !conversationId) return;
    const timer = setInterval(() => {
      const goal = settingsManager.getConversationGoal(conversationId);
      const nextText = goal ? formatGoalStatusIndicator(goal) : null;
      setGoalStatusText((prev) => (prev === nextText ? prev : nextText));
    }, 1000);
    return () => clearInterval(timer);
  }, [goalIsActive, conversationId]);

  // Create a horizontal line using box-drawing characters.
  const horizontalLine = useMemo(
    () => "─".repeat(Math.max(0, columns)),
    [columns],
  );

  const lowerPane = useMemo(() => {
    return (
      <>
        {/* Queue display - show whenever there are queued messages */}
        {messageQueue && messageQueue.length > 0 && (
          <QueuedMessages messages={messageQueue} queueMode={queueMode} />
        )}

        {interactionEnabled ? (
          <Box flexDirection="column">
            {!suppressDividers && (
              <ProductStatusRow
                goalStatusText={goalStatusText}
                terminalWidth={terminalWidth}
              />
            )}

            {/* Top horizontal divider */}
            {!suppressDividers && (
              <Text
                dimColor={!isBashMode}
                color={isBashMode ? colors.bash.border : undefined}
              >
                {horizontalLine}
              </Text>
            )}

            {/* Two-column layout for input, matching message components */}
            <Box flexDirection="row">
              <Box width={promptVisualWidth} flexShrink={0}>
                <Text
                  color={isBashMode ? colors.bash.prompt : colors.input.prompt}
                >
                  {promptChar}
                </Text>
                <Text> </Text>
              </Box>
              <Box flexGrow={1} width={contentWidth}>
                <PasteAwareTextInput
                  value={value}
                  onChange={setValue}
                  onSubmit={handleSubmit}
                  placeholder={
                    showInspirationalPlaceholder
                      ? inspirationalPlaceholder
                      : undefined
                  }
                  cursorPosition={cursorPos}
                  onCursorMove={setCurrentCursorPosition}
                  focus={interactionEnabled && !onEscapeCancel}
                  onBangAtEmpty={handleBangAtEmpty}
                  onBackspaceAtEmpty={handleBackspaceAtEmpty}
                  onPasteError={onPasteError}
                />
              </Box>
            </Box>

            {/* Bottom horizontal divider */}
            {!suppressDividers && (
              <Text
                dimColor={!isBashMode}
                color={isBashMode ? colors.bash.border : undefined}
              >
                {horizontalLine}
              </Text>
            )}

            {/*
              During shrink drags Ink's incremental clear is most fragile.
              Hide the entire footer chrome (assist + footer) until the width
              settles to avoid "printing" wrapped rows into the transcript.
            */}
            {!suppressDividers && (
              <InputAssist
                currentInput={value}
                cursorPosition={currentCursorPosition}
                onFileSelect={handleFileSelect}
                onCommandSelect={handleCommandSelect}
                onCommandAutocomplete={handleCommandAutocomplete}
                onAutocompleteActiveChange={setIsAutocompleteActive}
                agentId={agentId}
                agentName={agentName}
                currentModel={currentModel}
                currentReasoningEffort={currentReasoningEffort}
                serverUrl={serverUrl}
                workingDirectory={process.cwd()}
                conversationId={conversationId}
              />
            )}

            {!suppressDividers && (
              <StatuslineSlot
                ctrlCPressed={ctrlCPressed}
                escapePressed={escapePressed}
                isBashMode={isBashMode}
                modeName={modeInfo?.name ?? null}
                modeColor={modeInfo?.color ?? null}
                modeGlyph={modeInfo?.glyph ?? null}
                showExitHint={modeInfo?.showExitHint ?? goalLoopActive}
                agentName={agentName}
                currentModel={currentModel}
                currentReasoningEffort={currentReasoningEffort}
                isOpenAICodexProvider={
                  currentModelProvider === OPENAI_CODEX_PROVIDER_NAME
                }
                isByokProvider={
                  currentModelProvider?.startsWith("lc-") ||
                  currentModelProvider === OPENAI_CODEX_PROVIDER_NAME
                }
                isLocalBackend={isLocalBackend}
                hasTemporaryModelOverride={hasTemporaryModelOverride}
                hideFooter={hideFooter}
                rightColumnWidth={footerRightColumnWidth}
                statusLineText={statusLineText}
                statusLineRight={statusLineRight}
                footerNotification={footerNotification}
                hasQueuedMessages={
                  (messageQueue?.filter((m) => m.kind === "user").length ?? 0) >
                  0
                }
                queueMode={queueMode}
                deferModeSupported={deferModeSupported}
              />
            )}
          </Box>
        ) : reserveInputSpace ? (
          <Box height={inputChromeHeight} />
        ) : null}
      </>
    );
  }, [
    messageQueue,
    interactionEnabled,
    isBashMode,
    horizontalLine,
    contentWidth,
    value,
    handleSubmit,
    showInspirationalPlaceholder,
    cursorPos,
    onEscapeCancel,
    handleBangAtEmpty,
    handleBackspaceAtEmpty,
    onPasteError,
    currentCursorPosition,
    handleFileSelect,
    handleCommandSelect,
    handleCommandAutocomplete,
    agentId,
    agentName,
    serverUrl,
    conversationId,
    ctrlCPressed,
    escapePressed,
    modeInfo?.name,
    modeInfo?.color,
    modeInfo?.glyph,
    modeInfo?.showExitHint,
    goalLoopActive,
    currentModel,
    currentReasoningEffort,
    currentModelProvider,
    hasTemporaryModelOverride,
    hideFooter,
    footerRightColumnWidth,
    reserveInputSpace,
    inputChromeHeight,
    statusLineText,
    statusLineRight,

    footerNotification,
    goalStatusText,
    promptChar,
    promptVisualWidth,
    suppressDividers,
    queueMode,
    deferModeSupported,
    isLocalBackend,
    inspirationalPlaceholder,
    terminalWidth,
  ]);

  // If not visible, render nothing but keep component mounted to preserve state
  if (!visible) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <StreamingStatus
        streaming={streaming}
        visible={visible}
        tokenCount={tokenCount}
        usedContextTokens={usedContextTokens}
        contextWindowSize={contextWindowSize}
        elapsedBaseMs={elapsedBaseMs}
        thinkingMessage={thinkingMessage}
        includeSystemPromptUpgradeTip={includeSystemPromptUpgradeTip}
        agentName={agentName}
        interruptRequested={interruptRequested}
        networkPhase={networkPhase}
        terminalWidth={columns}
        shouldAnimate={shouldAnimate}
      />
      {lowerPane}
    </Box>
  );
}

function formatElapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) {
    return `${seconds}s`;
  }
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    const parts: string[] = [`${hours}hr`];
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
