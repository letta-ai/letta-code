// Import useInput from vendored Ink for bracketed paste support

import { EventEmitter } from "node:events";
import { stdin } from "node:process";
import chalk from "chalk";
import { Box, useInput } from "ink";
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
import { shouldRenderDefaultStatuslineRenderer } from "@/cli/display/statusline/default-renderer-activation";
import { truncateToWidth } from "@/cli/display/statusline/formatting";
import {
  buildDefaultStatuslineParts,
  renderDefaultStatusline,
} from "@/cli/display/statusline/renderers/Default";
import type { StatuslineUiContext } from "@/cli/display/statusline/types";
import { bytesToTokens, formatCompact } from "@/cli/helpers/format";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  type ExecutionPhase,
  getPhaseVisual,
} from "@/cli/helpers/phase-visuals";
import { getRandomThinkingTip } from "@/cli/helpers/thinking-messages";
import { useShimmerAnimation } from "@/cli/hooks/use-shimmer-animation";
import { useTokenSmoothing } from "@/cli/hooks/use-token-smoothing";
import type { ModContext } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
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
import { ModPanelRow, renderModPanelLines } from "./ModPanelRow";
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
const STATUSLINE_TRANSIENT_HINT_MS = 3000;
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

function formatModeLabel(modeName: string, modeGlyph?: string | null): string {
  if (modeGlyph === "") {
    return modeName;
  }
  if (modeGlyph === "⚡︎") {
    return `${modeGlyph}${modeName}`;
  }
  return `${modeGlyph ?? "⏵⏵"} ${modeName}`;
}

function getPermissionModeTransientHintInfo(mode: PermissionMode): {
  name: string;
  color: string;
  glyph?: string;
} {
  switch (mode) {
    case "acceptEdits":
      return { name: "accept edits", color: colors.status.processing };
    case "standard":
      return {
        name: "standard (request approval) mode",
        color: colors.status.processingShimmer,
        glyph: "▶",
      };
    case "unrestricted":
      return {
        name: "unrestricted mode",
        color: colors.status.success,
        glyph: "⚡︎",
      };
  }
}

type StatuslinePreemption =
  | { type: "confirm-exit" }
  | { type: "confirm-clear" };

type StatuslineTransientHint =
  | {
      type: "message";
      message: string;
      color?: string;
      dimColor?: boolean;
    }
  | { type: "bash-mode" }
  | {
      type: "permission-mode";
      modeName: string;
      modeColor: string;
      modeGlyph?: string | null;
      showExitHint: boolean;
    }
  | {
      type: "queued-message-hint";
      queueMode: "immediate" | "defer";
      deferModeSupported: boolean;
    }
  | {
      type: "queue-mode-changed";
      queueMode: "immediate" | "defer";
      deferModeSupported: boolean;
    };

function isStatuslineTransientHintRelevant(
  hint: StatuslineTransientHint,
  state: {
    isBashMode: boolean;
    queuedUserMessageCount: number;
  },
): boolean {
  switch (hint.type) {
    case "bash-mode":
      return state.isBashMode;
    case "queued-message-hint":
    case "queue-mode-changed":
      return state.queuedUserMessageCount > 0;
    case "message":
    case "permission-mode":
      return true;
  }
}

function getStatuslinePreemption({
  ctrlCPressed,
  escapePressed,
}: {
  ctrlCPressed: boolean;
  escapePressed: boolean;
}): StatuslinePreemption | null {
  if (ctrlCPressed) {
    return { type: "confirm-exit" };
  }

  if (escapePressed) {
    return { type: "confirm-clear" };
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
  }
}

function StatuslineBashModeHint() {
  return (
    <Text>
      <Text color={colors.bash.prompt}>⏵⏵ bash mode</Text>
      <Text color={colors.bash.prompt} dimColor>
        {" "}
        (backspace to exit)
      </Text>
    </Text>
  );
}

