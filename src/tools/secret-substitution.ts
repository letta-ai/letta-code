/**
 * Secret handling for shell tool arguments and output.
 */

import stripAnsi from "strip-ansi";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { settingsManager } from "@/settings-manager";
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
 * Ambient values shorter than this are not redacted. Real runtime credentials
 * are long high-entropy strings; short placeholder values (common in dev and
 * test environments, e.g. LETTA_API_KEY=test) would otherwise redact ordinary
 * words out of tool output.
 */
const MIN_AMBIENT_SECRET_LENGTH = 8;

interface AmbientSecretValue {
  name: string;
  value: string;
}

/**
 * Runtime auth values exposed to every shell child through getShellEnv(),
 * whether or not the command text references them. A subprocess that fails —
 * for example an env-file parser that echoes its environment on a parse error —
 * can print these even when the agent never mentioned them, so output
 * scrubbing must always cover them.
 *
 * Sources mirror getShellEnv()'s LETTA_API_KEY resolution: the inherited
 * process env, the persisted settings env, and the Desktop access token
 * (including the base64 git-credential encoding getShellEnv() places in
 * GIT_CONFIG_VALUE_* variables).
 */
function collectAmbientSecretValues(): AmbientSecretValue[] {
  const candidates: AmbientSecretValue[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length < MIN_AMBIENT_SECRET_LENGTH) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ name, value: trimmed });
  };

  add("LETTA_API_KEY", process.env.LETTA_API_KEY);
  try {
    add("LETTA_API_KEY", settingsManager.getSettings().env?.LETTA_API_KEY);
  } catch {
    // Settings not initialized (startup/tests); other sources still apply.
  }

  let desktopAccessToken: string | undefined;
  try {
    desktopAccessToken = getDesktopAccessToken();
  } catch {
    // Desktop session exists but its token is unavailable; other sources apply.
  }
  add("LETTA_API_KEY", desktopAccessToken);
  if (desktopAccessToken) {
    const trimmed = desktopAccessToken.trim();
    if (trimmed.length >= MIN_AMBIENT_SECRET_LENGTH) {
      add("LETTA_API_KEY", Buffer.from(`letta:${trimmed}`).toString("base64"));
    }
  }

  return candidates;
}

/**
 * Merge ambient runtime auth values into an invocation's secret map. Names
 * colliding with invocation secrets are suffixed so a same-named agent secret
 * can never shadow the runtime credential out of the redaction set.
 */
function mergeAmbientSecrets(
  secrets: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const knownValues = new Set(Object.values(secrets));
  for (const { name, value } of collectAmbientSecretValues()) {
    // A launch-time snapshot may already contain this value. Keep its original
    // placeholder name instead of adding a second, suffixed copy.
    if (knownValues.has(value)) continue;
    knownValues.add(value);
    let finalName = name;
    let suffix = 1;
    while (finalName in secrets || finalName in merged) {
      suffix += 1;
      finalName = `${name} (${suffix})`;
    }
    merged[finalName] = value;
  }
  return { ...merged, ...secrets };
}

/**
 * Capture the ambient credentials visible when a tool or child process starts.
 * Keep this map with the invocation: ambient auth may rotate before its output
 * is returned, saved to a file, or sent in a completion notification.
 */
export function captureSecretRedactions(
  secrets: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return mergeAmbientSecrets(secrets);
}

/**
 * The ambient runtime auth values as a name → value record, for redaction
 * systems (e.g. mod tool output) that keep their own secret maps instead of
 * calling scrubSecretsFromString.
 */
export function getAmbientRedactionSecrets(): Record<string, string> {
  return mergeAmbientSecrets({});
}

function scrubWithEntries(
  input: string,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  let result = input;
  // Replace longer values first to avoid partial matches
  const sorted = [...entries].sort(([, a], [, b]) => b.length - a.length);
  for (const [name, value] of sorted) {
    if (value.length > 0) {
      result = result.replaceAll(value, `${name}=<REDACTED>`);
    }
  }
  return result;
}

/**
 * Scrub the supplied secret values from a string, replacing them with an
 * explicit placeholder that makes it unambiguous to the LLM that the value is
 * hidden. Ambient runtime auth values (at minimum the effective LETTA_API_KEY)
 * are always scrubbed as well, even when the caller passes no secrets.
 */
export function scrubSecretsFromString(
  input: string,
  secrets: Readonly<Record<string, string>>,
): string {
  return scrubWithEntries(input, Object.entries(mergeAmbientSecrets(secrets)));
}

/**
 * Scrub only the ambient runtime auth values from a string. For text produced
 * by hook or mod code — user-configured commands whose children inherit the
 * runtime environment — rather than by a shell tool invocation.
 */
