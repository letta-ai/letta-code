// OpenHands conversation events → normalized-v1.
//
// MessageEvents become user/assistant prose, an
// ActionEvent's `thought` (batched tool-call turns produce no MessageEvent —
// the assistant text rides on the first ActionEvent) becomes a reasoning
// record, ActionEvents become tool_calls, and ObservationEvent /
// AgentErrorEvent / UserRejectObservation become tool results linked back via
// tool_call_id (or via the observation's action_id when the call id is
// absent).
//
// There is no default local store: discovery requires a locator naming either
// a single JSON events file (an array, or the `{items: [...]}` events-API
// envelope), a conversation directory (with an `events/` subdir or the
// `events/` dir itself, one `event-<seq>-<uuid>.json` per event), or a store
// directory containing several conversation directories.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  PseudoRow,
  SessionContext,
} from "@/agent/trajectories/normalize-core";
import {
  normalizeSessionRows,
  parseTimestamp,
} from "@/agent/trajectories/normalize-core";
import {
  buildDiscoveredSession,
  statOrNull,
} from "@/agent/trajectories/store-utils";
import type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
  TrajectorySource,
} from "@/agent/trajectories/types";

interface OpenHandsTextContent {
  type?: string;
  text?: string;
}

interface OpenHandsEvent {
  kind?: string;
  id?: string;
  timestamp?: string;
  source?: string;
  llm_message?: {
    role?: string;
    content?: OpenHandsTextContent[];
  };
  // ActionEvent fields
  thought?: OpenHandsTextContent[];
  action?: Record<string, unknown> | null;
  tool_name?: string;
  tool_call_id?: string;
  tool_call?: { arguments?: string } | null;
  // ObservationEvent / result fields
  action_id?: string;
  observation?: {
    content?: OpenHandsTextContent[];
    is_error?: boolean;
  } | null;
  error?: string;
  rejection_reason?: string;
}

function joinTextContent(content: OpenHandsTextContent[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

/**
 * OpenHands timestamps are naive local datetimes (no timezone suffix) in most
 * deployments. Treat suffix-less timestamps as UTC so ordering is stable.
 */
function eventTimestamp(event: OpenHandsEvent): Date | null {
  return parseTimestamp(event.timestamp);
}

function extractToolResultText(event: OpenHandsEvent): string | null {
  switch (event.kind) {
    case "ObservationEvent":
      return joinTextContent(event.observation?.content);
    case "AgentErrorEvent":
      return event.error ?? "";
    case "UserRejectObservation":
      return event.rejection_reason ?? "";
    default:
      return null;
  }
}

function actionArgsText(event: OpenHandsEvent): string | undefined {
  const raw = event.tool_call?.arguments;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (event.action && typeof event.action === "object") {
    const { kind: _kind, ...rest } = event.action;
    return JSON.stringify(rest);
  }
  return undefined;
}

/**
 * Convert OpenHands conversation events into pseudo-rows. Non-conversational
 * events (system prompts, state updates, condensation, streaming deltas) are
 * skipped.
 */
export function openHandsEventsToRows(events: OpenHandsEvent[]): PseudoRow[] {
  const rows: PseudoRow[] = [];
  // Observation events may reference the action by action_id instead of
  // carrying a tool_call_id; remember each action's call id.
  const callIdByActionId = new Map<string, string>();

  for (const event of events) {
    if (!event.id) continue;
    const ts = eventTimestamp(event);

    if (event.kind === "MessageEvent") {
      if (event.source !== "user" && event.source !== "agent") continue;
      const text = joinTextContent(event.llm_message?.content);
      if (!text) continue;
      rows.push(
        event.source === "user"
          ? {
              role: "user",
              turnType: "user_prompt",
              content: text,
              timestamp: ts,
              sourceId: event.id,
            }
          : {
              role: "assistant",
              turnType: "assistant_response",
              content: text,
              timestamp: ts,
              sourceId: event.id,
            },
      );
      continue;
    }

    if (event.kind === "ActionEvent") {
      // Batched tool-call turns produce no MessageEvent; the assistant text
      // rides on the first ActionEvent's `thought`.
      const thought = joinTextContent(event.thought);
      if (thought) {
        rows.push({
          role: "assistant",
          turnType: "assistant_thinking",
          content: thought,
          timestamp: ts,
          sourceId: `${event.id}:thought`,
        });
      }
      const callId = event.tool_call_id || `oh_${event.id}`;
      callIdByActionId.set(event.id, callId);
      rows.push({
        role: "tool_use",
        turnType: "tool_use",
        timestamp: ts,
        toolName: event.tool_name,
        toolCallId: callId,
        toolInputJson: actionArgsText(event) ?? "{}",
        sourceId: event.id,
      });
      continue;
    }

    const resultText = extractToolResultText(event);
    if (resultText !== null) {
      const callId =
        event.tool_call_id ||
        (event.action_id ? callIdByActionId.get(event.action_id) : undefined);
      rows.push({
        role: "tool_result",
        turnType: "tool_result",
        content: resultText,
        timestamp: ts,
        toolCallId: callId,
        sourceId: event.id,
      });
    }
  }
  return rows;
}

function parseEventsFile(raw: string, path: string): OpenHandsEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed)) return parsed as OpenHandsEvent[];
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { items?: unknown[] }).items)
  ) {
    return (parsed as { items: OpenHandsEvent[] }).items;
  }
  throw new Error(
    `Could not parse ${path}: expected a JSON array of events or {"items": [...]}`,
  );
}