function StatuslineModeHint({
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
}: {
  modeName: string;
  modeColor: string;
  modeGlyph?: string | null;
  showExitHint: boolean;
}) {
  return (
    <Text>
      <Text color={modeColor}>{formatModeLabel(modeName, modeGlyph)}</Text>
      <Text color={modeColor} dimColor>
        {" "}
        (shift+tab to {showExitHint ? "exit" : "cycle"})
      </Text>
    </Text>
  );
}

function StatuslineQueuedMessageHint({
  queueMode,
  deferModeSupported,
}: {
  queueMode: "immediate" | "defer";
  deferModeSupported: boolean;
}) {
  return (
    <Text dimColor>
      {deferModeSupported
        ? queueMode === "defer"
          ? "press ↑ to edit queued message · ctrl+d to release queue"
          : "press ↑ to edit queued message · ctrl+d to hold queue until done"
        : "press ↑ to edit queued message"}
    </Text>
  );
}

function StatuslineQueueModeChangedHint({
  queueMode,
  deferModeSupported,
}: {
  queueMode: "immediate" | "defer";
  deferModeSupported: boolean;
}) {
  if (!deferModeSupported) {
    return null;
  }

  return (
    <Text dimColor>
      {queueMode === "defer"
        ? "queue held until done · ctrl+d to release"
        : "queue sends as soon as possible · ctrl+d to hold"}
    </Text>
  );
}

function StatuslineTransientHintView({
  hint,
}: {
  hint: StatuslineTransientHint;
}) {
  switch (hint.type) {
    case "message":
      return (
        <Text color={hint.color} dimColor={hint.dimColor}>
          {hint.message}
        </Text>
      );
    case "bash-mode":
      return <StatuslineBashModeHint />;
    case "permission-mode":
      return (
        <StatuslineModeHint
          modeName={hint.modeName}
          modeColor={hint.modeColor}
          modeGlyph={hint.modeGlyph}
          showExitHint={hint.showExitHint}
        />
      );
    case "queued-message-hint":
      return (
        <StatuslineQueuedMessageHint
          queueMode={hint.queueMode}
          deferModeSupported={hint.deferModeSupported}
        />
      );
    case "queue-mode-changed":
      return (
        <StatuslineQueueModeChangedHint
          queueMode={hint.queueMode}
          deferModeSupported={hint.deferModeSupported}
        />
      );
  }
}

function shouldTransientHintBlankRightColumn({
  customStatuslineActive,
  hint,
}: {
  customStatuslineActive: boolean;
  hint: StatuslineTransientHint | null | undefined;
}): boolean {
  if (!hint) return false;
  if (customStatuslineActive) return true;

  // With the built-in default, bash and permission modes render on the left
  // while the default renderer owns the right label, so they can coexist.
  return hint.type !== "bash-mode" && hint.type !== "permission-mode";
}

function DefaultStatuslineLeftContent({
  defaultLeftStatusline,
  isBashMode,
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
}: {
  defaultLeftStatusline: ReactNode;
  isBashMode: boolean;
  modeName: string | null;
  modeColor: string | null;
  modeGlyph?: string | null;
  showExitHint: boolean;
}) {
  if (isBashMode) {
    return <StatuslineBashModeHint />;
  }

  if (modeName && modeColor) {
    return (
      <StatuslineModeHint
        modeName={modeName}
        modeColor={modeColor}
        modeGlyph={modeGlyph}
        showExitHint={showExitHint}
      />
    );
  }

  return defaultLeftStatusline;
}

