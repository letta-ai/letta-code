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
import type { getSubagentLifecycleSnapshot } from "@/agent/subagent-state";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { appendInputHistory } from "@/cli/components/input-history";
import { shouldRenderDefaultStatuslineRenderer } from "@/cli/display/statusline/default-renderer-activation";
import { truncateToWidth } from "@/cli/display/statusline/formatting";
import {
  buildDefaultStatuslineParts,
  renderDefaultStatusline,
} from "@/cli/display/statusline/renderers/Default";
import type { StatuslineUiContext } from "@/cli/display/statusline/types";
import { createDraftPlaceholderDiscards } from "@/cli/helpers/draft-placeholder-discards";
import {
  bytesToTokens,
  formatCompact,
  formatElapsedLabel,
  formatModeLabel,
} from "@/cli/helpers/format";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import {
  type ExecutionPhase,
  getPhaseVisual,
} from "@/cli/helpers/phase-visuals";
import {
  findCursorLine,
  getVisualLines,
  truncateEnd,
} from "@/cli/helpers/text-layout";
import { getRandomThinkingTip } from "@/cli/helpers/thinking-messages";
import { useProductStatusPanels } from "@/cli/hooks/use-product-status-panels";
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
import { getPermissionModeTransientHintInfo } from "./permission-mode-hint";
import { QueuedMessages } from "./QueuedMessages";
import { ShimmerText } from "./ShimmerText";
import {
  contextTierFromRatio,
  spinnerWidthForTier,
} from "./spinners/animations.js";
import { StreamingStatusSpinner } from "./spinners/StreamingStatusSpinner.js";
import { Text } from "./Text";
import { handleTranscriptDisplayShortcut } from "./transcript-display-state";
import type { SessionCompletions } from "./types/autocomplete";

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
  subagentLifecycleSnapshot: _subagentLifecycleSnapshot,
  subagentLifecycleTick: _subagentLifecycleTick,
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
  subagentLifecycleSnapshot: ReturnType<typeof getSubagentLifecycleSnapshot>;
  subagentLifecycleTick: number;
  modAdapter: Partial<
    Pick<
      LocalModAdapter,
      "registry" | "isLoading" | "hadModPanels" | "hasModSources"
    >
  >;
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

  const contextRatio =
    contextWindowSize && contextWindowSize > 0
      ? usedContextTokens / contextWindowSize
      : 0;
  const contextTier = contextTierFromRatio(contextRatio);
  const spinnerColumnWidth = spinnerWidthForTier(contextTier) + 1;

  const [streamSeed, setStreamSeed] = useState(0);
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      setStreamSeed((s) => s + 1);
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

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

