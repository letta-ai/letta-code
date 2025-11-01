// Import useInput from vendored Ink for bracketed paste support
import type { LettaMessageUnion } from "@letta-ai/letta-client/resources/agents/messages";
import { Box, Text, useInput } from "ink";
import SpinnerLib from "ink-spinner";
import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "../../permissions/mode";
import { permissionMode } from "../../permissions/mode";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { InputAssist } from "./InputAssist";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { ShimmerText } from "./ShimmerText";

// Type assertion for ink-spinner compatibility
const Spinner = SpinnerLib as ComponentType<{ type?: string }>;

// Only show token count when it exceeds this threshold
const COUNTER_VISIBLE_THRESHOLD = 1000;

// Helper function to extract user message text from message history
function extractUserMessages(messages: LettaMessageUnion[]): string[] {
  return messages
    .filter((msg) => msg.message_type === "user_message")
    .map((msg) => {
      if (msg.message_type === "user_message") {
        // Handle both string and array content
        if (typeof msg.content === "string") {
          return msg.content;
        }
        // If it's an array, concatenate text parts
        return msg.content
          .map((part) => {
            if (part.type === "text") {
              return part.text || "";
            }
            if (part.type === "image") {
              return "[Image]";
            }
            return "";
          })
          .join("");
      }
      return "";
    })
    .filter((text) => text.trim().length > 0);
}

