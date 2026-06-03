/**
 * Terminal-title output helpers for the TUI.
 *
 * This mirrors Codex's narrow OSC title writer: callers decide when a title
 * should change, while this module owns sanitization and the BEL-terminated OSC
 * 0 write. It does not try to restore the terminal's previous title because
 * that is not portable across terminals.
 */

const MAX_TERMINAL_TITLE_CHARS = 240;

export type SetTerminalTitleResult = "applied" | "no-visible-content";

export function setTerminalTitle(title: string): SetTerminalTitleResult {
  if (!process.stdout.isTTY) {
    return "applied";
  }

  const sanitized = sanitizeTerminalTitle(title);
  if (sanitized.length === 0) {
    return "no-visible-content";
  }

  process.stdout.write(terminalTitleOsc(sanitized));
  return "applied";
}

export function clearTerminalTitle(): void {
  if (!process.stdout.isTTY) {
    return;
  }

  process.stdout.write(terminalTitleOsc(""));
}

export function terminalTitleOsc(title: string): string {
  return `\x1b]0;${title}\x07`;
}

export function sanitizeTerminalTitle(title: string): string {
  let sanitized = "";
  let charsWritten = 0;
  let pendingSpace = false;

  for (const ch of title) {
    if (/\s/u.test(ch)) {
      pendingSpace = sanitized.length > 0;
      continue;
    }

    if (isDisallowedTerminalTitleChar(ch)) {
      continue;
    }

    if (pendingSpace) {
      const remaining = MAX_TERMINAL_TITLE_CHARS - charsWritten;
      if (remaining > 1) {
        sanitized += " ";
        charsWritten += 1;
        pendingSpace = false;
      }
    }

    if (charsWritten >= MAX_TERMINAL_TITLE_CHARS) {
      break;
    }

    sanitized += ch;
    charsWritten += 1;
  }

  return sanitized;
}

function isDisallowedTerminalTitleChar(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) {
    return true;
  }

  if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
    return true;
  }

  return (
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    (code >= 0xfff9 && code <= 0xfffb) ||
    (code >= 0x1bca0 && code <= 0x1bca3) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}
