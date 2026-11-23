import { useInput, useStdin } from "ink";
import RawTextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import {
  translatePasteForImages,
  tryImportClipboardImageMac,
} from "@/cli/helpers/clipboard";
import {
  allocatePaste,
  resolvePlaceholders,
} from "@/cli/helpers/paste-registry";

declare global {
  // eslint-disable-next-line no-var
  var __lettaForwardDeleteTimestamp: number | undefined;
}

interface PasteAwareTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  cursorPosition?: number;
  onCursorMove?: (position: number) => void;

  onBangAtEmpty?: () => boolean;

  onBackspaceAtEmpty?: () => boolean;

  onPasteError?: (message: string) => void;
}

function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length + 1;
}

function sanitizeForDisplay(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "↵");
}

function findPreviousWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos === 0) return 0;

  let pos = cursorPos - 1;

  while (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos--;
  }

  while (pos > 0 && /\S/.test(text.charAt(pos))) {
    pos--;
  }

  if (pos > 0 && /\s/.test(text.charAt(pos))) {
    pos++;
  }

  return Math.max(0, pos);
}

function findNextWordBoundary(text: string, cursorPos: number): number {
  if (cursorPos >= text.length) return text.length;

  let pos = cursorPos;

  while (pos < text.length && /\S/.test(text.charAt(pos))) {
    pos++;
  }

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
  onPasteError,
}: PasteAwareTextInputProps) {
  const { internal_eventEmitter } = useStdin();
  const [displayValue, setDisplayValue] = useState(value);
  const [actualValue, setActualValue] = useState(() =>
    resolvePlaceholders(value),
  );
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

  useEffect(() => {
    if (value === displayValue) {
      return;
    }
    setDisplayValue(value);
    const resolved = resolvePlaceholders(value);
    setActualValue(resolved);

    const nextCaret = Math.max(
      0,
      Math.min(caretOffsetRef.current, value.length),
    );
    if (nextCaret !== caretOffsetRef.current) {
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
    }
  }, [value, displayValue]);

  useInput(
    (input, key) => {
      if (key.return && (key.shift || key.meta || key.ctrl)) {
        const at = Math.max(
          0,
          Math.min(caretOffsetRef.current, displayValueRef.current.length),
        );

        const newValue =
          displayValueRef.current.slice(0, at) +
          "\n" +
          displayValueRef.current.slice(at);

        setDisplayValue(newValue);
        setActualValue(newValue);
        onChangeRef.current(newValue);

        const nextCaret = at + 1;
        setNudgeCursorOffset(nextCaret);
        caretOffsetRef.current = nextCaret;
        return;
      }

      if (key.ctrl && input === "v") {
        (async () => {
          const result = await tryImportClipboardImageMac();
          if (result) {
            if ("error" in result) {
              onPasteErrorRef.current?.(result.error);
              return;
            }
            const clip = result.placeholder;
            const at = Math.max(
              0,
              Math.min(caretOffsetRef.current, displayValueRef.current.length),
            );
            const newDisplay =
              displayValueRef.current.slice(0, at) +
              clip +
              displayValueRef.current.slice(at);
            displayValueRef.current = newDisplay;
            setDisplayValue(newDisplay);
            setActualValue(newDisplay);
            onChangeRef.current(newDisplay);
            const nextCaret = at + clip.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          }
        })();
        return;
      }

      const isPasted = (key as unknown as { isPasted?: boolean })?.isPasted;
      if (isPasted) {
        lastPasteDetectedAtRef.current = Date.now();

        const payload = typeof input === "string" ? input : "";
        const translated = translatePasteForImages(payload);

        const insertTranslated = (text: string) => {
          const at = Math.max(
            0,
            Math.min(caretOffsetRef.current, displayValue.length),
          );
          const isLarge = countLines(text) > 5 || text.length > 500;
          if (isLarge) {
            const pasteId = allocatePaste(text);
            const placeholder = `[Pasted text #${pasteId} +${countLines(text)} lines]`;
            const newDisplay =
              displayValue.slice(0, at) + placeholder + displayValue.slice(at);
            const newActual =
              actualValue.slice(0, at) + text + actualValue.slice(at);
            setDisplayValue(newDisplay);
            setActualValue(newActual);
            onChange(newDisplay);
            const nextCaret = at + placeholder.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          } else {
            const displayText = sanitizeForDisplay(text);
            const newDisplay =
              displayValue.slice(0, at) + displayText + displayValue.slice(at);
            const newActual =
              actualValue.slice(0, at) + text + actualValue.slice(at);
            setDisplayValue(newDisplay);
            setActualValue(newActual);
            onChange(newDisplay);
            const nextCaret = at + displayText.length;
            setNudgeCursorOffset(nextCaret);
            caretOffsetRef.current = nextCaret;
          }
        };

        if ((!translated || translated.length === 0) && payload.length === 0) {
          (async () => {
            const clipResult = await tryImportClipboardImageMac();
            if (clipResult) {
              if ("error" in clipResult) {
                onPasteErrorRef.current?.(clipResult.error);
                return;
              }
              insertTranslated(clipResult.placeholder);
            }
          })();
          return;
        }

        if (translated && translated.length > 0) {
          insertTranslated(translated);
          return;
        }
      }

      if (
        (key.meta && (input === "v" || input === "V")) ||
        (key.ctrl && key.shift && (input === "v" || input === "V"))
      ) {
        (async () => {
          const result = await tryImportClipboardImageMac();
          if (result) {
            if ("error" in result) {
              onPasteErrorRef.current?.(result.error);
              return;
            }
            const placeholder = result.placeholder;
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
        })();
      }

      if ((key.backspace || key.delete) && displayValueRef.current === "") {
        onBackspaceAtEmptyRef.current?.();
        return;
      }
    },
    { isActive: focus },
  );

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const onBackspaceAtEmptyRef = useRef(onBackspaceAtEmpty);
  useEffect(() => {
    onBackspaceAtEmptyRef.current = onBackspaceAtEmpty;
  }, [onBackspaceAtEmpty]);

  const onPasteErrorRef = useRef(onPasteError);
  useEffect(() => {
    onPasteErrorRef.current = onPasteError;
  }, [onPasteError]);

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

    const forwardDeleteAtCursor = (cursorPos: number) => {
      if (cursorPos >= displayValueRef.current.length) return;

      const newDisplay =
        displayValueRef.current.slice(0, cursorPos) +
        displayValueRef.current.slice(cursorPos + 1);
      const resolvedActual = resolvePlaceholders(newDisplay);

      displayValueRef.current = newDisplay;
      caretOffsetRef.current = cursorPos;

      setDisplayValue(newDisplay);
      setActualValue(resolvedActual);
      onChangeRef.current(newDisplay);
      setNudgeCursorOffset(cursorPos);
    };

    const insertNewlineAtCursor = () => {
      const at = Math.max(
        0,
        Math.min(caretOffsetRef.current, displayValueRef.current.length),
      );

      const newValue =
        displayValueRef.current.slice(0, at) +
        "\n" +
        displayValueRef.current.slice(at);

      setDisplayValue(newValue);
      setActualValue(newValue);
      onChangeRef.current(newValue);

      const nextCaret = at + 1;
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
    };

    const moveCursorToStart = () => {
      setNudgeCursorOffset(0);
      caretOffsetRef.current = 0;
    };

    const moveCursorToEnd = () => {
      const endPos = displayValueRef.current.length;
      setNudgeCursorOffset(endPos);
      caretOffsetRef.current = endPos;
    };

    const handleRawInput = (payload: unknown) => {
      if (!focusRef.current) return;

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

      if (process.env.LETTA_DEBUG_INPUT === "1") {
        const debugHex = [...sequence]
          .map((c) => `0x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
          .join(" ");
        // eslint-disable-next-line no-console
        console.error(
          `[debug:raw-input] len=${sequence.length} hex: ${debugHex}`,
        );
      }

      if (sequence === "\x1b\r" || sequence === "\x1b\n") {
        insertNewlineAtCursor();
        return;
      }

      if (sequence === "\\r") {
        insertNewlineAtCursor();
        return;
      }

      if (
        sequence === "\x1b[H" ||
        sequence === "\x1b[1~" ||
        sequence === "\x1bOH"
      ) {
        moveCursorToStart();
        return;
      }

      if (
        sequence === "\x1b[F" ||
        sequence === "\x1b[4~" ||
        sequence === "\x1bOF"
      ) {
        moveCursorToEnd();
        return;
      }

      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC sequence matching
      if (sequence === "\x1b[3~" || /^\x1b\[3;\d+~$/.test(sequence)) {
        globalThis.__lettaForwardDeleteTimestamp = Date.now();
        forwardDeleteAtCursor(caretOffsetRef.current);
        return;
      }

      if (
        sequence === "\x1b\x7f" ||
        sequence === "\x1b\x08" ||
        sequence === "\x1b\b" ||
        sequence === "\x17"
      ) {
        deletePreviousWord();
        return;
      }

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
    if (displayValue === "" && newValue === "!") {
      if (onBangAtEmpty?.()) {
        return;
      }
    }

    const sanitizedValue = newValue.replaceAll("\u001b", "");
    if (sanitizedValue !== newValue) {
      const nextCaret = Math.min(caretOffsetRef.current, sanitizedValue.length);
      setNudgeCursorOffset(nextCaret);
      caretOffsetRef.current = nextCaret;
      newValue = sanitizedValue;
      if (sanitizedValue === displayValue) {
        return;
      }
    }

    const addedLen = newValue.length - displayValue.length;
    const lineDelta = countLines(newValue) - countLines(displayValue);
    const sincePasteMs = Date.now() - lastPasteDetectedAtRef.current;

    if (
      sincePasteMs > 1000 &&
      addedLen > 0 &&
      (addedLen > 500 || lineDelta > 5)
    ) {
      lastPasteDetectedAtRef.current = Date.now();

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

      const translated = translatePasteForImages(inserted);
      const translatedLines = countLines(translated);
      const translatedChars = translated.length;

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

    displayValueRef.current = newValue;
    setDisplayValue(newValue);
    const resolved = resolvePlaceholders(newValue);
    setActualValue(resolved);
    onChange(newValue);
  };

  const handleSubmit = () => {
    if (onSubmit) {
      onSubmit(displayValue);
    }
  };

  useEffect(() => {
    if (typeof nudgeCursorOffset === "number") {
      const t = setTimeout(() => setNudgeCursorOffset(undefined), 0);
      return () => clearTimeout(t);
    }
    return undefined;
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
