import stripAnsi from "strip-ansi";
import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { peekOrgAccessToken } from "@/auth/org-credentials-session";
import { getMcpScopeAgentId, lookupParentAgent } from "@/mcp-scope";
import { settingsManager } from "@/settings-manager";
import { ensureSecretsLoaded, loadSecrets } from "@/utils/secrets-store";
import { ensureVariablesLoaded, loadVariables } from "@/utils/variables-store";

const SECRET_PATTERN = /\$(?:\{[#!]?)?([A-Z_][A-Z0-9_]*)/g;

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

const parentLookups = new Map<string, Promise<string | undefined>>();
function cachedLookupParentAgent(agentId: string) {
  let lookup = parentLookups.get(agentId);
  if (!lookup) {
    lookup = lookupParentAgent(agentId);
    lookup.catch(() => parentLookups.delete(agentId));
    parentLookups.set(agentId, lookup);
  }
  return lookup;
}

export async function resolveSecretEnvFromCommand(
  command: string | readonly string[],
  agentId?: string,
): Promise<Record<string, string>> {
  const own = extractSecretEnvFromCommand(command, agentId);
  const parts = typeof command === "string" ? [command] : command;
  const missing = parts.some((part) =>
    [...part.matchAll(SECRET_PATTERN)].some(
      (match) => match[1] !== undefined && !(match[1] in own),
    ),
  );
  if (!agentId || !missing) return own;
  try {
    const scopeAgentId = await getMcpScopeAgentId(
      agentId,
      undefined,
      cachedLookupParentAgent,
    );
    if (scopeAgentId === agentId) return own;
    await ensureSecretsLoaded(scopeAgentId);
    return { ...extractSecretEnvFromCommand(command, scopeAgentId), ...own };
  } catch {
    return own;
  }
}

export async function resolveShellEnvironment(
  command: unknown,
  agentId?: string,
): Promise<{
  secretEnv: Record<string, string>;
  variableEnv: Record<string, string>;
}> {
  if (
    typeof command !== "string" &&
    !(
      Array.isArray(command) &&
      command.every((part) => typeof part === "string")
    )
  )
    return { secretEnv: {}, variableEnv: {} };
  return {
    secretEnv: await resolveSecretEnvFromCommand(command, agentId),
    variableEnv: await resolveVariableEnvFromCommand(command, agentId),
  };
}

export async function resolveVariableEnvFromCommand(
  command: string | readonly string[],
  agentId?: string,
): Promise<Record<string, string>> {
  const parts = typeof command === "string" ? [command] : command;
  if (!parts.some((part) => [...part.matchAll(SECRET_PATTERN)].length > 0))
    return {};
  try {
    await ensureVariablesLoaded(agentId);
  } catch {}
  let values: Record<string, string>;
  try {
    values = loadVariables(agentId);
  } catch {
    return {};
  }
  if (agentId) {
    try {
      const parent = await getMcpScopeAgentId(
        agentId,
        undefined,
        cachedLookupParentAgent,
      );
      if (parent !== agentId) {
        await ensureVariablesLoaded(parent);
        values = { ...loadVariables(parent), ...values };
      }
    } catch {}
  }
  const env: Record<string, string> = {};
  for (const part of typeof command === "string" ? [command] : command) {
    for (const match of part.matchAll(SECRET_PATTERN)) {
      const key = match[1];
      if (key !== undefined && values[key] !== undefined)
        env[key] = values[key];
    }
  }
  return env;
}

const MIN_AMBIENT_SECRET_LENGTH = 8;

const MIN_VAULT_SECRET_LENGTH = 8;

interface AmbientSecretValue {
  name: string;
  value: string;
}

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
  } catch {}

  let desktopAccessToken: string | undefined;
  try {
    desktopAccessToken = getDesktopAccessToken();
  } catch {}
  add("LETTA_API_KEY", desktopAccessToken);
  const orgAccessToken = peekOrgAccessToken();
  add("LETTA_API_KEY", orgAccessToken);
  const sessionAccessToken = orgAccessToken ?? desktopAccessToken;
  if (sessionAccessToken) {
    const trimmed = sessionAccessToken.trim();
    if (trimmed.length >= MIN_AMBIENT_SECRET_LENGTH) {
      add("LETTA_API_KEY", Buffer.from(`letta:${trimmed}`).toString("base64"));
    }
  }

  return candidates;
}

function collectVaultSecretValues(
  scopedAgentId?: string | null,
): AmbientSecretValue[] {
  let vault: Record<string, string>;
  try {
    vault = loadSecrets(scopedAgentId ?? undefined);
  } catch {
    return [];
  }
  const candidates: AmbientSecretValue[] = [];
  for (const [name, value] of Object.entries(vault)) {
    // Agent identifiers are used in navigable links, including the vault URL.
    if (name === "LETTA_AGENT_ID" || name === "AGENT_ID") continue;
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length < MIN_VAULT_SECRET_LENGTH) continue;
    candidates.push({ name, value: trimmed });
  }
  return candidates;
}

