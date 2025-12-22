// Paste-aware text input wrapper that:
// 1. Detects large pastes (>5 lines or >500 chars) and replaces with placeholders
// 2. Supports image pasting (iTerm2 inline, data URLs, file paths, macOS clipboard)
// 3. Maintains separate display value (with placeholders) vs actual value (full content)
// 4. Resolves placeholders on submit

// Import useInput from vendored Ink for bracketed paste support
import { useInput, useStdin } from "ink";
import RawTextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import {
  translatePasteForImages,
  tryImportClipboardImageMac,
} from "../helpers/clipboard";
import { allocatePaste, resolvePlaceholders } from "../helpers/pasteRegistry";

interface PasteAwareTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  cursorPosition?: number;
  onCursorMove?: (position: number) => void;

  /**
   * Called when the user presses `!` while the input is empty.
   * Return true to consume the keystroke (it will NOT appear in the input).
   */
  onBangAtEmpty?: () => boolean;

  /**
   * Called when the user presses Backspace while the input is empty.
   * Return true to consume the keystroke.
   */
  onBackspaceAtEmpty?: () => boolean;
}

function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length + 1;
}

/** Replace newlines with visual indicator for display */
function sanitizeForDisplay(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "↵");
}

/** Find the boundary of the previous word for option+left navigation */
function findPreviousWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos === 0) return 0;

  // Move back one position if we're at the end of a word
  let pos = cursorPos - 1;

  // Skip whitespace backwards
  while (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos--;
  }

  // Skip word characters backwards
  while (pos > 0 && /\S/.test(text.charAt(pos))) {
    pos--;
  }

  // If we stopped at whitespace, move forward one
  if (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return Math.max(0, pos);
}

/** Find the boundary of the next word for option+right navigation */
function findNextWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos >= text.length) return text.length;

  let pos = cursorPos;

  // Skip current word forward
  while (pos < text.length && /\S/.test(text.charAt(pos))) {
    pos++;
  }

  // Skip whitespace forward
  while (pos < text.length && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return pos;
}