function BlankStatuslineRow({
  rightColumnWidth,
}: {
  rightColumnWidth: number;
}) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexGrow={1} paddingRight={1}>
        <Text> </Text>
      </Box>
      <Box
        flexDirection="column"
        alignItems="flex-end"
        width={rightColumnWidth}
        flexShrink={0}
      >
        <Text>{" ".repeat(rightColumnWidth)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Bottom statusline slot. Safety states and transient host hints may preempt the
 * row; otherwise custom mods own the idle row before the built-in default.
 */
const StatuslineSlot = memo(function StatuslineSlot({
  ctrlCPressed,
  escapePressed,
  isBashMode,
  modeName,
  modeColor,
  modeGlyph,
  showExitHint,
  isOpenAICodexProvider,
  isByokProvider,
  hasTemporaryModelOverride,
  hideFooter,
  rightColumnWidth,
  modContext,
  modAdapter,
  transientHint,
}: {
  ctrlCPressed: boolean;
  escapePressed: boolean;
  isBashMode: boolean;
  modeName: string | null;
  modeColor: string | null;
  modeGlyph?: string | null;
  showExitHint: boolean;
  isOpenAICodexProvider: boolean;
  isByokProvider: boolean;
  hasTemporaryModelOverride?: boolean;
  hideFooter: boolean;
  rightColumnWidth: number;
  modContext: ModContext;
  modAdapter: LocalModAdapter;
  transientHint?: StatuslineTransientHint | null;
}) {
  const hideFooterContent = hideFooter;

  const preemption = getStatuslinePreemption({
    ctrlCPressed,
    escapePressed,
  });

  const statuslineUi: StatuslineUiContext = {
    hasTemporaryModelOverride: Boolean(hasTemporaryModelOverride),
    isByokProvider,
    isOpenAICodexProvider,
    rightColumnWidth,
  };

  // The order-0 "primary" panel overrides the built-in agent · model line.
  const panels = modAdapter.registry?.ui.panels ?? {};
  const primaryPanel = Object.values(panels)
    .filter((panel) => panel.order === 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const modPanelsLoading =
    modAdapter.isLoading &&
    (modAdapter.hasModSources || modAdapter.hadModPanels);
  const customStatuslineActive = Boolean(primaryPanel || modPanelsLoading);
  const idleSlotAvailable = !hideFooterContent && !preemption && !transientHint;

  if (idleSlotAvailable && primaryPanel) {
    const rowWidth = Math.max(0, (modContext.terminalWidth ?? 0) - 1);
    const lines = renderModPanelLines(primaryPanel, rowWidth, modContext);
    if (lines.length > 0) {
      return (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: panel content is caller-owned text
            <Text key={index}>{truncateToWidth(line || " ", rowWidth)}</Text>
          ))}
        </Box>
      );
    }
  }

  if (idleSlotAvailable && modPanelsLoading) {
    return <BlankStatuslineRow rightColumnWidth={rightColumnWidth} />;
  }

  const defaultStatuslineParts = buildDefaultStatuslineParts(
    modContext,
    statuslineUi,
    rightColumnWidth,
  );
  const rightLabel = defaultStatuslineParts.right;
  const defaultLeftStatusline = defaultStatuslineParts.left;

  const leftContent = preemption ? (
    <StatuslinePreemptionView preemption={preemption} />
  ) : transientHint ? (
    <StatuslineTransientHintView hint={transientHint} />
  ) : (
    <DefaultStatuslineLeftContent
      defaultLeftStatusline={defaultLeftStatusline}
      isBashMode={isBashMode}
      modeName={modeName}
      modeColor={modeColor}
      modeGlyph={modeGlyph}
      showExitHint={showExitHint}
    />
  );
  const shouldBlankRightColumn =
    Boolean(preemption) ||
    shouldTransientHintBlankRightColumn({
      customStatuslineActive,
      hint: transientHint,
    });

  const shouldRenderDefaultStatusline = shouldRenderDefaultStatuslineRenderer({
    hideFooterContent,
    isBashMode,
    modeActive: Boolean(modeName && modeColor),
    preemptionActive: Boolean(preemption),
    transientHintActive: Boolean(transientHint),
  });

  if (shouldRenderDefaultStatusline) {
    return renderDefaultStatusline(modContext, statuslineUi);
  }

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexGrow={1} paddingRight={1}>
        {hideFooterContent ? <Text> </Text> : leftContent}
      </Box>
      <Box
        flexDirection="column"
        alignItems="flex-end"
        width={rightColumnWidth}
        flexShrink={0}
      >
        {hideFooterContent ? (
          <Text>{" ".repeat(rightColumnWidth)}</Text>
        ) : shouldBlankRightColumn ? (
          <Text>{" ".repeat(rightColumnWidth)}</Text>
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
  executionPhase,
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
  executionPhase: ExecutionPhase;
  terminalWidth: number;
  shouldAnimate: boolean;
}) {
  const phaseVisual = getPhaseVisual(executionPhase);
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

  // Bump a counter on each false→true streaming edge. The spinner reads
  // it as `pool[streamSeed % pool.length]`, so consecutive streams rotate
  // through the tier's pool deterministically (round-robin) without any
  // fiber remount.
  const [streamSeed, setStreamSeed] = useState(0);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      setStreamSeed((s) => s + 1);
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

  // Include agent name length (+1 for space) and trailing ellipsis in cycle
  const agentPrefixLength = agentName ? agentName.length + 1 : 0;
  const shimmerTextLength = agentPrefixLength + thinkingMessage.length + 1;
  const isLive = streaming && visible && animate;

  const { offset: shimmerOffset, baseColor: shimmerBaseColor } =
    useShimmerAnimation({
      active: isLive,
      textLength: shimmerTextLength,
      phaseVisual,
    });
  const displayedTokenBytes = useTokenSmoothing(tokenCount, isLive);

  const [elapsedMs, setElapsedMs] = useState(0);
  const [tipMessage, setTipMessage] = useState("");
  const streamStartRef = useRef<number | null>(null);

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

  // Gate visibility on the actual count so the counter appears the instant
  // the real total crosses the threshold; render the smoothed value so it
  // animates up rather than popping in mid-number.
  const actualEstimatedTokens = bytesToTokens(tokenCount);
  const estimatedTokens = bytesToTokens(displayedTokenBytes);
  const totalElapsedMs = elapsedBaseMs + elapsedMs;
  const shouldShowTokenCount =
    streaming && actualEstimatedTokens > TOKEN_DISPLAY_THRESHOLD;
  const shouldShowElapsed =
    streaming && totalElapsedMs > ELAPSED_DISPLAY_THRESHOLD_MS;
  const elapsedLabel = formatElapsedLabel(totalElapsedMs);

  const networkArrow = useMemo(() => {
    if (!networkPhase) return "";
    if (networkPhase === "upload") return "↑";
    if (networkPhase === "download") return "↓";
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
              color={animate ? shimmerBaseColor : phaseVisual.baseColor}
              shimmerColor={phaseVisual.shimmerColor}
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
  hasTemporaryModelOverride = false,
  currentReasoningEffort,
  fileAutocompleteFdPath,
  messageQueue,
  onQueueEdit,
  onEscapeCancel,
  onEscapeCommandCancel,
  inputDisabled = false,
  conversationId,
  onPasteError,
  restoredInput,
  onRestoredInputConsumed,
  networkPhase = null,
  executionPhase = null,
  terminalWidth,
  shouldAnimate = true,
  modContext,
  modAdapter,
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
  hasTemporaryModelOverride?: boolean;
  currentReasoningEffort?: ModelReasoningEffort | null;
  fileAutocompleteFdPath?: string | null;
  messageQueue?: QueuedMessage[];
  onQueueEdit?: () => string;
  onEscapeCancel?: () => void;
  onEscapeCommandCancel?: () => boolean;
  inputDisabled?: boolean;
  conversationId?: string;
  onPasteError?: (message: string) => void;
  restoredInput?: string | null;
  onRestoredInputConsumed?: () => void;
  networkPhase?: "upload" | "download" | "error" | null;
  executionPhase?: ExecutionPhase;
  terminalWidth: number;
  shouldAnimate?: boolean;
  modContext: ModContext;
  modAdapter: LocalModAdapter;
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
  const [statuslineTransientHint, setStatuslineTransientHint] =
    useState<StatuslineTransientHint | null>(null);
  const statuslineTransientHintTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
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

  const clearStatuslineTransientHint = useCallback(() => {
    if (statuslineTransientHintTimerRef.current) {
      clearTimeout(statuslineTransientHintTimerRef.current);
      statuslineTransientHintTimerRef.current = null;
    }
    setStatuslineTransientHint(null);
  }, []);

  const showStatuslineTransientHint = useCallback(
    (hint: StatuslineTransientHint) => {
      if (statuslineTransientHintTimerRef.current) {
        clearTimeout(statuslineTransientHintTimerRef.current);
      }
      setStatuslineTransientHint(hint);
      statuslineTransientHintTimerRef.current = setTimeout(() => {
        statuslineTransientHintTimerRef.current = null;
        setStatuslineTransientHint(null);
      }, STATUSLINE_TRANSIENT_HINT_MS);
    },
    [],
  );

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
    showStatuslineTransientHint({ type: "bash-mode" });
    // Arm immediately so initial empty backspace exits in one press.
    setBashExitArmed(true);
    return true;
  }, [isBashMode, showStatuslineTransientHint]);

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

  // Handle Shift+Tab for permission mode cycling
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
      if (statuslineTransientHintTimerRef.current) {
        clearTimeout(statuslineTransientHintTimerRef.current);
      }
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

  const handleFileAutocompleteApply = useCallback(
    (nextValue: string, nextCursorPosition: number) => {
      setValue(nextValue);
      setCursorPos(nextCursorPosition);
    },
    [],
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
        // Default mode — show nothing so the built-in idle row owns the space.
        return null;
      default:
        return null;
    }
  }, [currentMode]);

  const previousModeRef = useRef(currentMode);
  useEffect(() => {
    if (previousModeRef.current === currentMode) {
      return;
    }
    previousModeRef.current = currentMode;

    const hintInfo = getPermissionModeTransientHintInfo(currentMode);
    showStatuslineTransientHint({
      type: "permission-mode",
      modeName: hintInfo.name,
      modeColor: hintInfo.color,
      modeGlyph: hintInfo.glyph,
      showExitHint: false,
    });
  }, [currentMode, showStatuslineTransientHint]);

  // Create a horizontal line using box-drawing characters.
  const horizontalLine = useMemo(
    () => "─".repeat(Math.max(0, columns)),
    [columns],
  );

  const queuedUserMessageCount =
    messageQueue?.filter((message) => message.kind === "user").length ?? 0;

  useEffect(() => {
    if (!statuslineTransientHint) return;
    if (
      !isStatuslineTransientHintRelevant(statuslineTransientHint, {
        isBashMode,
        queuedUserMessageCount,
      })
    ) {
      clearStatuslineTransientHint();
    }
  }, [
    statuslineTransientHint,
    isBashMode,
    queuedUserMessageCount,
    clearStatuslineTransientHint,
  ]);

  const previousQueuedUserMessageCountRef = useRef(queuedUserMessageCount);
  useEffect(() => {
    const previousCount = previousQueuedUserMessageCountRef.current;
    previousQueuedUserMessageCountRef.current = queuedUserMessageCount;

    if (previousCount === 0 && queuedUserMessageCount > 0) {
      showStatuslineTransientHint({
        type: "queued-message-hint",
        queueMode,
        deferModeSupported,
      });
    }
  }, [
    queuedUserMessageCount,
    queueMode,
    deferModeSupported,
    showStatuslineTransientHint,
  ]);

  const previousQueueModeRef = useRef(queueMode);
  useEffect(() => {
    const previousMode = previousQueueModeRef.current;
    previousQueueModeRef.current = queueMode;

    if (
      previousMode !== queueMode &&
      queuedUserMessageCount > 0 &&
      deferModeSupported
    ) {
      showStatuslineTransientHint({
        type: "queue-mode-changed",
        queueMode,
        deferModeSupported,
      });
    }
  }, [
    queueMode,
    queuedUserMessageCount,
    deferModeSupported,
    showStatuslineTransientHint,
  ]);

  const previousFooterNotificationRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      footerNotification &&
      footerNotification !== previousFooterNotificationRef.current
    ) {
      showStatuslineTransientHint({
        type: "message",
        message: footerNotification,
        color: colors.status.processingShimmer,
      });
    }
    previousFooterNotificationRef.current = footerNotification ?? null;
  }, [footerNotification, showStatuslineTransientHint]);

  // Decoupled from input churn (value/cursorPos) so panel content only
  // re-renders when the panels themselves change, mirroring how BtwPane
  // stays flash-free. Folding this into lowerPane would rebuild it on every
  // keystroke.
  const modPanelRow = useMemo(() => {
    if (suppressDividers) return null;
    return (
      <ModPanelRow
        panels={modAdapter.registry?.ui.panels}
        terminalWidth={terminalWidth}
        placement="above"
        context={modContext}
      />
    );
  }, [
    suppressDividers,
    modAdapter.registry?.ui.panels,
    terminalWidth,
    modContext,
  ]);

  const modPanelRowBelow = useMemo(() => {
    if (suppressDividers) return null;
    return (
      <ModPanelRow
        panels={modAdapter.registry?.ui.panels}
        terminalWidth={terminalWidth}
        placement="below"
        context={modContext}
      />
    );
  }, [
    suppressDividers,
    modAdapter.registry?.ui.panels,
    terminalWidth,
    modContext,
  ]);

  const lowerPane = useMemo(() => {
    return (
      <>
        {/* Queue display - show whenever there are queued messages */}
        {messageQueue && messageQueue.length > 0 && (
          <QueuedMessages messages={messageQueue} queueMode={queueMode} />
        )}

        {interactionEnabled ? (
          <Box flexDirection="column">
            {modPanelRow}

            {!suppressDividers && (
              <ProductStatusRow terminalWidth={terminalWidth} />
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
                fdPath={fileAutocompleteFdPath}
                onFileAutocompleteApply={handleFileAutocompleteApply}
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
                modCommands={modAdapter.registry?.commands}
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
                showExitHint={modeInfo?.showExitHint ?? false}
                isOpenAICodexProvider={
                  currentModelProvider === OPENAI_CODEX_PROVIDER_NAME
                }
                isByokProvider={
                  currentModelProvider?.startsWith("lc-") ||
                  currentModelProvider === OPENAI_CODEX_PROVIDER_NAME
                }
                hasTemporaryModelOverride={hasTemporaryModelOverride}
                hideFooter={hideFooter}
                rightColumnWidth={footerRightColumnWidth}
                modContext={modContext}
                modAdapter={modAdapter}
                transientHint={statuslineTransientHint}
              />
            )}

            {!suppressDividers && modPanelRowBelow}
          </Box>
        ) : reserveInputSpace ? (
          <Box height={inputChromeHeight} />
        ) : null}
      </>
    );
  }, [
    messageQueue,
    modPanelRow,
    modPanelRowBelow,
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
    handleFileAutocompleteApply,
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
    currentModel,
    currentReasoningEffort,
    fileAutocompleteFdPath,
    currentModelProvider,
    hasTemporaryModelOverride,
    hideFooter,
    footerRightColumnWidth,
    reserveInputSpace,
    inputChromeHeight,
    modContext,
    modAdapter,

    promptChar,
    promptVisualWidth,
    suppressDividers,
    queueMode,
    inspirationalPlaceholder,
    terminalWidth,
    statuslineTransientHint,
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
        executionPhase={executionPhase}
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
