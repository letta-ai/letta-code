// Import useInput from vendored Ink for bracketed paste support

import { EventEmitter } from "node:events";
import { stdin } from "node:process";
import chalk from "chalk";
import { Box, useInput } from "ink";
import SpinnerLib from "ink-spinner";
import {
  type ComponentType,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import {
  ELAPSED_DISPLAY_THRESHOLD_MS,
  TOKEN_DISPLAY_THRESHOLD,
} from "../../constants";
import type { PermissionMode } from "../../permissions/mode";
import { permissionMode } from "../../permissions/mode";
import { OPENAI_CODEX_PROVIDER_NAME } from "../../providers/openai-codex-provider";
import { ralphMode } from "../../ralph/mode";
import { settingsManager } from "../../settings-manager";
import { charsToTokens, formatCompact } from "../helpers/format";
import type { QueuedMessage } from "../helpers/messageQueueBridge";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { InputAssist } from "./InputAssist";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { QueuedMessages } from "./QueuedMessages";
import { ShimmerText } from "./ShimmerText";
import { Text } from "./Text";

// Type assertion for ink-spinner compatibility
const Spinner = SpinnerLib as ComponentType<{ type?: string }>;

// Window for double-escape to clear input
const ESC_CLEAR_WINDOW_MS = 2500;

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

/**
 * Memoized footer component to prevent re-renders during high-frequency
 * shimmer/timer updates. Only updates when its specific props change.
 */

const InputFooter = memo(function InputFooter({
  ctrlCPressed,
  escapePressed,
  isBashMode,
  modeName,
  modeColor,
  showExitHint,
  agentName,
  currentModel,
  currentSystemPromptId,
  currentToolset,
  isOpenAICodexProvider,
  isByokProvider,
  isAutocompleteActive,
  hideFooter,
}: {
  ctrlCPressed: boolean;
  escapePressed: boolean;
  isBashMode: boolean;
  modeName: string | null;
  modeColor: string | null;
  showExitHint: boolean;
  agentName: string | null | undefined;
  currentModel: string | null | undefined;
  currentSystemPromptId: string | null | undefined;
  currentToolset: string | null | undefined;
  isOpenAICodexProvider: boolean;
  isByokProvider: boolean;
  isAutocompleteActive: boolean;
  hideFooter: boolean;
}) {
  // Hide footer when autocomplete is showing
  if (hideFooter || isAutocompleteActive) {
    return null;
  }

  const compactTag = (value: string, maxLen: number): string => {
    if (value.length <= maxLen) return value;
    if (maxLen <= 3) return value.slice(0, maxLen);
    return `${value.slice(0, maxLen - 3)}...`;
  };

  // `default` is an alias for our main Claude-optimized prompt (letta-claude).
  // Showing just `default` isn't very informative, so resolve it for display.
  const displaySystemPromptId =
    currentSystemPromptId === "default"
      ? "letta-claude"
      : currentSystemPromptId;

  // Use the prompt id for display to avoid long/branding-heavy labels.
  // Also strip the redundant `letta-` prefix and keep everything lowercase.
  const systemTagSource = displaySystemPromptId
    ? displaySystemPromptId.replace(/^letta-/, "")
    : "?";
  const systemTag = compactTag(systemTagSource.toLowerCase(), 14);

  const toolsetTag = currentToolset ? compactTag(currentToolset, 10) : "auto";

  const reasoningTokens = new Set(["low", "med", "high", "xhigh"]);
  let modelBase = currentModel ?? "unknown";
  let reasoning: string | null = null;
  if (currentModel) {
    const parts = currentModel.split("-");
    const last = parts[parts.length - 1];
    if (last && reasoningTokens.has(last)) {
      reasoning = last;
      modelBase = parts.slice(0, -1).join("-") || currentModel;
    }
  }

  const reasoningColor =
    reasoning === "low"
      ? colors.footer.reasoningLow
      : reasoning === "med"
        ? colors.footer.reasoningMed
        : reasoning === "high"
          ? colors.footer.reasoningHigh
          : reasoning === "xhigh"
            ? colors.footer.reasoningXHigh
            : undefined;
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      {ctrlCPressed ? (
        <Text dimColor>Press CTRL-C again to exit</Text>
      ) : escapePressed ? (
        <Text dimColor>Press Esc again to clear</Text>
      ) : isBashMode ? (
        <Text>
          <Text color={colors.bash.prompt}>⏵⏵ bash mode</Text>
          <Text color={colors.bash.prompt} dimColor>
            {" "}
            (backspace to exit)
          </Text>
        </Text>
      ) : modeName && modeColor ? (
        <Text>
          <Text color={modeColor}>⏵⏵ {modeName}</Text>
          <Text color={modeColor} dimColor>
            {" "}
            (shift+tab to {showExitHint ? "exit" : "cycle"})
          </Text>
        </Text>
      ) : (
        <Text dimColor>Press / for commands</Text>
      )}
      <Text wrap="truncate">
        <Text color={colors.footer.agentName}>{agentName || "Unnamed"}</Text>
        <Text dimColor>{" ["}</Text>
        <Text dimColor>{modelBase}</Text>
        {reasoning && <Text color={reasoningColor}>{`-${reasoning}`}</Text>}
        {isByokProvider && (
          <Text color={isOpenAICodexProvider ? "#74AA9C" : "yellow"}> ▲</Text>
        )}
        {systemTag && (
          <>
            <Text dimColor> </Text>
            <Text color={colors.footer.tagLabel}>s:</Text>
            <Text color={colors.footer.tagValue}>{systemTag}</Text>
          </>
        )}
        <Text dimColor> </Text>
        <Text color={colors.footer.tagLabel}>t:</Text>
        <Text color={colors.footer.tagValue}>{toolsetTag}</Text>
        <Text dimColor>{"]"}</Text>
      </Text>
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
  elapsedBaseMs = 0,
  thinkingMessage,
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
  interruptRequested = false,
  agentId,
  agentName,
  currentModel,
  currentModelProvider,
  currentSystemPromptId,
  currentToolset,
  messageQueue,
  onEnterQueueEditMode,
  onEscapeCancel,
  ralphActive = false,
  ralphPending = false,
  ralphPendingYolo = false,
  onRalphExit,
  conversationId,
  onPasteError,
  restoredInput,
  onRestoredInputConsumed,
  networkPhase = null,
  onCycleReasoningEffort,
}: {
  visible?: boolean;
  streaming: boolean;
  tokenCount: number;
  elapsedBaseMs?: number;
  thinkingMessage: string;
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
  interruptRequested?: boolean;
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentModelProvider?: string | null;
  currentSystemPromptId?: string | null;
  currentToolset?: string | null;
  messageQueue?: QueuedMessage[];
  onEnterQueueEditMode?: () => void;
  onEscapeCancel?: () => void;
  ralphActive?: boolean;
  ralphPending?: boolean;
  ralphPendingYolo?: boolean;
  onRalphExit?: () => void;
  conversationId?: string;
  onPasteError?: (message: string) => void;
  restoredInput?: string | null;
  onRestoredInputConsumed?: () => void;
  networkPhase?: "upload" | "download" | "error" | null;
  onCycleReasoningEffort?: () => void;
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
  const [isAutocompleteActive, setIsAutocompleteActive] = useState(false);
  const [cursorPos, setCursorPos] = useState<number | undefined>(undefined);
  const [currentCursorPosition, setCurrentCursorPosition] = useState(0);

  // Terminal width (reactive to window resizing)
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  const interactionEnabled = visible && inputEnabled;
  const reserveInputSpace = !collapseInputWhenDisabled;
  const hideFooter = !interactionEnabled || value.startsWith("/");
  const inputRowLines = useMemo(() => {
    return Math.max(1, getVisualLines(value, contentWidth).length);
  }, [value, contentWidth]);
  const inputChromeHeight = inputRowLines + 3; // top divider + input rows + bottom divider + footer

  // Command history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState("");

  // Track if we just moved to a boundary (for two-step history navigation)
  const [atStartBoundary, setAtStartBoundary] = useState(false);
  const [atEndBoundary, setAtEndBoundary] = useState(false);

  // Track preferred column for vertical navigation (sticky column behavior)
  const [preferredColumn, setPreferredColumn] = useState<number | null>(null);

  // Bash mode state
  const [isBashMode, setIsBashMode] = useState(false);

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

  const handleBangAtEmpty = () => {
    if (isBashMode) return false;
    setIsBashMode(true);
    return true;
  };

  const handleBackspaceAtEmpty = () => {
    if (!isBashMode) return false;
    setIsBashMode(false);
    return true;
  };

  // Reset cursor position after it's been applied
  useEffect(() => {
    if (cursorPos !== undefined) {
      const timer = setTimeout(() => setCursorPos(undefined), 0);
      return () => clearTimeout(timer);
    }
  }, [cursorPos]);

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

  // Sync with external mode changes (from plan approval dialog)
  useEffect(() => {
    if (externalMode !== undefined) {
      setCurrentMode(externalMode);
    }
  }, [externalMode]);

  // Shimmer animation state
  const [shimmerOffset, setShimmerOffset] = useState(-3);
  const [elapsedMs, setElapsedMs] = useState(0);
  const streamStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!interactionEnabled) {
      setIsAutocompleteActive(false);
    }
  }, [interactionEnabled]);

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
    if (!interactionEnabled) return;

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

  // Handle Shift+Tab for permission mode cycling (or ralph mode exit)
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
      // If ralph mode is active, exit it first (goes to default mode)
      if (ralphActive && onRalphExit) {
        onRalphExit();
        return;
      }

      // Cycle through permission modes
      const modes: PermissionMode[] = [
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
      ];
      const currentIndex = modes.indexOf(currentMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      const nextMode = modes[nextIndex] ?? "default";

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

        // Check if we should load queue (streaming with queued messages)
        if (
          streaming &&
          messageQueue &&
          messageQueue.length > 0 &&
          atStartBoundary
        ) {
          setAtStartBoundary(false);
          // Clear the queue and load into input as one multi-line message
          const queueText = messageQueue
            .filter((item) => item.kind === "user")
            .map((item) => item.text.trim())
            .filter((msg) => msg.length > 0)
            .join("\n");
          if (!queueText) {
            return;
          }
          setValue(queueText);
          // Signal to App.tsx to clear the queue
          if (onEnterQueueEditMode) {
            onEnterQueueEditMode();
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

  // Shimmer animation effect
  useEffect(() => {
    if (!streaming || !visible) return;

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
  }, [streaming, thinkingMessage, visible, agentName]);

  // Elapsed time tracking
  useEffect(() => {
    if (streaming && visible) {
      // Start tracking when streaming begins
      if (streamStartRef.current === null) {
        streamStartRef.current = performance.now();
      }
      const id = setInterval(() => {
        if (streamStartRef.current !== null) {
          setElapsedMs(performance.now() - streamStartRef.current);
        }
      }, 1000);
      return () => clearInterval(id);
    }
    // Reset when streaming stops
    streamStartRef.current = null;
    setElapsedMs(0);
  }, [streaming, visible]);

  const handleSubmit = async () => {
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
      if (previousValue.trim() !== history[history.length - 1]) {
        setHistory([...history, previousValue]);
      }

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
    if (previousValue.trim() && previousValue !== history[history.length - 1]) {
      setHistory([...history, previousValue]);
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
  };

  // Handle file selection from autocomplete
  const handleFileSelect = (selectedPath: string) => {
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
  };

  // Handle slash command selection from autocomplete (Enter key - execute)
  const handleCommandSelect = async (selectedCommand: string) => {
    // For slash commands, submit immediately when selected via Enter
    // This provides a better UX - pressing Enter on /model should open the model selector
    const commandToSubmit = selectedCommand.trim();

    // Add to history if not a duplicate of the last entry
    if (commandToSubmit && commandToSubmit !== history[history.length - 1]) {
      setHistory([...history, commandToSubmit]);
    }

    // Reset history navigation
    setHistoryIndex(-1);
    setTemporaryInput("");

    setValue(""); // Clear immediately for responsiveness
    await onSubmit(commandToSubmit);
  };

  // Handle slash command autocomplete (Tab key - fill text only)
  const handleCommandAutocomplete = (selectedCommand: string) => {
    // Just fill in the command text without executing
    // User can then press Enter to execute or continue typing arguments
    setValue(selectedCommand);
    setCursorPos(selectedCommand.length);
  };

  // Get display name and color for permission mode (ralph modes take precedence)
  // Memoized to prevent unnecessary footer re-renders
  const modeInfo = useMemo(() => {
    // Check ralph pending first (waiting for task input)
    if (ralphPending) {
      if (ralphPendingYolo) {
        return {
          name: "yolo-ralph (waiting)",
          color: "#FF8C00", // dark orange
        };
      }
      return {
        name: "ralph (waiting)",
        color: "#FEE19C", // yellow (brandColors.statusWarning)
      };
    }

    // Check ralph mode active (using prop for reactivity)
    if (ralphActive) {
      const ralph = ralphMode.getState();
      const iterDisplay =
        ralph.maxIterations > 0
          ? `${ralph.currentIteration}/${ralph.maxIterations}`
          : `${ralph.currentIteration}`;

      if (ralph.isYolo) {
        return {
          name: `yolo-ralph (iter ${iterDisplay})`,
          color: "#FF8C00", // dark orange
        };
      }
      return {
        name: `ralph (iter ${iterDisplay})`,
        color: "#FEE19C", // yellow (brandColors.statusWarning)
      };
    }

    // Fall through to permission modes
    switch (currentMode) {
      case "acceptEdits":
        return { name: "accept edits", color: colors.status.processing };
      case "plan":
        return { name: "plan (read-only) mode", color: colors.status.success };
      case "bypassPermissions":
        return {
          name: "yolo (allow all) mode",
          color: colors.status.error,
        };
      default:
        return null;
    }
  }, [ralphPending, ralphPendingYolo, ralphActive, currentMode]);

  const estimatedTokens = charsToTokens(tokenCount);
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

  // Build the status hint text (esc to interrupt · 2m · 1.2k ↑)
  // Uses chalk.dim to match reasoning text styling
  // Memoized to prevent unnecessary re-renders during shimmer updates
  const statusHintText = useMemo(() => {
    const hintColor = chalk.hex(colors.subagent.hint);
    const hintBold = hintColor.bold;
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
    const suffix = `${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""})`;
    if (interruptRequested) {
      return hintColor(` (interrupting${suffix}`);
    }
    return (
      hintColor(" (") + hintBold("esc") + hintColor(` to interrupt${suffix}`)
    );
  }, [
    shouldShowElapsed,
    elapsedLabel,
    shouldShowTokenCount,
    estimatedTokens,
    interruptRequested,
    networkArrow,
    showErrorArrow,
  ]);

  // Create a horizontal line using box-drawing characters
  // Memoized since it only changes when terminal width changes
  const horizontalLine = useMemo(() => "─".repeat(columns), [columns]);

  // If not visible, render nothing but keep component mounted to preserve state
  if (!visible) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {/* Live status / token counter - only show when streaming */}
      {streaming && (
        <Box flexDirection="row" marginBottom={1}>
          <Box width={2} flexShrink={0}>
            <Text color={colors.status.processing}>
              <Spinner type="layer" />
            </Text>
          </Box>
          <Box flexGrow={1} flexDirection="row">
            <ShimmerText
              boldPrefix={agentName || undefined}
              message={thinkingMessage}
              shimmerOffset={shimmerOffset}
            />
            <Text>{statusHintText}</Text>
          </Box>
        </Box>
      )}

      {/* Queue display - show whenever there are queued messages */}
      {messageQueue && messageQueue.length > 0 && (
        <QueuedMessages messages={messageQueue} />
      )}

      {interactionEnabled ? (
        <Box flexDirection="column">
          {/* Top horizontal divider */}
          <Text
            dimColor={!isBashMode}
            color={isBashMode ? colors.bash.border : undefined}
          >
            {horizontalLine}
          </Text>

          {/* Two-column layout for input, matching message components */}
          <Box flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text
                color={isBashMode ? colors.bash.prompt : colors.input.prompt}
              >
                {isBashMode ? "!" : ">"}
              </Text>
              <Text> </Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <PasteAwareTextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
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
          <Text
            dimColor={!isBashMode}
            color={isBashMode ? colors.bash.border : undefined}
          >
            {horizontalLine}
          </Text>

          <InputAssist
            currentInput={value}
            cursorPosition={currentCursorPosition}
            onFileSelect={handleFileSelect}
            onCommandSelect={handleCommandSelect}
            onCommandAutocomplete={handleCommandAutocomplete}
            onAutocompleteActiveChange={setIsAutocompleteActive}
            agentId={agentId}
            agentName={agentName}
            serverUrl={serverUrl}
            workingDirectory={process.cwd()}
            conversationId={conversationId}
          />

          <InputFooter
            ctrlCPressed={ctrlCPressed}
            escapePressed={escapePressed}
            isBashMode={isBashMode}
            modeName={modeInfo?.name ?? null}
            modeColor={modeInfo?.color ?? null}
            showExitHint={ralphActive || ralphPending}
            agentName={agentName}
            currentModel={currentModel}
            currentSystemPromptId={currentSystemPromptId}
            currentToolset={currentToolset}
            isOpenAICodexProvider={
              currentModelProvider === OPENAI_CODEX_PROVIDER_NAME
            }
            isByokProvider={
              currentModelProvider?.startsWith("lc-") ||
              currentModelProvider === OPENAI_CODEX_PROVIDER_NAME
            }
            isAutocompleteActive={isAutocompleteActive}
            hideFooter={hideFooter}
          />
        </Box>
      ) : reserveInputSpace ? (
        <Box height={inputChromeHeight} />
      ) : null}
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
