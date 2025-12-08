// Paste-aware text input wrapper that:
// 1. Detects large pastes (>5 lines or >500 chars) and replaces with placeholders
// 2. Supports image pasting (iTerm2 inline, data URLs, file paths, macOS clipboard)
// 3. Maintains separate display value (with placeholders) vs actual value (full content)
// 4. Resolves placeholders on submit

// Import useInput from vendored Ink for bracketed paste support
import { useInput } from "ink";
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
  while (pos > 0 && /\s/.test(text[pos])) {
    pos--;
  }
  
  // Skip word characters backwards
  while (pos > 0 && /\S/.test(text[pos])) {
    pos--;
  }
  
  // If we stopped at whitespace, move forward one
  if (pos > 0 && /\s/.test(text[pos])) {
    pos++;
  }
  
  return Math.max(0, pos);
}

/** Find the boundary of the next word for option+right navigation */
function findNextWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos >= text.length) return text.length;
  
  let pos = cursorPos;
  
  // Skip current word forward
  while (pos < text.length && /\S/.test(text[pos])) {
    pos++;
  }
  
  // Skip whitespace forward
  while (pos < text.length && /\s/.test(text[pos])) {
    pos++;
  }
  
  return pos;
}

export function PasteAwareTextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus = true,
  cursorPosition,
  onCursorMove,
}: PasteAwareTextInputProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [actualValue, setActualValue] = useState(value);
  const lastPasteDetectedAtRef = useRef<number>(0);
  const suppressNextChangeRef = useRef<boolean>(false);
  const caretOffsetRef = useRef<number>((value || "").length);
  const [nudgeCursorOffset, setNudgeCursorOffset] = useState<
    number | undefined
  >(undefined);

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
    },
    { isActive: focus },
  );

  // Handle option+arrow keys for word-by-word navigation
  useInput(
    (input, key) => {
      // Option+Left: move to previous word
      if (key.meta && key.leftArrow) {
        const newPos = findPreviousWordBoundary(displayValue, caretOffsetRef.current);
        setNudgeCursorOffset(newPos);
        caretOffsetRef.current = newPos;
        return;
      }
      
      // Option+Right: move to next word
      if (key.meta && key.rightArrow) {
        const newPos = findNextWordBoundary(displayValue, caretOffsetRef.current);
        setNudgeCursorOffset(newPos);
        caretOffsetRef.current = newPos;
        return;
      }
    },
    { isActive: focus },
  );

  const handleChange = (newValue: string) => {
    // If we just handled a paste via useInput, ignore this immediate change
    if (suppressNextChangeRef.current) {
      suppressNextChangeRef.current = false;
      return;
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
