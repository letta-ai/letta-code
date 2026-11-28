import type { TranscriptRow } from "@letta-ai/letta-agent-sdk";
import { useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { getModelDisplayName } from "@/agent/model";
import type { StaticItem } from "@/cli/app/types";
import { useTerminalInput } from "@/cli/app/use-terminal-input";
import { sessionDiff } from "@/cli/components/SessionDiff";
import type { Line } from "@/cli/helpers/accumulator";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
} from "@/cli/helpers/tool-name-mapping";
import type { DiffPreview } from "@/types/protocol_v2";
import { CLEAR_SCREEN_AND_HOME, INTERRUPT_MESSAGE } from "./constants";
import type { TerminalSession } from "./terminal-session";

function transcriptLine(row: TranscriptRow, live: boolean): Line {
  const phase = live ? "streaming" : "finished";
  if (row.kind === "tool_call")
    return {
      kind: "tool_call",
      id: row.key,
      toolCallId: row.toolCallId,
      name: row.toolName,
      argsText: row.rawArguments ?? JSON.stringify(row.toolInput),
      phase: row.status === "complete" ? "finished" : row.status,
      resultOk: row.result && !row.result.isError,
      resultText: row.result?.content,
    };
  if (row.kind === "user") return { kind: "user", id: row.key, text: row.text };
  return { kind: row.kind, id: row.key, text: row.text, phase };
}
export function useSessionView({
  store,
  initialName,
  embeddedCloud,
  connectionMode = "embedded",
}: {
  store: TerminalSession;
  initialName?: string;
  embeddedCloud?: boolean;
  connectionMode?: "embedded" | "remote" | "cloud";
}) {
  const { stdout } = useStdout();
  const subscribe = useCallback(
    (notify: () => void) => {
      let epoch = store.snapshot().epoch;
      return store.subscribe(() => {
        const next = store.snapshot().epoch;
        if (epoch !== next) stdout.write(CLEAR_SCREEN_AND_HOME);
        epoch = next;
        notify();
      });
    },
    [store, stdout],
  );
  const state = useSyncExternalStore(subscribe, store.snapshot);

  const approval = state.approvals[0];
  const fileApproval =
    approval &&
    (isFileEditTool(approval.name) ||
      isFileWriteTool(approval.name) ||
      isPatchTool(approval.name));
  const suggestion = approval?.context?.permissionSuggestions?.[0];
  const { exit } = useApp();
  useInput((input, key) => {
    if (state.status !== "online" && key.ctrl && input === "c") {
      exit();
      return;
    }
    if (
      approval ||
      state.help ||
      state.login ||
      state.question ||
      state.skills ||
      state.memory ||
      state.picker
    )
      return;
    if (state.status === "offline" && input === "r") void store.connect();
  });
  const active =
    state.status === "online" &&
    !approval &&
    !state.question &&
    !state.help &&
    !state.login &&
    !state.skills &&
    !state.memory &&
    !state.picker;
  const input = useTerminalInput({ store, active, initialName });
  const columns = input.terminalWidth;
  const loadingState: "checking" | "ready" =
    state.status === "connecting" ? "checking" : "ready";
  const sessionWelcome = {
    connection:
      connectionMode === "remote"
        ? "Remote"
        : embeddedCloud || connectionMode === "cloud"
          ? "Cloud"
          : "Local",
    model: state.model
      ? (getModelDisplayName(state.model) ?? state.model)
      : undefined,
    location: state.device?.workingDirectory ?? undefined,
  };
  const staticItems: StaticItem[] =
    loadingState === "ready"
      ? [
          {
            kind: "welcome",
            id: "welcome",
            snapshot: {
              session: sessionWelcome,
              continueSession: true,
              terminalWidth: columns,
            },
          },
          {
            kind: "status",
            id: "session-start",
            lines: [
              `Resuming ${state.resumedHistory ? "" : "new "}conversation with **${state.agentName ?? initialName ?? "your agent"}**`,
              ...(state.resumedHistory
                ? []
                : [
                    "→ **/rename**    name your agent",
                    "→ **/init**      initialize your agent's memory",
                  ]),
              "→ **/agents**    list all agents",
              "→ **/resume**    browse all conversations",
              "→ **/new**       start a new conversation",
              ...(state.resumedHistory
                ? ["→ **/init**      initialize your agent's memory"]
                : []),
            ],
          },
          ...state.rows
            .slice(0, state.committed)
            .map((row) => transcriptLine(row, false)),
        ]
      : [];
  const queuedIds = new Set(state.queue.map((item) => item.clientMessageId));
  const liveItems = state.rows
    .slice(state.committed)
    .filter(
      (row) => row.kind !== "user" || !row.otid || !queuedIds.has(row.otid),
    )
    .map((row) => transcriptLine(row, true));
  if (state.commandOutput)
    liveItems.push({
      kind: "status",
      id: "command",
      lines: state.commandOutput.split("\n"),
    });
  if (state.activity === "Interrupted")
    liveItems.push({ kind: "error", id: "interrupt", text: INTERRUPT_MESSAGE });
  if (state.error)
    liveItems.push({ kind: "error", id: "error", text: state.error });
  if (state.status === "offline")
    liveItems.push({
      kind: "status",
      id: "offline",
      lines: ["Disconnected · r to reconnect"],
    });
  if (Array.isArray(state.device?.raw?.background_processes))
    for (const item of state.device.raw.background_processes)
      liveItems.push({
        kind: "status",
        id: item.process_id,
        lines: [
          `${item.kind} · ${item.description ?? item.command} · ${item.status}`,
        ],
      });
  const precomputedDiffs = useMemo(
    () => new Map<string, AdvancedDiffSuccess>(),
    [],
  );
  useEffect(() => {
    const id = approval?.context?.toolCallId;
    if (!id) return;
    const previews = approval.context?.diffs as DiffPreview[] | undefined;
    for (const preview of previews ?? []) {
      if (preview.mode !== "advanced") continue;
      const diff = sessionDiff(preview);
      precomputedDiffs.set(`${id}:${preview.fileName}`, diff);
      if (previews?.length === 1) precomputedDiffs.set(id, diff);
    }
  }, [approval, precomputedDiffs]);
  const currentApproval = approval && {
    toolCallId: approval.context?.toolCallId ?? "",
    toolName: approval.name,
    toolArgs: JSON.stringify(approval.input),
  };
  const pendingIds = new Set(
    state.approvals.slice(1).map((a) => a.context?.toolCallId),
  );
  const streaming = input.streaming;
  const statusLinePrompt = "";
  return {
    state,
    store,
    approval,
    fileApproval,
    suggestion,
    columns,
    loadingState,
    sessionWelcome,
    staticItems,
    liveItems,
    precomputedDiffs,
    currentApproval,
    pendingIds,
    streaming,
    statusLinePrompt,
    input,
    active,
  };
}