type WordDirection = "left" | "right";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences require ESC control character
const OPTION_LEFT_PATTERN = /^\u001b\[(?:1;)?(?:3|4|7|8|9)D$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences require ESC control character
const OPTION_RIGHT_PATTERN = /^\u001b\[(?:1;)?(?:3|4|7|8|9)C$/;

function detectOptionWordDirection(sequence: string): WordDirection | null {
  if (!sequence.startsWith("\u001b")) return null;
  if (sequence === "\u001bb" || sequence === "\u001bB") return "left";
  if (sequence === "\u001bf" || sequence === "\u001bF") return "right";
  if (OPTION_LEFT_PATTERN.test(sequence)) return "left";
  if (OPTION_RIGHT_PATTERN.test(sequence)) return "right";
  return null;
}

export function PasteAwareTextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  cursorPosition,
  onCursorMove,
  onBangAtEmpty,
  onBackspaceAtEmpty,
}: PasteAwareTextInputProps) {
  const { internal_eventEmitter } = useStdin();
  const [displayValue, setDisplayValue] = useState(value);
  const [actualValue, setActualValue] = useState(value);
  const lastPasteDetectedAtRef = useRef<number>(0);
  const caretOffsetRef = useRef<number>((value || "").length);
  const [nudgeCursorOffset, setNudgeCursorOffset] = useState<
    number | undefined
  >(undefined);
  const displayValueRef = useRef(displayValue);
  const focusRef = useRef(focus);

  useEffect(() => {
    displayValueRef.current = displayValue;
  }, [displayValue]);

  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  // Apply cursor position from parent
  useEffect(() => {
    if (typeof cursorPosition === "number") {
      setNudgeCursorOffset(cursorPosition);
      caretOffsetRef.current = cursorPosition;
    }
  }, [cursorPosition]);

  const TextInputAny = RawTextInput as unknown as React.ComponentType<{
    value: string;
    onChange: (value: string) => void;
    onSubmit?: (value: string) => void;
    placeholder?: string;
    focus?: boolean;
    externalCursorOffset?: number;
    onCursorOffsetChange?: (n: number) => void;
  }>;

  // Sync external value changes (treat incoming value as DISPLAY value)
  useEffect(() => {
    setDisplayValue(value);
    // Recompute ACTUAL by substituting placeholders via shared registry
    const resolved = resolvePlaceholders(value);
    setActualValue(resolved);

    // Keep caret in bounds when parent updates value (e.g. clearing input).
    // This also ensures mode-switch hotkeys that depend on caret position behave correctly.
    const nextCaret = Math.max(
      0,
      Math.min(caretOffsetRef.current, value.length),
    );
    if (nextCaret !== caretOffsetRef.current) {
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
    }
  }, [value]);

  // Intercept paste events and macOS fallback for image clipboard imports
  useInput(
    (input, key) => {
      // Handle bracketed paste events emitted by vendored Ink
      const isPasted = (key as unknown as { isPasted?: boolean })?.isPasted;
      if (isPasted) {
        lastPasteDetectedAtRef.current = Date.now();

        const payload = typeof input === "string" ? input : "";
        // Translate any image payloads in the paste (OSC 1337, data URLs, file paths)
        let translated = translatePasteForImages(payload);
        // If paste event carried no text (common for image-only clipboard), try macOS import
        if ((!translated || translated.length === 0) && payload.length === 0) {
          const clip = tryImportClipboardImageMac();
          if (clip) translated = clip;
        }

        if (translated && translated.length > 0) {
          // Insert at current caret position
          const at = Math.max(
            0,
            Math.min(caretOffsetRef.current, displayValue.length),
          );
          const isLarge = countLines(translated) > 5 || translated.length > 500;
          if (isLarge) {
            const pasteId = allocatePaste(translated);
            const placeholder = `[Pasted text #${pasteId} +${countLines(translated)} lines]`;
            const newDisplay =
              displayValue.slice(0, at) + placeholder + displayValue.slice(at);
            const newActual =
              actualValue.slice(0, at) + translated + actualValue.slice(at);
            setDisplayValue(newDisplay);
            setActualValue(newActual);
            onChange(newDisplay);
            const nextCaret = at + placeholder.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          } else {
            const displayText = sanitizeForDisplay(translated);
            const newDisplay =
              displayValue.slice(0, at) + displayText + displayValue.slice(at);
            const newActual =
              actualValue.slice(0, at) + translated + actualValue.slice(at);
            setDisplayValue(newDisplay);
            setActualValue(newActual);
            onChange(newDisplay);
            const nextCaret = at + displayText.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          }
          return;
        }
        // If nothing to insert, fall through
      }

      if (
        (key.meta && (input === "v" || input === "V")) ||
        (key.ctrl && key.shift && (input === "v" || input === "V"))
      ) {
        const placeholder = tryImportClipboardImageMac();
        if (placeholder) {
          const at = Math.max(
            0,
            Math.min(caretOffsetRef.current, displayValue.length),
          );
          const newDisplay =
            displayValue.slice(0, at) + placeholder + displayValue.slice(at);
          const newActual =
            actualValue.slice(0, at) + placeholder + actualValue.slice(at);
          setDisplayValue(newDisplay);
          setActualValue(newActual);
          onChange(newDisplay);
          const nextCaret = at + placeholder.length;
          setNudgeCursorOffset(nextCaret);
          caretOffsetRef.current = nextCaret;
        }
      }

      // Backspace on empty input - handle here since handleChange won't fire
      // (value doesn't change when backspacing on empty)
      // Use ref to avoid stale closure issues
      // Note: On macOS, backspace sends \x7f which Ink parses as "delete", not "backspace"
      if ((key.backspace || key.delete) && displayValueRef.current === "") {
        onBackspaceAtEmptyRef.current?.();
        return;
      }
    },
    { isActive: focus },
  );

  // Store callbacks in refs to avoid stale closures in event handlers
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const onBackspaceAtEmptyRef = useRef(onBackspaceAtEmpty);
  useEffect(() => {
    onBackspaceAtEmptyRef.current = onBackspaceAtEmpty;
  }, [onBackspaceAtEmpty]);

  // Consolidated raw stdin handler for Option+Arrow navigation and Option+Delete
  // Uses internal_eventEmitter (Ink's private API) for escape sequences that useInput doesn't parse correctly.
  // Falls back gracefully if internal_eventEmitter is unavailable (useInput handler above still works for some cases).
  useEffect(() => {
    if (!internal_eventEmitter) return undefined;

    const moveCursorToPreviousWord = () => {
      const newPos = findPreviousWordBoundary(
        displayValueRef.current,
        caretOffsetRef.current,
      );
      setNudgeCursorOffset(newPos);
      caretOffsetRef.current = newPos;
    };

    const moveCursorToNextWord = () => {
      const newPos = findNextWordBoundary(
        displayValueRef.current,
        caretOffsetRef.current,
      );
      setNudgeCursorOffset(newPos);
      caretOffsetRef.current = newPos;
    };

    const deletePreviousWord = () => {
      const curPos = caretOffsetRef.current;
      const wordStart = findPreviousWordBoundary(
        displayValueRef.current,
        curPos,
      );
      if (wordStart === curPos) return;

      const newDisplay =
        displayValueRef.current.slice(0, wordStart) +
        displayValueRef.current.slice(curPos);
      const resolvedActual = resolvePlaceholders(newDisplay);

      setDisplayValue(newDisplay);
      setActualValue(resolvedActual);
      onChangeRef.current(newDisplay);
      setNudgeCursorOffset(wordStart);
      caretOffsetRef.current = wordStart;
    };

    const handleRawInput = (payload: unknown) => {
      if (!focusRef.current) return;

      // Extract sequence from payload (may be string or object with sequence property)
      let sequence: string | null = null;
      if (typeof payload === "string") {
        sequence = payload;
      } else if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as { sequence?: unknown }).sequence === "string"
      ) {
        sequence = (payload as { sequence?: string }).sequence ?? null;
      }
      if (!sequence) return;

      // Option+Delete sequences (check first as they're exact matches)
      // - iTerm2/some terminals: ESC + DEL (\x1b\x7f)
      // - Some terminals: ESC + Backspace (\x1b\x08)
      // - Warp: Ctrl+W (\x17)
      // Note: macOS Terminal sends plain \x7f (same as regular delete) - no modifier info
      if (
        sequence === "\x1b\x7f" ||
        sequence === "\x1b\x08" ||
        sequence === "\x1b\b" ||
        sequence === "\x17"
      ) {
        deletePreviousWord();
        return;
      }

      // Option+Arrow navigation (only process escape sequences)
      if (sequence.length <= 32 && sequence.includes("\u001b")) {
        const parts = sequence.split("\u001b");
        for (let i = 1; i < parts.length; i++) {
          const dir = detectOptionWordDirection(`\u001b${parts[i]}`);
          if (dir === "left") {
            moveCursorToPreviousWord();
            return;
          }
          if (dir === "right") {
            moveCursorToNextWord();
            return;
          }
        }
      }
    };

    internal_eventEmitter.prependListener("input", handleRawInput);
    return () => {
      internal_eventEmitter.removeListener("input", handleRawInput);
    };
  }, [internal_eventEmitter]);

  const handleChange = (newValue: string) => {
    // Bash mode entry: intercept "!" typed on empty input BEFORE updating state
    // This prevents any flicker since we never commit the "!" to displayValue
    if (displayValue === "" && newValue === "!") {
      if (onBangAtEmpty?.()) {
        // Parent handled it (entered bash mode) - don't update our state
        return;
      }
    }

    // Drop lone escape characters that Ink's text input would otherwise insert;
    // they are used as control keys for double-escape handling and should not
    // mutate the input value.
    const sanitizedValue = newValue.replaceAll("\u001b", "");
    if (sanitizedValue !== newValue) {
      // Keep caret in bounds after stripping control chars
      const nextCaret = Math.min(caretOffsetRef.current, sanitizedValue.length);
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
      newValue = sanitizedValue;
      // If nothing actually changed after stripping, bail out early
      if (sanitizedValue === displayValue) {
        return;
      }
    }

    // Heuristic: detect large additions that look like pastes
    const addedLen = newValue.length - displayValue.length;
    const lineDelta = countLines(newValue) - countLines(displayValue);
    const sincePasteMs = Date.now() - lastPasteDetectedAtRef.current;

    // If we see a large addition (and it's not too soon after the last paste), treat it as a paste
    if (
      sincePasteMs > 1000 &&
      addedLen > 0 &&
      (addedLen > 500 || lineDelta > 5)
    ) {
      lastPasteDetectedAtRef.current = Date.now();

      // Compute inserted segment via longest common prefix/suffix
      const a = displayValue;
      const b = newValue;
      let lcp = 0;
      while (lcp < a.length && lcp < b.length && a[lcp] === b[lcp]) lcp++;
      let lcs = 0;
      while (
        lcs < a.length - lcp &&
        lcs < b.length - lcp &&
        a[a.length - 1 - lcs] === b[b.length - 1 - lcs]
      )
        lcs++;
      const inserted = b.slice(lcp, b.length - lcs);

      // Translate any image payloads in the inserted text (run always for reliability)
      const translated = translatePasteForImages(inserted);
      const translatedLines = countLines(translated);
      const translatedChars = translated.length;

      // If translated text is still large, create a placeholder
      if (translatedLines > 5 || translatedChars > 500) {
        const pasteId = allocatePaste(translated);
        const placeholder = `[Pasted text #${pasteId} +${translatedLines} lines]`;

        const newDisplayValue =
          a.slice(0, lcp) + placeholder + a.slice(a.length - lcs);
        const newActualValue =
          actualValue.slice(0, lcp) +
          translated +
          actualValue.slice(actualValue.length - lcs);

        setDisplayValue(newDisplayValue);
        setActualValue(newActualValue);
        onChange(newDisplayValue);
        const nextCaret = lcp + placeholder.length;
        setNudgeCursorOffset(nextCaret);
        caretOffsetRef.current = nextCaret;
        return;
      }

      // Otherwise, insert the translated text inline (sanitize newlines for display)
      const displayText = sanitizeForDisplay(translated);
      const newDisplayValue =
        a.slice(0, lcp) + displayText + a.slice(a.length - lcs);
      const newActualValue =
        actualValue.slice(0, lcp) +
        translated +
        actualValue.slice(actualValue.length - lcs);

      setDisplayValue(newDisplayValue);
      setActualValue(newActualValue);
      onChange(newDisplayValue);
      const nextCaret = lcp + displayText.length;
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
      return;
    }

    // Normal typing/edits - update display and compute actual by substituting placeholders
    setDisplayValue(newValue);
    const resolved = resolvePlaceholders(newValue);
    setActualValue(resolved);
    onChange(newValue);
    // Default: cursor moves to end (most common case)
    caretOffsetRef.current = newValue.length;
  };

  const handleSubmit = () => {
    if (onSubmit) {
      // Pass the display value (with placeholders) to onSubmit
      // The parent will handle conversion to content parts and cleanup
      onSubmit(displayValue);
    }
  };

  // Clear one-shot cursor nudge after it applies
  useEffect(() => {
    if (typeof nudgeCursorOffset === "number") {
      const t = setTimeout(() => setNudgeCursorOffset(undefined), 0);
      return () => clearTimeout(t);
    }
  }, [nudgeCursorOffset]);

  return (
    <TextInputAny
      value={displayValue}
      externalCursorOffset={nudgeCursorOffset}
      onCursorOffsetChange={(n: number) => {
        caretOffsetRef.current = n;
        onCursorMove?.(n);
      }}
      onChange={handleChange}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      focus={focus}
    />
  );
}