export function scrubAmbientSecrets(text: string): string {
  return scrubSecretsFromString(text, {});
}

export interface SecretStreamScrubber {
  /** Scrub one chunk; may return "" while holding back a potential partial match. */
  push(chunk: string): string;
  /** Scrub and return any held-back remainder at end of stream. */
  flush(): string;
}

/**
 * Length of the longest suffix of `text` that is a prefix (proper or complete)
 * of any secret value. Such a suffix could be part of a secret occurrence that
 * ends at or beyond the buffer boundary, so it must be held back rather than
 * emitted partially scrubbed.
 */
function secretPrefixSuffixLength(
  text: string,
  values: readonly string[],
  maxLength: number,
): number {
  const upper = Math.min(text.length, maxLength);
  for (let length = upper; length > 0; length--) {
    const suffix = text.slice(text.length - length);
    for (const value of values) {
      if (value.startsWith(suffix)) {
        return length;
      }
    }
  }
  return 0;
}

/**
 * Stream-safe secret scrubber. Plain per-chunk replacement misses a credential
 * split across two stream chunks; this scrubber holds back any trailing bytes
 * that could be the beginning of a secret and emits them once later chunks
 * (or flush()) prove whether the match completes.
 */
export function createSecretStreamScrubber(
  secrets: Readonly<Record<string, string>> = {},
): SecretStreamScrubber {
  const entries = Object.entries(mergeAmbientSecrets(secrets)).filter(
    ([, value]) => value.length > 0,
  );
  const values = entries.map(([, value]) => value);
  const maxLength = values.reduce(
    (max, value) => Math.max(max, value.length),
    0,
  );
  let tail = "";

  if (maxLength === 0) {
    return {
      push(chunk: string): string {
        return chunk;
      },
      flush(): string {
        return "";
      },
    };
  }

  return {
    push(chunk: string): string {
      const buffer = tail + chunk;
      const holdback = secretPrefixSuffixLength(buffer, values, maxLength);
      tail = holdback > 0 ? buffer.slice(buffer.length - holdback) : "";
      const emittable =
        holdback > 0 ? buffer.slice(0, buffer.length - holdback) : buffer;
      return scrubWithEntries(emittable, entries);
    },
    flush(): string {
      const rest = tail;
      tail = "";
      return scrubWithEntries(rest, entries);
    },
  };
}

export interface ScrubbedOutputStreamer {
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void;
  flush: () => void;
}

/**
 * Wrap a streaming output callback with chunk-boundary-safe secret scrubbing.
 * flush() emits any held-back tail once the producer has finished.
 */
export function createScrubbedOutputStreamer(
  secrets: Readonly<Record<string, string>>,
  emit: (chunk: string, stream: "stdout" | "stderr") => void,
  transformChunk?: (chunk: string) => string,
): ScrubbedOutputStreamer {
  const scrubbers = {
    stdout: createSecretStreamScrubber(secrets),
    stderr: createSecretStreamScrubber(secrets),
  };
  return {
    onOutput(chunk, stream) {
      const scrubbed = scrubbers[stream].push(
        transformChunk ? transformChunk(chunk) : chunk,
      );
      if (scrubbed) emit(scrubbed, stream);
    },
    flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        const rest = scrubbers[stream].flush();
        if (rest) emit(rest, stream);
      }
    },
  };
}

function sanitizeText(
  text: string,
  secrets: Readonly<Record<string, string>>,
  stripAnsiEscapes: boolean,
): string {
  const scrubbed = scrubSecretsFromString(text, secrets);
  return stripAnsiEscapes ? stripAnsi(scrubbed) : scrubbed;
}

/**
 * Scrub secret values from a tool's model-facing return content. Always covers
 * the ambient runtime auth values, even when `secrets` is empty.
 */
export function sanitizeToolReturnContent<
  T extends string | Array<{ type?: string; text?: unknown }>,
>(
  content: T,
  secrets: Readonly<Record<string, string>>,
  stripAnsiEscapes: boolean,
): T {
  if (typeof content === "string") {
    return sanitizeText(content, secrets, stripAnsiEscapes) as T;
  }
  return content.map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? { ...block, text: sanitizeText(block.text, secrets, stripAnsiEscapes) }
      : block,
  ) as T;
}

/** Scrub secret values from captured stdout/stderr lines, in place. */
export function sanitizeOutputLines(
  lines: string[],
  secrets: Readonly<Record<string, string>>,
  stripAnsiEscapes: boolean,
): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined) {
      lines[i] = sanitizeText(line, secrets, stripAnsiEscapes);
    }
  }
}
