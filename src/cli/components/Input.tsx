// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { CommandPreview } from "./CommandPreview";
import { PasteAwareTextInput } from "./PasteAwareTextInput";

// Only show token count when it exceeds this threshold
const COUNTER_VISIBLE_THRESHOLD = 1000;

// Stable reference to prevent re-renders during typing
const EMPTY_STATUS = " ";

export function Input({
  streaming,
  tokenCount,
  thinkingMessage,
  onSubmit,
}: {
  streaming: boolean;
  tokenCount: number;
  thinkingMessage: string;
  onSubmit: (message?: string) => void;
}) {
  const [value, setValue] = useState("");
  const [escapePressed, setEscapePressed] = useState(false);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ctrlCPressed, setCtrlCPressed] = useState(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousValueRef = useRef(value);

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
        // Second CTRL-C - exit application
        process.exit(0);
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

  const handleSubmit = () => {
    if (streaming) {
      return;
    }
    onSubmit(value);
    setValue("");
  };

  const footerText = ctrlCPressed
    ? "Press CTRL-C again to exit"
    : escapePressed
      ? "Press Esc again to clear"
      : "Press / for commands";

  const thinkingText = streaming
    ? tokenCount > COUNTER_VISIBLE_THRESHOLD
      ? `${thinkingMessage}… (${tokenCount}↑)`
      : `${thinkingMessage}…`
    : EMPTY_STATUS;

  return (
    <Box flexDirection="column" gap={1}>
      {/* Live status / token counter (per-turn) - always takes up space to prevent layout shift */}
      <Text dimColor>{thinkingText}</Text>
      <Box>
        <Text dimColor>{"> "}</Text>
        <PasteAwareTextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
        />
      </Box>
      {value.startsWith("/") ? (
        <CommandPreview currentInput={value} />
      ) : (
        <Box justifyContent="space-between">
          <Text dimColor>{footerText}</Text>
          <Text dimColor>Letta Code v0.1</Text>
        </Box>
      )}
    </Box>
  );
}
