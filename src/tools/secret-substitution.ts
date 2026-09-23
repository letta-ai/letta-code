/**
 * Secret handling for shell tool arguments and output.
 */

import { loadSecrets } from "@/utils/secrets-store";

/**
 * Pattern to match $SECRET_NAME references where SECRET_NAME is uppercase with
 * underscores, including braced shell forms.
 * Examples: $API_KEY, ${API_KEY}, ${API_KEY:-}, ${#API_KEY}, ${!API_KEY}
 *
 * Braced forms matter: `${NAME}` and the set -u safe `"${NAME:-}"` are
 * standard shell, and an agent that writes them would otherwise get an empty
 * value and conclude the secret is unset even though it exists.
 */
const SECRET_PATTERN = /\$(?:\{[#!]?)?([A-Z_][A-Z0-9_]*)/g;

/**
 * Scan a command string or command-argument array for `$SECRET_NAME`
 * references and build an env map of matching secrets from the store.
 * The shell will expand these vars natively, so secret values never get
 * injected into the command string itself.
 */
export function extractSecretEnvFromCommand(
  command: string | readonly string[],
  agentId?: string,
): Record<string, string> {
  const secrets = loadSecrets(agentId);
  const env: Record<string, string> = {};

  const scan = (text: string) => {
    for (const match of text.matchAll(SECRET_PATTERN)) {
      const name = match[1];
      if (name !== undefined && secrets[name] !== undefined) {
        env[name] = secrets[name];
      }
    }
  };

  if (typeof command === "string") {
    scan(command);
    return env;
  }

  for (const part of command) {
    if (typeof part === "string") {
      scan(part);
    }
  }

  return env;
}

/**
 * Scrub the supplied secret values from a string, replacing them with an
 * explicit placeholder that makes it unambiguous to the LLM that the value is
 * hidden. Callers pass only the secrets available to the current tool invocation.
 */
export function scrubSecretsFromString(
  input: string,
  secrets: Readonly<Record<string, string>>,
): string {
  let result = input;
  // Replace longer values first to avoid partial matches
  const entries = Object.entries(secrets).sort(
    ([, a], [, b]) => b.length - a.length,
  );
  for (const [name, value] of entries) {
    if (value.length > 0) {
      result = result.replaceAll(value, `${name}=<REDACTED>`);
    }
  }
  return result;
}

/** Redacts invocation secrets from output that arrives in chunks. */
export interface StreamingSecretScrubber {
  /** Accept the next chunk and return the redacted text that is safe to emit. */
  push(text: string): string;
  /** Return the redacted remainder once the stream has ended. */
  flush(): string;
}

/**
 * Redact secrets from one output stream, including a secret that a process
 * prints across several writes. Scrubbing each chunk on its own misses such a
 * secret, so this holds back the end of the stream while a secret could still
 * complete it and emits that text once the next chunk or the end of the stream
 * settles it. With no secrets, every chunk passes through unchanged.
 */
export function createStreamingSecretScrubber(
  secrets: Readonly<Record<string, string>>,
): StreamingSecretScrubber {
  const values = Object.values(secrets).filter((value) => value.length > 0);
  let pending = "";

  return {
    push(text) {
      if (values.length === 0) return text;
      const buffered = pending + text;
      const boundary = findEmitBoundary(buffered, values);
      pending = buffered.slice(boundary);
      return scrubSecretsFromString(buffered.slice(0, boundary), secrets);
    },
    flush() {
      const rest = pending;
      pending = "";
      return scrubSecretsFromString(rest, secrets);
    },
  };
}

/** Redacts a process's stdout and stderr, each as its own stream. */
export interface OutputRedactor {
  /** Redact the next chunk of one stream and record what is safe to emit. */
  push(text: string, stream: "stdout" | "stderr"): void;
  /** Record the text still held back, once the process has ended. */
  flush(): void;
}

/**
 * Redact a process's output as it arrives and pass each non-empty redacted
 * piece to `record`. The streams are redacted separately because they
 * interleave: joining them could split a secret, or pair halves printed to
 * different streams. Call `flush` once the process has ended.
 */
export function createOutputRedactor(
  secrets: Readonly<Record<string, string>>,
  record: (redactedText: string, stream: "stdout" | "stderr") => void,
): OutputRedactor {
  const scrubbers = {
    stdout: createStreamingSecretScrubber(secrets),
    stderr: createStreamingSecretScrubber(secrets),
  };
  const emit = (text: string, stream: "stdout" | "stderr") => {
    if (text) record(text, stream);
  };
  return {
    push(text, stream) {
      emit(scrubbers[stream].push(text), stream);
    },
    flush() {
      emit(scrubbers.stdout.flush(), "stdout");
      emit(scrubbers.stderr.flush(), "stderr");
    },
  };
}

/**
 * Find how much of the buffered text can be emitted. Everything from the
 * longest suffix that begins a secret is held, and so is any complete secret
 * that would otherwise be cut in two by that split.
 */
function findEmitBoundary(text: string, values: readonly string[]): number {
  let boundary = text.length;
  for (const value of values) {
    for (
      let start = Math.max(0, text.length - value.length + 1);
      start < boundary;
      start++
    ) {
      if (beginsSecret(text, start, value)) {
        boundary = start;
        break;
      }
    }
  }

  let moved = true;
  while (moved) {
    moved = false;
    for (const value of values) {
      const start = text.indexOf(
        value,
        Math.max(0, boundary - value.length + 1),
      );
      if (start !== -1 && start < boundary) {
        boundary = start;
        moved = true;
      }
    }
  }
  return boundary;
}

/** Whether the text from `start` to its end is the beginning of `value`. */
function beginsSecret(text: string, start: number, value: string): boolean {
  for (let offset = 0; start + offset < text.length; offset++) {
    if (text.charCodeAt(start + offset) !== value.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}