/** The `<seq>` in `event-<seq>-<uuid>.json` — the durable ordering key. */
function eventSequence(fileName: string): number {
  const digits = fileName.match(/^event-(\d+)-/)?.[1];
  return digits ? Number.parseInt(digits, 10) : 0;
}

const EVENT_FILE_RE = /^event-\d+-.*\.json$/;

/** Resolve a conversation dir (or the events/ dir itself) to its events dir,
 * or null when it holds no event files. */
function resolveEventsDir(dir: string): string | null {
  const nested = join(dir, "events");
  for (const candidate of [nested, dir]) {
    const info = statOrNull(candidate);
    if (!info?.isDirectory()) continue;
    try {
      if (readdirSync(candidate).some((name) => EVENT_FILE_RE.test(name))) {
        return candidate;
      }
    } catch {
      // unreadable — keep looking
    }
  }
  return null;
}

interface LoadedEvents {
  events: OpenHandsEvent[];
  mtimeMs: number;
}

/** Read one conversation's events from a directory of event-*.json files. */
function readEventDir(eventsDir: string): LoadedEvents {
  const fileNames = readdirSync(eventsDir)
    .filter((name) => EVENT_FILE_RE.test(name))
    .sort((a, b) => eventSequence(a) - eventSequence(b));
  const events: OpenHandsEvent[] = [];
  let mtimeMs = statOrNull(eventsDir)?.mtimeMs ?? 0;
  for (const name of fileNames) {
    const path = join(eventsDir, name);
    const info = statOrNull(path);
    if (info && info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs;
    let event: unknown;
    try {
      event = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (event && typeof event === "object" && !Array.isArray(event)) {
      events.push(event as OpenHandsEvent);
    }
  }
  return { events, mtimeMs };
}

/** Load a session locator (events file or conversation/events dir). */
function loadEvents(path: string): LoadedEvents | null {
  const info = statOrNull(path);
  if (!info) return null;
  if (info.isDirectory()) {
    const eventsDir = resolveEventsDir(path);
    if (!eventsDir) return null;
    return readEventDir(eventsDir);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return { events: parseEventsFile(raw, path), mtimeMs: info.mtimeMs };
}

function sessionIdForPath(path: string, isDir: boolean): string {
  const name = basename(path);
  if (!isDir) return name.replace(/\.json$/, "");
  // For `<conversation-id>/events` locators the conversation dir is the id.
  return name === "events" ? basename(dirname(path)) : name;
}

interface ParsedSession {
  session: DiscoveredSession;
  records: NormalizedRecord[];
}

function parseSessionPath(path: string): ParsedSession | null {
  const info = statOrNull(path);
  if (!info) return null;
  let loaded: LoadedEvents | null;
  try {
    loaded = loadEvents(path);
  } catch {
    return null;
  }
  if (!loaded || loaded.events.length === 0) return null;
  const rows = openHandsEventsToRows(loaded.events);
  const context: SessionContext = {
    source: "openhands",
    createdAt: new Date(loaded.mtimeMs),
  };
  const result = normalizeSessionRows(rows, context);
  const session = buildDiscoveredSession(
    "openhands",
    sessionIdForPath(path, info.isDirectory()),
    path,
    loaded.mtimeMs,
    result,
  );
  if (!session || !result.records) return null;
  return { session, records: result.records };
}

/**
 * Trajectory source for OpenHands conversation exports. There is no default
 * local store, so `discover` requires a locator.
 */
export function createOpenHandsSource(): TrajectorySource {
  return {
    type: "openhands",

    async discover(locator?: string): Promise<DiscoveredSession[]> {
      if (!locator) {
        throw new Error(
          "The openhands source has no default local store; pass a locator " +
            "(an events JSON file, a conversation directory, or a directory " +
            "of conversations), e.g. --from openhands:<path>",
        );
      }
      const info = statOrNull(locator);
      if (!info) {
        throw new Error(`No such OpenHands session path: ${locator}`);
      }

      // A single events file or a single conversation directory.
      if (info.isFile() || resolveEventsDir(locator)) {
        const parsed = parseSessionPath(locator);
        return parsed ? [parsed.session] : [];
      }

      // A store directory: each child dir with events is a conversation.
      const sessions: DiscoveredSession[] = [];
      let children: string[] = [];
      try {
        children = readdirSync(locator).sort();
      } catch {
        children = [];
      }
      for (const child of children) {
        const childPath = join(locator, child);
        if (!statOrNull(childPath)?.isDirectory()) continue;
        if (!resolveEventsDir(childPath)) continue;
        const parsed = parseSessionPath(childPath);
        if (parsed) sessions.push(parsed.session);
      }
      if (sessions.length === 0) {
        throw new Error(
          `No OpenHands event files (event-*.json) found under ${locator}`,
        );
      }
      sessions.sort((a, b) => a.mtimeMs - b.mtimeMs);
      return sessions;
    },

    async normalize(session: DiscoveredSession): Promise<NormalizedSession> {
      const parsed = parseSessionPath(session.path);
      if (!parsed) {
        throw new Error(
          `Could not normalize OpenHands session ${session.sessionId} at ${session.path}`,
        );
      }
      return { session, records: parsed.records };
    },
  };
}
