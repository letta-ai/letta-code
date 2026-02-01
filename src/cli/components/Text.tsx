import { Text as InkText, type TextProps } from "ink";
import type { ReactNode } from "react";

const isBun = typeof Bun !== "undefined";
const decoder = new TextDecoder("utf-8", { fatal: false });

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function looksLikeMojibake(value: string): boolean {
  let sawUtf8Sequence = false;

  for (let i = 0; i < value.length; i++) {
    const byte = value.charCodeAt(i);

    // If any code unit is outside byte range, it's real Unicode already.
    if (byte > 0xff) return false;

    if (byte >= 0xc2 && byte <= 0xdf) {
      if (i + 1 < value.length && isContinuationByte(value.charCodeAt(i + 1))) {
        sawUtf8Sequence = true;
        i += 1;
        continue;
      }
    }

    if (byte >= 0xe0 && byte <= 0xef) {
      if (
        i + 2 < value.length &&
        isContinuationByte(value.charCodeAt(i + 1)) &&
        isContinuationByte(value.charCodeAt(i + 2))
      ) {
        sawUtf8Sequence = true;
        i += 2;
        continue;
      }
    }

    if (byte >= 0xf0 && byte <= 0xf4) {
      if (
        i + 3 < value.length &&
        isContinuationByte(value.charCodeAt(i + 1)) &&
        isContinuationByte(value.charCodeAt(i + 2)) &&
        isContinuationByte(value.charCodeAt(i + 3))
      ) {
        sawUtf8Sequence = true;
        i += 3;
      }
    }
  }

  return sawUtf8Sequence;
}

function fixBunEncoding(value: ReactNode): ReactNode {
  if (!isBun) return value;

  if (typeof value === "string") {
    // Quick check: if no non-ASCII characters, return as-is
    if (!/[\x80-\xFF]/.test(value)) return value;

    if (!looksLikeMojibake(value)) return value;

    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      bytes[i] = value.charCodeAt(i);
    }
    return decoder.decode(bytes);
  }

  // Handle arrays of children
  if (Array.isArray(value)) {
    return value.map(fixBunEncoding);
  }

  return value;
}

export function Text({ children, ...props }: TextProps) {
  return <InkText {...props}>{fixBunEncoding(children)}</InkText>;
}
