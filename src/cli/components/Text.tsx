import { Text as InkText, type TextProps } from "ink";
import type { ReactNode } from "react";

const isBun = typeof Bun !== "undefined";
const decoder = new TextDecoder("utf-8", { fatal: false });

function fixBunEncoding(value: ReactNode): ReactNode {
  if (!isBun) return value;

  if (typeof value === "string") {
    // Quick check: if no non-ASCII characters, return as-is
    if (!/[\x80-\xFF]/.test(value)) return value;

    const bytes: number[] = [];

    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);

      // Check for 2-byte UTF-8 sequence: 0xC2 followed by 0x80-0xBF
      if (code === 0xc2 && i + 1 < value.length) {
        const nextCode = value.charCodeAt(i + 1);
        if (nextCode >= 0x80 && nextCode <= 0xbf) {
          bytes.push(0xc2, nextCode);
          i++;
          continue;
        }
      }

      bytes.push(code);
    }

    return decoder.decode(new Uint8Array(bytes));
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