function mergeAmbientSecrets(
  secrets: Readonly<Record<string, string>>,
  scopedAgentId?: string | null,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const knownValues = new Set(Object.values(secrets));
  const ambient = [
    ...collectAmbientSecretValues(),
    ...collectVaultSecretValues(scopedAgentId),
  ];
  for (const { name, value } of ambient) {
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

export function captureSecretRedactions(
  scopedAgentId?: string | null,
  secrets: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return mergeAmbientSecrets(secrets, scopedAgentId);
}

export function getAmbientRedactionSecrets(
  scopedAgentId?: string,
): Record<string, string> {
  return mergeAmbientSecrets({}, scopedAgentId);
}

function scrubWithEntries(
  input: string,
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  const forms = entries.flatMap(([name, value]) => {
    const escaped = JSON.stringify(value).slice(1, -1);
    return escaped === value
      ? [[name, value] as const]
      : [[name, value] as const, [name, escaped] as const];
  });
  let result = input;
  forms.sort(([, a], [, b]) => b.length - a.length);
  for (const [name, value] of forms) {
    if (value.length > 0) {
      result = result.replaceAll(value, `${name}=<REDACTED>`);
    }
  }
  return result;
}

export function scrubSecretsDeep<T>(
  value: T,
  secrets: Readonly<Record<string, string>>,
): T {
  const entries = Object.entries(secrets);
  if (entries.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return scrubWithEntries(node, entries);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, walk(child)]),
      );
    }
    return node;
  };
  return walk(value) as T;
}

export function scrubSecretsFromString(
  input: string,
  secrets: Readonly<Record<string, string>>,
  scopedAgentId?: string,
): string {
  return scrubWithEntries(
    input,
    Object.entries(mergeAmbientSecrets(secrets, scopedAgentId)),
  );
}

export function scrubAmbientSecrets(text: string): string {
  return scrubSecretsFromString(text, {});
}

export function scrubOutgoingMessageContent<
  T extends { type?: string; text?: unknown },
>(content: string | T[], scopedAgentId?: string): string | T[] {
  if (typeof content === "string") {
    return scrubSecretsFromString(content, {}, scopedAgentId);
  }
  return content.map((part) =>
    part.type === "text" && typeof part.text === "string"
      ? {
          ...part,
          text: scrubSecretsFromString(part.text, {}, scopedAgentId),
        }
      : part,
  );
}

export interface SecretStreamScrubber {
  push(chunk: string): string;
  flush(): string;
}

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

export type InvocationSecretRedactions = Map<string, string>;

export function scrubInvocationSecretRedactions(
  input: string,
  redactions: InvocationSecretRedactions,
): string {
  let result = input;
  const entries = Array.from(redactions.entries()).sort(
    ([, a], [, b]) => b.length - a.length,
  );
  for (const [name, value] of entries) {
    if (value.length > 0) {
      result = result.replaceAll(value, `${name}=<REDACTED>`);
    }
  }
  return result;
}

export function scrubModToolString(
  input: string,
  redactions: InvocationSecretRedactions,
): string {
  return scrubInvocationSecretRedactions(input, redactions);
}

export function scrubModToolReturnContent<
  T extends { type?: string; text?: unknown },
>(content: string | T[], redactions: InvocationSecretRedactions): string | T[] {
  if (typeof content === "string") {
    return scrubModToolString(content, redactions);
  }
  return content.map((block) =>
    block.type === "text"
      ? {
          ...block,
          text: scrubModToolString(block.text as string, redactions),
        }
      : block,
  );
}

export function scrubModToolLines(
  lines: string[] | undefined,
  redactions: InvocationSecretRedactions,
): string[] | undefined {
  return lines?.map((line) => scrubModToolString(line, redactions));
}