stdin.setMaxListeners(20);

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
  hasStopFailedTasks = false,
  agentId,
  agentName,
  currentModel,
  currentModelProvider,
  hasTemporaryModelOverride = false,
  currentReasoningEffort,
  sessionCompletions,
  fileAutocompleteFdPath,
  messageQueue,
  recallQueued,
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
  hasStopFailedTasks?: boolean;
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentModelProvider?: string | null;
  hasTemporaryModelOverride?: boolean;
  currentReasoningEffort?: ModelReasoningEffort | null;
  fileAutocompleteFdPath?: string | null;
  sessionCompletions?: SessionCompletions;
  messageQueue?: QueuedMessage[];
  recallQueued?: () => Promise<string>;
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
  modAdapter: Partial<
    Pick<
      LocalModAdapter,
      "registry" | "isLoading" | "hadModPanels" | "hasModSources"
    >
  >;
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

  const columns = terminalWidth;

  const [suppressDividers, setSuppressDividers] = useState(false);
  const resizeDividersTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastColumnsRef = useRef(columns);

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
  const promptVisualWidth = stringWidth(promptChar) + 1;
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
  const inputChromeHeight = inputRowLines + 3;
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

  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState("");

  const [atStartBoundary, setAtStartBoundary] = useState(false);
  const [atEndBoundary, setAtEndBoundary] = useState(false);

  const [preferredColumn, setPreferredColumn] = useState<number | null>(null);

  const inFlightSubmitTextRef = useRef<string | null>(null);
  const [draftDiscards] = useState(createDraftPlaceholderDiscards);
  const temporaryInputRef = useRef(temporaryInput);
  temporaryInputRef.current = temporaryInput;
  const restoredInputRef = useRef(restoredInput);
  restoredInputRef.current = restoredInput;

  const releaseDiscardedDraftPlaceholders = useCallback(
    (discarded: string, next: string) => {
      draftDiscards.release(discarded, [
        next,
        temporaryInputRef.current,
        restoredInputRef.current,
        inFlightSubmitTextRef.current,
        ...(messageQueue?.map((m) => m.text) ?? []),
      ]);
    },
    [messageQueue, draftDiscards],
  );

  const clearParkedDraft = useCallback(
    (next?: string) => {
      const parked = temporaryInputRef.current;
      temporaryInputRef.current = "";
      setTemporaryInput("");
      if (next !== undefined) releaseDiscardedDraftPlaceholders(parked, next);
    },
    [releaseDiscardedDraftPlaceholders],
  );

  useEffect(() => {
    if (restoredInput && value === "") {
      setValue(restoredInput);
      onRestoredInputConsumed?.();
    } else if (restoredInput && value !== "") {
      restoredInputRef.current = null;
      releaseDiscardedDraftPlaceholders(restoredInput, value);
      onRestoredInputConsumed?.();
    }
  }, [
    restoredInput,
    value,
    onRestoredInputConsumed,
    releaseDiscardedDraftPlaceholders,
  ]);

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

  useEffect(() => {
    if (cursorPos !== undefined) {
      const timer = setTimeout(() => setCursorPos(undefined), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [cursorPos]);

  useEffect(() => {
    if (!isBashMode && bashExitArmed) {
      setBashExitArmed(false);
    }
  }, [isBashMode, bashExitArmed]);

  useEffect(() => {
    if (bashExitArmed && value.length > 0) {
      setBashExitArmed(false);
    }
  }, [value, bashExitArmed]);

  useEffect(() => {
    if (currentCursorPosition !== 0) {
      setAtStartBoundary(false);
    }
    if (currentCursorPosition !== value.length) {
      setAtEndBoundary(false);
    }
    setPreferredColumn(null);
  }, [currentCursorPosition, value.length]);

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

  const serverUrl = sessionCompletions
    ? undefined
    : process.env.LETTA_BASE_URL ||
      settingsManager.getSettings().env?.LETTA_BASE_URL ||
      LETTA_CLOUD_API_URL;

  useInput((_input, key) => {
    if (!interactionEnabled) return;
    if (!onEscapeCancel) return;

    if (key.return) {
      onSubmit("");
      return;
    }

    onEscapeCancel();
  });

  useInput((_input, key) => {
    if (!interactionEnabled) return;
    if (process.env.LETTA_DEBUG_KEYS === "1" && key.escape) {
      // eslint-disable-next-line no-console
      console.error(
        `[debug:InputRich:escape] escape=${key.escape} visible=${visible} onEscapeCancel=${!!onEscapeCancel} streaming=${streaming}`,
      );
    }
    if (onEscapeCancel) return;

    if (key.escape) {
      if (bashRunning && onBashInterrupt) {
        onBashInterrupt();
        return;
      }

      if (
        (streaming || interruptRequested || hasStopFailedTasks) &&
        onInterrupt
      ) {
        onInterrupt();
        return;
      }

      if (onEscapeCommandCancel?.()) {
        return;
      }

      if (value) {
        if (escapePressed) {
          releaseDiscardedDraftPlaceholders(value, "");
          setValue("");
          setEscapePressed(false);
          if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
        } else {
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
    if (
      input === "d" &&
      key.ctrl &&
      (messageQueue?.filter((m) => m.kind === "user").length ?? 0) > 0
    ) {
      if (onCtrlD) onCtrlD();
      return;
    }

    if (!interactionEnabled) return;

    if (input === "o" && key.ctrl) {
      if (onCtrlO) onCtrlO();
      return;
    }
    if (handleTranscriptDisplayShortcut(input, key)) return;
    if (input === "c" && key.ctrl) {
      if (bashRunning && onBashInterrupt) {
        onBashInterrupt();
        return;
      }

      if (ctrlCPressed) {
        if (onExit) onExit();
      } else {
        releaseDiscardedDraftPlaceholders(value, "");
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

  useInput((_input, key) => {
    if (!interactionEnabled) return;

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

    if (process.env.LETTA_DEBUG_KEYS === "1" && (key.shift || key.tab)) {
      // eslint-disable-next-line no-console
      console.error(
        `[debug:InputRich] shift=${key.shift} tab=${key.tab} visible=${visible}`,
      );
    }

    if (key.shift && key.tab) {
      const modes: PermissionMode[] = [
        "unrestricted",
        "acceptEdits",
        "standard",
      ];
      const currentIndex = modes.indexOf(currentMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      const nextMode = modes[nextIndex] ?? "unrestricted";

      if (!sessionCompletions) permissionMode.setMode(nextMode);
      setCurrentMode(nextMode);

      if (onPermissionModeChange) {
        onPermissionModeChange(nextMode);
      }
    }
  });

  useInput((_input, key) => {
    if (!interactionEnabled) return;
    if (isAutocompleteActive && historyIndex === -1) {
      return;
    }

    if (key.upArrow || key.downArrow) {
      const visualLines = getVisualLines(value, contentWidth);
      const { lineIndex, column } = findCursorLine(
        currentCursorPosition,
        visualLines,
      );

      const targetColumn = preferredColumn ?? column;

      if (key.upArrow) {
        if (!value && recallQueued) {
          void recallQueued().then((text) => {
            if (text) {
              setValue((current) => text + current);
              setCursorPos(text.length);
            }
          });
          return;
        }
        const targetLine = visualLines[lineIndex - 1];
        if (lineIndex > 0 && targetLine) {
          if (preferredColumn === null) {
            setPreferredColumn(column);
          }
          const targetLineLength = targetLine.end - targetLine.start;
          const newColumn = Math.min(targetColumn, targetLineLength);
          setCursorPos(targetLine.start + newColumn);
          setAtStartBoundary(false);
          return;
        }

        if (
          currentCursorPosition > 0 &&
          !atStartBoundary &&
          historyIndex === -1
        ) {
          setCursorPos(0);
          setAtStartBoundary(true);
          return;
        }

        if (history.length === 0) return;

        setAtStartBoundary(false);

        if (historyIndex === -1) {
          setTemporaryInput(value);
          setHistoryIndex(history.length - 1);
          const historyEntry = history[history.length - 1] ?? "";
          setValue(historyEntry);
          setCursorPos(historyEntry.length);
        } else if (historyIndex > 0) {
          setHistoryIndex(historyIndex - 1);
          const olderEntry = history[historyIndex - 1] ?? "";
          setValue(olderEntry);
          setCursorPos(olderEntry.length);
        }
      } else if (key.downArrow) {
        const targetLine = visualLines[lineIndex + 1];
        if (lineIndex < visualLines.length - 1 && targetLine) {
          if (preferredColumn === null) {
            setPreferredColumn(column);
          }
          const targetLineLength = targetLine.end - targetLine.start;
          const newColumn = Math.min(targetColumn, targetLineLength);
          setCursorPos(targetLine.start + newColumn);
          setAtEndBoundary(false);
          return;
        }

        if (
          currentCursorPosition < value.length &&
          !atEndBoundary &&
          historyIndex === -1
        ) {
          setCursorPos(value.length);
          setAtEndBoundary(true);
          return;
        }

        setAtEndBoundary(false);

        if (historyIndex === -1) return;

        if (historyIndex < history.length - 1) {
          setHistoryIndex(historyIndex + 1);
          const newerEntry = history[historyIndex + 1] ?? "";
          setValue(newerEntry);
          setCursorPos(newerEntry.length);
        } else {
          setHistoryIndex(-1);
          setValue(temporaryInput);
          setCursorPos(temporaryInput.length);
          clearParkedDraft();
        }
      }
    }
  });

  useEffect(() => {
    if (value !== previousValueRef.current && value !== "") {
      setEscapePressed(false);
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      setCtrlCPressed(false);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
    }
    if (value !== previousValueRef.current) {
      setAtStartBoundary(false);
      setAtEndBoundary(false);
    }
    previousValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (historyIndex !== -1 && value !== history[historyIndex]) {
      setHistoryIndex(-1);
      clearParkedDraft(value);
    }
  }, [value, historyIndex, history, clearParkedDraft]);

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
    if (isAutocompleteActive) {
      return;
    }

    const previousValue = value;

    if (isBashMode) {
      if (!previousValue.trim()) return;

      if (bashRunning) return;

      setHistory((prev) => appendInputHistory(prev, previousValue));

      setHistoryIndex(-1);
      clearParkedDraft("");

      releaseDiscardedDraftPlaceholders(previousValue, "");
      setValue("");
      if (onBashSubmit) {
        await onBashSubmit(previousValue);
      }
      return;
    }

    if (previousValue.trim()) {
      setHistory((prev) => appendInputHistory(prev, previousValue));
    }

    setHistoryIndex(-1);
    clearParkedDraft(previousValue);

    setValue("");
    inFlightSubmitTextRef.current = previousValue;
    try {
      const result = await onSubmit(previousValue);
      if (!result.submitted) {
        setValue(previousValue);
      }
    } finally {
      if (inFlightSubmitTextRef.current === previousValue) {
        inFlightSubmitTextRef.current = null;
      }
    }
  }, [
    isAutocompleteActive,
    value,
    isBashMode,
    bashRunning,
    onBashSubmit,
    onSubmit,
    releaseDiscardedDraftPlaceholders,
    clearParkedDraft,
  ]);

  const handleFileAutocompleteApply = useCallback(
    (nextValue: string, nextCursorPosition: number) => {
      setValue(nextValue);
      setCursorPos(nextCursorPosition);
    },
    [],
  );

  const handleCommandSelect = useCallback(
    async (selectedCommand: string) => {
      const commandToSubmit = selectedCommand.trim();

      if (commandToSubmit) {
        setHistory((prev) => appendInputHistory(prev, commandToSubmit));
      }

      setHistoryIndex(-1);
      clearParkedDraft(commandToSubmit);

      releaseDiscardedDraftPlaceholders(value, commandToSubmit);
      setValue("");
      await onSubmit(commandToSubmit);
    },
    [onSubmit, value, releaseDiscardedDraftPlaceholders, clearParkedDraft],
  );

  const handleCommandAutocomplete = useCallback(
    (selectedCommand: string) => {
      releaseDiscardedDraftPlaceholders(value, selectedCommand);
      setValue(selectedCommand);
      setCursorPos(selectedCommand.length);
    },
    [value, releaseDiscardedDraftPlaceholders],
  );

  const handleDraftChange = useCallback(
    (nextValue: string) => {
      draftDiscards.noteEdit(value, nextValue);
      setValue(nextValue);
    },
    [value, draftDiscards],
  );

  const modeInfo = useMemo<{
    name: string;
    color: string;
    glyph?: string;
    showExitHint?: boolean;
  } | null>(() => {
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

  const {
    panelsWithDefaultProductStatus,
    panelModContext,
    subagentLifecycleSnapshot,
    subagentLifecycleTick,
  } = useProductStatusPanels({
    modContext,
    modAdapter,
    shouldAnimate,
    remote: !!sessionCompletions,
  });

  const modPanelRow = useMemo(() => {
    void subagentLifecycleSnapshot;
    void subagentLifecycleTick;
    if (suppressDividers) return null;
    return (
      <ModPanelRow
        panels={panelsWithDefaultProductStatus}
        terminalWidth={terminalWidth}
        placement="above"
        context={panelModContext}
      />
    );
  }, [
    suppressDividers,
    panelsWithDefaultProductStatus,
    terminalWidth,
    panelModContext,
    subagentLifecycleSnapshot,
    subagentLifecycleTick,
  ]);

  const modPanelRowBelow = useMemo(() => {
    void subagentLifecycleSnapshot;
    void subagentLifecycleTick;
    if (suppressDividers) return null;
    return (
      <ModPanelRow
        panels={panelsWithDefaultProductStatus}
        terminalWidth={terminalWidth}
        placement="below"
        context={panelModContext}
      />
    );
  }, [
    suppressDividers,
    panelsWithDefaultProductStatus,
    terminalWidth,
    panelModContext,
    subagentLifecycleSnapshot,
    subagentLifecycleTick,
  ]);

  const lowerPane = useMemo(() => {
    return (
      <>
        {messageQueue && messageQueue.length > 0 && (
          <QueuedMessages messages={messageQueue} queueMode={queueMode} />
        )}

        {interactionEnabled ? (
          <Box flexDirection="column">
            {modPanelRow}

            {!suppressDividers && (
              <Text
                dimColor={!isBashMode}
                color={isBashMode ? colors.bash.border : undefined}
              >
                {horizontalLine}
              </Text>
            )}

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
                  onChange={handleDraftChange}
                  onSubmit={handleSubmit}
                  placeholder={
                    showInspirationalPlaceholder
                      ? inspirationalPlaceholder
                      : undefined
                  }
                  cursorPosition={cursorPos}
                  onCursorMove={setCurrentCursorPosition}
                  focus={interactionEnabled && !onEscapeCancel}
                  onBangAtEmpty={onBashSubmit ? handleBangAtEmpty : undefined}
                  onBackspaceAtEmpty={handleBackspaceAtEmpty}
                  onPasteError={onPasteError}
                />
              </Box>
            </Box>

            {!suppressDividers && (
              <Text
                dimColor={!isBashMode}
                color={isBashMode ? colors.bash.border : undefined}
              >
                {horizontalLine}
              </Text>
            )}

            {!suppressDividers && (
              <InputAssist
                currentInput={value}
                session={sessionCompletions}
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
                workingDirectory={modContext.cwd}
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
                modContext={panelModContext}
                subagentLifecycleSnapshot={subagentLifecycleSnapshot}
                subagentLifecycleTick={subagentLifecycleTick}
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
    handleDraftChange,
    showInspirationalPlaceholder,
    cursorPos,
    onEscapeCancel,
    handleBangAtEmpty,
    sessionCompletions,
    onBashSubmit,
    handleBackspaceAtEmpty,
    onPasteError,
    currentCursorPosition,
    modContext.cwd,
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
    panelModContext,
    subagentLifecycleSnapshot,
    subagentLifecycleTick,
    modAdapter,

    promptChar,
    promptVisualWidth,
    suppressDividers,
    queueMode,
    inspirationalPlaceholder,
    statuslineTransientHint,
  ]);

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
