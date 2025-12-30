// Import useInput from vendored Ink for bracketed paste support

import { EventEmitter } from "node:events";
import { stdin } from "node:process";
import chalk from "chalk";
import { Box, Text, useInput } from "ink";
import SpinnerLib from "ink-spinner";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { LETTA_CLOUD_API_URL } from "../../auth/oauth";
import {
  ELAPSED_DISPLAY_THRESHOLD_MS,
  TOKEN_DISPLAY_THRESHOLD,
} from "../../constants";
import type { PermissionMode } from "../../permissions/mode";
import { permissionMode } from "../../permissions/mode";
import { ANTHROPIC_PROVIDER_NAME } from "../../providers/anthropic-provider";
import { settingsManager } from "../../settings-manager";
import { charsToTokens, formatCompact } from "../helpers/format";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { InputAssist } from "./InputAssist";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { QueuedMessages } from "./QueuedMessages";
import { ShimmerText } from "./ShimmerText";

// Type assertion for ink-spinner compatibility
const Spinner = SpinnerLib as ComponentType<{ type?: string }>;

// Window for double-escape to clear input
const ESC_CLEAR_WINDOW_MS = 2500;

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
  thinkingMessage,
  onSubmit,
  onBashSubmit,
  permissionMode: externalMode,
  onPermissionModeChange,
  onExit,
  onInterrupt,
  interruptRequested = false,
  agentId,
  agentName,
  currentModel,
  currentModelProvider,
  messageQueue,
  onEnterQueueEditMode,
  onEscapeCancel,
}: {
  visible?: boolean;
  streaming: boolean;
  tokenCount: number;
  thinkingMessage: string;
  onSubmit: (message?: string) => Promise<{ submitted: boolean }>;
  onBashSubmit?: (command: string) => Promise<void>;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onExit?: () => void;
  onInterrupt?: () => void;
  interruptRequested?: boolean;
  agentId?: string;
  agentName?: string | null;
  currentModel?: string | null;
  currentModelProvider?: string | null;
  messageQueue?: string[];
  onEnterQueueEditMode?: () => void;
  onEscapeCancel?: () => void;
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

  // Command history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState("");

  // Track if we just moved to a boundary (for two-step history navigation)
  const [atStartBoundary, setAtStartBoundary] = useState(false);
  const [atEndBoundary, setAtEndBoundary] = useState(false);

  // Bash mode state
  const [isBashMode, setIsBashMode] = useState(false);

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

  // Reset boundary flags when cursor moves (via left/right arrows)
  useEffect(() => {
    if (currentCursorPosition !== 0) {
      setAtStartBoundary(false);
    }
    if (currentCursorPosition !== value.length) {
      setAtEndBoundary(false);
    }
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

  // Terminal width (reactive to window resizing)
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  // Get server URL (same logic as client.ts)
  const settings = settingsManager.getSettings();
  const serverUrl =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;

  // Handle profile confirmation: Enter confirms, any other key cancels
  // When onEscapeCancel is provided, TextInput is unfocused so we handle all keys here
  useInput((_input, key) => {
    if (!visible) return;
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
    if (!visible) return;
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
      // When streaming, use Esc to interrupt
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
    if (!visible) return;

    // Handle CTRL-C for double-ctrl-c-to-exit
    // In bash mode, CTRL-C wipes input but doesn't exit bash mode
    if (input === "c" && key.ctrl) {
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

  // Handle Shift+Tab for permission mode cycling
  useInput((_input, key) => {
    if (!visible) return;
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
    if (!visible) return;
    // Don't interfere with autocomplete navigation
    if (isAutocompleteActive) {
      return;
    }

    if (key.upArrow || key.downArrow) {
      // Calculate which wrapped line the cursor is on
      const lineWidth = contentWidth; // Available width for text

      // Calculate current wrapped line number and position within that line
      const currentWrappedLine = Math.floor(currentCursorPosition / lineWidth);
      const columnInCurrentLine = currentCursorPosition % lineWidth;

      // Calculate total number of wrapped lines
      const totalWrappedLines = Math.ceil(value.length / lineWidth) || 1;

      if (key.upArrow) {
        if (currentWrappedLine > 0) {
          // Not on first wrapped line - move cursor up one wrapped line
          // Try to maintain the same column position
          const targetLine = currentWrappedLine - 1;
          const targetLineStart = targetLine * lineWidth;
          const targetLineEnd = Math.min(
            targetLineStart + lineWidth,
            value.length,
          );
          const targetLineLength = targetLineEnd - targetLineStart;

          // Move to same column in previous line, or end of line if shorter
          const newPosition =
            targetLineStart + Math.min(columnInCurrentLine, targetLineLength);
          setCursorPos(newPosition);
          setAtStartBoundary(false); // Reset boundary flag
          return; // Don't trigger history
        }

        // On first wrapped line
        // First press: move to start, second press: queue edit or history
        if (currentCursorPosition > 0 && !atStartBoundary) {
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
          const queueText = messageQueue.join("\n");
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
          setValue(history[history.length - 1] ?? "");
        } else if (historyIndex > 0) {
          // Go to older command
          setHistoryIndex(historyIndex - 1);
          setValue(history[historyIndex - 1] ?? "");
        }
      } else if (key.downArrow) {
        if (currentWrappedLine < totalWrappedLines - 1) {
          // Not on last wrapped line - move cursor down one wrapped line
          // Try to maintain the same column position
          const targetLine = currentWrappedLine + 1;
          const targetLineStart = targetLine * lineWidth;
          const targetLineEnd = Math.min(
            targetLineStart + lineWidth,
            value.length,
          );
          const targetLineLength = targetLineEnd - targetLineStart;

          // Move to same column in next line, or end of line if shorter
          const newPosition =
            targetLineStart + Math.min(columnInCurrentLine, targetLineLength);
          setCursorPos(newPosition);
          setAtEndBoundary(false); // Reset boundary flag
          return; // Don't trigger history
        }

        // On last wrapped line
        // First press: move to end, second press: navigate history
        if (currentCursorPosition < value.length && !atEndBoundary) {
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
          setValue(history[historyIndex + 1] ?? "");
        } else {
          // At the end of history - restore temporary input
          setHistoryIndex(-1);
          setValue(temporaryInput);
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
        streamStartRef.current = Date.now();
      }
      const id = setInterval(() => {
        if (streamStartRef.current !== null) {
          setElapsedMs(Date.now() - streamStartRef.current);
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

      // Add to history if not empty and not a duplicate of the last entry
      if (previousValue.trim() !== history[history.length - 1]) {
        setHistory([...history, previousValue]);
      }

      // Reset history navigation
      setHistoryIndex(-1);
      setTemporaryInput("");

      setValue(""); // Clear immediately for responsiveness
      // Stay in bash mode after submitting (don't exit)
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

  // Get display name and color for permission mode
  const getModeInfo = () => {
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
  };

  const modeInfo = getModeInfo();

  const estimatedTokens = charsToTokens(tokenCount);
  const shouldShowTokenCount =
    streaming && estimatedTokens > TOKEN_DISPLAY_THRESHOLD;
  const shouldShowElapsed =
    streaming && elapsedMs > ELAPSED_DISPLAY_THRESHOLD_MS;
  const elapsedMinutes = Math.floor(elapsedMs / 60000);

  // Build the status hint text (esc to interrupt · 2m · 1.2k ↑)
  const statusHintText = (() => {
    const hintColor = chalk.hex(colors.subagent.hint);
    const hintBold = hintColor.bold;
    const suffix =
      (shouldShowElapsed ? ` · ${elapsedMinutes}m` : "") +
      (shouldShowTokenCount ? ` · ${formatCompact(estimatedTokens)} ↑` : "") +
      ")";
    if (interruptRequested) {
      return hintColor(` (interrupting${suffix}`);
    }
    return (
      hintColor(" (") + hintBold("esc") + hintColor(` to interrupt${suffix}`)
    );
  })();

  // Create a horizontal line using box-drawing characters
  const horizontalLine = "─".repeat(columns);

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
            <Text color={isBashMode ? colors.bash.prompt : colors.input.prompt}>
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
              focus={!onEscapeCancel}
              onBangAtEmpty={handleBangAtEmpty}
              onBackspaceAtEmpty={handleBackspaceAtEmpty}
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
        />

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
          ) : modeInfo ? (
            <Text>
              <Text color={modeInfo.color}>⏵⏵ {modeInfo.name}</Text>
              <Text color={modeInfo.color} dimColor>
                {" "}
                (shift+tab to cycle)
              </Text>
            </Text>
          ) : (
            <Text dimColor>Press / for commands</Text>
          )}
          <Text>
            <Text color={colors.footer.agentName}>
              {agentName || "Unnamed"}
            </Text>
            <Text
              dimColor={currentModelProvider !== ANTHROPIC_PROVIDER_NAME}
              color={
                currentModelProvider === ANTHROPIC_PROVIDER_NAME
                  ? "#FFC787"
                  : undefined
              }
            >
              {` [${currentModel ?? "unknown"}]`}
            </Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
