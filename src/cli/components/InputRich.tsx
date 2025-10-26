// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import SpinnerLib from "ink-spinner";
import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "../../permissions/mode";
import { permissionMode } from "../../permissions/mode";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { CommandPreview } from "./CommandPreview";
import { colors } from "./colors";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { ShimmerText } from "./ShimmerText";

// Type assertion for ink-spinner compatibility
const Spinner = SpinnerLib as ComponentType;

// Only show token count when it exceeds this threshold
const COUNTER_VISIBLE_THRESHOLD = 1000;

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
}: {
  visible?: boolean;
  streaming: boolean;
  commandRunning?: boolean;
  tokenCount: number;
  thinkingMessage: string;
  onSubmit: (message?: string) => void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onExit?: () => void;
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

  // Handle escape key for double-escape-to-clear
  useInput((_input, key) => {
    if (key.escape && value) {
      // Only work when input is non-empty
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
  });

  // Handle CTRL-C for double-ctrl-c-to-exit
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (ctrlCPressed) {
        // Second CTRL-C - call onExit callback which handles stats and exit
        if (onExit) onExit();
      } else {
        // First CTRL-C - start 1-second timer
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

  // Reset escape and ctrl-c state when user types (value changes)
  useEffect(() => {
    if (value !== previousValueRef.current && value !== "") {
      setEscapePressed(false);
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      setCtrlCPressed(false);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
    }
    previousValueRef.current = value;
  }, [value]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
    };
  }, []);

  // Shimmer animation effect
  useEffect(() => {
    if (!streaming) return;

    const id = setInterval(() => {
      setShimmerOffset((prev) => {
        const len = thinkingMessage.length;
        const next = prev + 1;
        return next > len + 3 ? -3 : next;
      });
    }, 120); // Speed of shimmer animation

    return () => clearInterval(id);
  }, [streaming, thinkingMessage]);

  const handleSubmit = () => {
    if (streaming || commandRunning) {
      return;
    }
    onSubmit(value);
    setValue("");
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
            {shouldShowTokenCount && <Text dimColor> ({tokenCount} ↑)</Text>}
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
            />
          </Box>
        </Box>

        {/* Bottom horizontal divider */}
        <Text dimColor>{horizontalLine}</Text>

        {value.startsWith("/") ? (
          <CommandPreview currentInput={value} />
        ) : (
          <Box justifyContent="space-between" marginBottom={1}>
            {ctrlCPressed ? (
              <Text dimColor>Press CTRL-C again to exit</Text>
            ) : escapePressed ? (
              <Text dimColor>Press Esc again to clear</Text>
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
            <Text dimColor>https://discord.gg/letta</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