export function Input({
  visible = true,
  streaming,
  commandRunning = false,
  tokenCount,
  thinkingMessage,
  onSubmit,
  permissionMode: externalMode,
  onPermissionModeChange,
  onExit,
  onInterrupt,
  interruptRequested = false,
  messageHistory = [],
  onFetchEarlierMessages,
  isLoadingHistory = false,
  hasMoreHistory = true,
  isLoadingInitialHistory = false,
}: {
  visible?: boolean;
  streaming: boolean;
  commandRunning?: boolean;
  tokenCount: number;
  thinkingMessage: string;
  onSubmit: (message?: string) => Promise<{ submitted: boolean }>;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onExit?: () => void;
  onInterrupt?: () => void;
  interruptRequested?: boolean;
  messageHistory?: LettaMessageUnion[];
  onFetchEarlierMessages?: () => void;
  isLoadingHistory?: boolean;
  hasMoreHistory?: boolean;
  isLoadingInitialHistory?: boolean;
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

  // Command history - initialize from messageHistory
  const [history, setHistory] = useState<string[]>(() =>
    extractUserMessages(messageHistory),
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState("");
  const prevHistoryLengthRef = useRef(history.length);

  // Update history when messageHistory changes (e.g., after submitting a message or pagination)
  useEffect(() => {
    const userMessages = extractUserMessages(messageHistory);
    const oldLength = prevHistoryLengthRef.current;
    const newLength = userMessages.length;

    setHistory(userMessages);

    // If history grew (new messages were prepended), adjust historyIndex
    // We use a function to get the current value without adding it to dependencies
    if (newLength > oldLength) {
      setHistoryIndex((currentIndex) => {
        if (currentIndex !== -1) {
          const lengthDiff = newLength - oldLength;
          return currentIndex + lengthDiff;
        }
        return currentIndex;
      });
    }

    prevHistoryLengthRef.current = newLength;
  }, [messageHistory]);

  // Track if we just moved to a boundary (for two-step history navigation)
  const [atStartBoundary, setAtStartBoundary] = useState(false);
  const [atEndBoundary, setAtEndBoundary] = useState(false);

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

  // Terminal width (reactive to window resizing)
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  // Handle escape key for interrupt (when streaming) or double-escape-to-clear (when not)
  useInput((_input, key) => {
    if (key.escape) {
      // When streaming, use Esc to interrupt
      if (streaming && onInterrupt && !interruptRequested) {
        onInterrupt();
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
          // First escape - start 1-second timer
          setEscapePressed(true);
          if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
          escapeTimerRef.current = setTimeout(() => {
            setEscapePressed(false);
          }, 1000);
        }
      }
    }
  });

  // Handle CTRL-C for double-ctrl-c-to-exit
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (ctrlCPressed) {
        // Second CTRL-C - call onExit callback which handles stats and exit
        if (onExit) onExit();
      } else {
        // First CTRL-C - wipe input and start 1-second timer
        setValue("");
        setCtrlCPressed(true);
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = setTimeout(() => {
          setCtrlCPressed(false);
        }, 1000);
      }
    }
  });

  // Handle Shift+Tab for permission mode cycling
  useInput((_input, key) => {
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
        // First press: move to start, second press: navigate history
        if (currentCursorPosition > 0 && !atStartBoundary) {
          // First press - move cursor to start
          setCursorPos(0);
          setAtStartBoundary(true);
          return;
        }

        // Second press or already at start - trigger history navigation
        if (history.length === 0) {
          return;
        }

        setAtStartBoundary(false); // Reset for next time

        if (historyIndex === -1) {
          // Starting to navigate history - save current input
          setTemporaryInput(value);
          // Go to most recent command
          setHistoryIndex(history.length - 1);
          setValue(history[history.length - 1] ?? "");
        } else if (historyIndex > 0) {
          // Go to older command
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setValue(history[newIndex] ?? "");

          // Fetch earlier messages when we're near the beginning (within last 20 user messages)
          if (
            newIndex <= 20 &&
            hasMoreHistory &&
            !isLoadingHistory &&
            onFetchEarlierMessages
          ) {
            onFetchEarlierMessages();
          }
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
        const len = thinkingMessage.length;
        const next = prev + 1;
        return next > len + 3 ? -3 : next;
      });
    }, 120); // Speed of shimmer animation

    return () => clearInterval(id);
  }, [streaming, thinkingMessage, visible]);

  const handleSubmit = async () => {
    // Don't submit if autocomplete is active with matches
    if (isAutocompleteActive) {
      return;
    }

    if (streaming || commandRunning) {
      return;
    }
    const previousValue = value;

    // Reset history navigation
    // Note: history will be updated automatically via messageHistory prop
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

  const shouldShowTokenCount =
    streaming && tokenCount > COUNTER_VISIBLE_THRESHOLD;

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
          <Box flexGrow={1}>
            <ShimmerText
              message={thinkingMessage}
              shimmerOffset={shimmerOffset}
            />
            <Text dimColor>
              {" ("}
              {interruptRequested ? "interrupting" : "esc to interrupt"}
              {shouldShowTokenCount && ` · ${tokenCount} ↑`}
              {")"}
            </Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column">
        {/* Top horizontal divider */}
        <Text dimColor>{horizontalLine}</Text>

        {/* Two-column layout for input, matching message components */}
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color={colors.input.prompt}>{">"}</Text>
            <Text> </Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <PasteAwareTextInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
              cursorPosition={cursorPos}
              onCursorMove={setCurrentCursorPosition}
            />
          </Box>
        </Box>

        {/* Bottom horizontal divider */}
        <Text dimColor>{horizontalLine}</Text>

        <InputAssist
          currentInput={value}
          cursorPosition={currentCursorPosition}
          onFileSelect={handleFileSelect}
          onAutocompleteActiveChange={setIsAutocompleteActive}
        />

        <Box justifyContent="space-between" marginBottom={1}>
          {ctrlCPressed ? (
            <Text dimColor>Press CTRL-C again to exit</Text>
          ) : escapePressed ? (
            <Text dimColor>Press Esc again to clear</Text>
          ) : isLoadingInitialHistory ? (
            <Text color={colors.status.processing}>
              ⏳ Loading message history...
            </Text>
          ) : isLoadingHistory ? (
            <Text color={colors.status.processing}>
              ⏳ Loading earlier history...
            </Text>
          ) : historyIndex === 0 && history.length > 0 ? (
            <Text dimColor>↑ Reached oldest user message</Text>
          ) : modeInfo ? (
            <Text>
              <Text color={modeInfo.color}>⏵⏵ {modeInfo.name}</Text>
              <Text color={modeInfo.color} dimColor>
                {" "}
                (shift+tab to cycle)
              </Text>
            </Text>
          ) : (
            <Text dimColor>Press / for commands or @ for files</Text>
          )}
          <Text dimColor>
            {isLoadingInitialHistory || isLoadingHistory
              ? "Fetching messages..."
              : "https://discord.gg/letta"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
