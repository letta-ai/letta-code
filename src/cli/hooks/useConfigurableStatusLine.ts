// src/cli/hooks/useConfigurableStatusLine.ts
// React hook that polls a user-defined status-line command and returns the text.

import { useCallback, useEffect, useRef, useState } from "react";
import { areHooksDisabled } from "../../hooks/loader";
import { resolveStatusLineConfig } from "../helpers/statusLineConfig";
import {
  type StatusLinePayload,
  executeStatusLineCommand,
} from "../helpers/statusLineRuntime";

/** Inputs supplied by App.tsx to build the payload. */
export interface StatusLineInputs {
  agentId?: string;
  agentName?: string | null;
  conversationId?: string;
  sessionId?: string;
  model?: string | null;
  provider?: string | null;
  contextWindow?: number;
  streaming: boolean;
  permissionMode?: string;
  trajectoryTokens?: number;
  sessionTokens?: number;
  sessionDurationMs?: number;
  workingDirectory?: string;
  networkPhase?: string | null;
  terminalWidth?: number;
}

export interface StatusLineState {
  text: string;
  active: boolean;
  executing: boolean;
  lastError: string | null;
}

/** After this many consecutive failures, pause before retrying. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Pause duration after consecutive failures (30 seconds). */
const FAILURE_PAUSE_MS = 30_000;

export function useConfigurableStatusLine(
  inputs: StatusLineInputs,
): StatusLineState {
  const [text, setText] = useState("");
  const [active, setActive] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const failureCountRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const prevStreamingRef = useRef(inputs.streaming);

  const buildPayload = useCallback(
    (): StatusLinePayload => ({
      agent_id: inputs.agentId,
      agent_name: inputs.agentName,
      conversation_id: inputs.conversationId,
      session_id: inputs.sessionId,
      model: inputs.model,
      provider: inputs.provider,
      context_window: inputs.contextWindow,
      streaming: inputs.streaming,
      permission_mode: inputs.permissionMode,
      trajectory_tokens: inputs.trajectoryTokens,
      session_tokens: inputs.sessionTokens,
      session_duration_ms: inputs.sessionDurationMs,
      working_directory: inputs.workingDirectory,
      network_phase: inputs.networkPhase,
      terminal_width: inputs.terminalWidth,
    }),
    [
      inputs.agentId,
      inputs.agentName,
      inputs.conversationId,
      inputs.sessionId,
      inputs.model,
      inputs.provider,
      inputs.contextWindow,
      inputs.streaming,
      inputs.permissionMode,
      inputs.trajectoryTokens,
      inputs.sessionTokens,
      inputs.sessionDurationMs,
      inputs.workingDirectory,
      inputs.networkPhase,
      inputs.terminalWidth,
    ],
  );

  const runOnce = useCallback(async () => {
    if (inFlightRef.current) return;

    // Re-resolve config each tick (cheap in-memory read)
    const config = resolveStatusLineConfig(inputs.workingDirectory);
    if (!config || areHooksDisabled(inputs.workingDirectory)) {
      setActive(false);
      setText("");
      return;
    }

    setActive(true);
    inFlightRef.current = true;
    setExecuting(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const result = await executeStatusLineCommand(
        config.command,
        buildPayload(),
        {
          timeout: config.timeout,
          signal: ac.signal,
          workingDirectory: inputs.workingDirectory,
        },
      );

      if (ac.signal.aborted) return;

      if (result.ok) {
        setText(result.text);
        setLastError(null);
        failureCountRef.current = 0;
      } else {
        failureCountRef.current += 1;
        setLastError(result.error ?? "Unknown error");
      }
    } catch {
      failureCountRef.current += 1;
      setLastError("Execution exception");
    } finally {
      inFlightRef.current = false;
      setExecuting(false);
      abortRef.current = null;
    }
  }, [buildPayload, inputs.workingDirectory]);

  // Main polling interval
  useEffect(() => {
    const config = resolveStatusLineConfig(inputs.workingDirectory);
    if (!config || areHooksDisabled(inputs.workingDirectory)) {
      setActive(false);
      setText("");
      return;
    }

    // Run immediately
    runOnce();

    const id = setInterval(() => {
      // Pause after consecutive failures
      if (failureCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
        failureCountRef.current = 0; // reset so next interval fires
        return;
      }
      runOnce();
    }, failureCountRef.current >= MAX_CONSECUTIVE_FAILURES
      ? FAILURE_PAUSE_MS
      : config.interval);

    return () => {
      clearInterval(id);
      // Cancel in-flight command
      abortRef.current?.abort();
    };
  }, [runOnce, inputs.workingDirectory]);

  // Fire immediately on streaming state change for quick feedback
  useEffect(() => {
    if (prevStreamingRef.current !== inputs.streaming) {
      prevStreamingRef.current = inputs.streaming;
      runOnce();
    }
  }, [inputs.streaming, runOnce]);

  return { text, active, executing, lastError };
}
