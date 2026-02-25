// React hook that executes a user-defined status-line command.
//
// Behavior:
// - Event-driven refreshes with debounce (default 300ms)
// - Cancel in-flight execution on retrigger (latest data wins)
// - Optional polling when refreshIntervalMs is configured

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type NormalizedStatusLineConfig,
  resolvePromptChar,
  resolveStatusLineConfig,
} from "../helpers/statusLineConfig";
import {
  buildStatusLinePayload,
  type StatusLinePayloadBuildInput,
} from "../helpers/statusLinePayload";
import { executeStatusLineCommand } from "../helpers/statusLineRuntime";

/** Inputs supplied by App.tsx to build the payload and triggers. */
export interface StatusLineInputs {
  modelId?: string | null;
  modelDisplayName?: string | null;
  reasoningEffort?: string | null;
  systemPromptId?: string | null;
  toolset?: string | null;
  currentDirectory: string;
  projectDirectory: string;
  sessionId?: string;
  agentName?: string | null;
  totalDurationMs?: number;
  totalApiDurationMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindowSize?: number;
  usedContextTokens?: number;
  permissionMode?: string;
  networkPhase?: "upload" | "download" | "error" | null;
  terminalWidth?: number;
  triggerVersion: number;
}

/** ASCII Record Separator used to split left/right column output. */
const RS = "\x1e";

export interface StatusLineState {
  text: string;
  rightText: string;
  active: boolean;
  executing: boolean;
  lastError: string | null;
  padding: number;
  prompt: string;
}

function toPayloadInput(inputs: StatusLineInputs): StatusLinePayloadBuildInput {
  return {
    modelId: inputs.modelId,
    modelDisplayName: inputs.modelDisplayName,
    reasoningEffort: inputs.reasoningEffort,
    systemPromptId: inputs.systemPromptId,
    toolset: inputs.toolset,
    currentDirectory: inputs.currentDirectory,
    projectDirectory: inputs.projectDirectory,
    sessionId: inputs.sessionId,
    agentName: inputs.agentName,
    totalDurationMs: inputs.totalDurationMs,
    totalApiDurationMs: inputs.totalApiDurationMs,
    totalInputTokens: inputs.totalInputTokens,
    totalOutputTokens: inputs.totalOutputTokens,
    contextWindowSize: inputs.contextWindowSize,
    usedContextTokens: inputs.usedContextTokens,
    permissionMode: inputs.permissionMode,
    networkPhase: inputs.networkPhase,
    terminalWidth: inputs.terminalWidth,
  };
}

export function useConfigurableStatusLine(
  inputs: StatusLineInputs,
): StatusLineState {
  const [text, setText] = useState("");
  const [rightText, setRightText] = useState("");
  const [active, setActive] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [padding, setPadding] = useState(0);
  const [prompt, setPrompt] = useState(">");

  const inputsRef = useRef(inputs);
  const configRef = useRef<NormalizedStatusLineConfig | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  useEffect(() => {
    inputsRef.current = inputs;
  }, [inputs]);

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearRefreshInterval = useCallback(() => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
  }, []);

  const resolveActiveConfig = useCallback(() => {
    const workingDirectory = inputsRef.current.currentDirectory;
    const config = resolveStatusLineConfig(workingDirectory);

    // Always resolve prompt, independent of whether a command is configured.
    setPrompt(resolvePromptChar(workingDirectory));

    if (!config) {
      configRef.current = null;
      // Abort any in-flight execution so stale results don't surface.
      abortRef.current?.abort();
      abortRef.current = null;
      setActive(false);
      setText("");
      setRightText("");
      setPadding(0);
      return null;
    }

    configRef.current = config;
    setActive(true);
    setPadding(config.padding);
    return config;
  }, []);

  const executeNow = useCallback(async () => {
    const config = configRef.current ?? resolveActiveConfig();
    if (!config) return;

    // Cancel in-flight execution so only the latest result is used.
    abortRef.current?.abort();

    const ac = new AbortController();
    abortRef.current = ac;
    setExecuting(true);

    try {
      const currentInputs = inputsRef.current;
      const result = await executeStatusLineCommand(
        config.command,
        buildStatusLinePayload(toPayloadInput(currentInputs)),
        {
          timeout: config.timeout,
          signal: ac.signal,
          workingDirectory: currentInputs.currentDirectory,
        },
      );

      if (ac.signal.aborted) return;

      if (result.ok) {
        const rsIdx = result.text.indexOf(RS);
        if (rsIdx >= 0) {
          setText(result.text.slice(0, rsIdx));
          setRightText(result.text.slice(rsIdx + 1));
        } else {
          setText(result.text);
          setRightText("");
        }
        setLastError(null);
      } else {
        setLastError(result.error ?? "Unknown error");
      }
    } catch {
      if (!ac.signal.aborted) {
        setLastError("Execution exception");
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
      }
      setExecuting(false);
    }
  }, [resolveActiveConfig]);

  const scheduleDebouncedRun = useCallback(() => {
    const config = resolveActiveConfig();
    if (!config) return;

    clearDebounceTimer();
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void executeNow();
    }, config.debounceMs);
  }, [clearDebounceTimer, executeNow, resolveActiveConfig]);

  const triggerVersion = inputs.triggerVersion;

  // Event-driven trigger updates.
  useEffect(() => {
    // tie this effect explicitly to triggerVersion for lint + semantics
    void triggerVersion;
    scheduleDebouncedRun();
  }, [scheduleDebouncedRun, triggerVersion]);

  const currentDirectory = inputs.currentDirectory;

  // Re-resolve config and optional polling whenever working directory changes.
  useEffect(() => {
    // tie this effect explicitly to currentDirectory for lint + semantics
    void currentDirectory;
    const config = resolveActiveConfig();

    clearRefreshInterval();
    if (config?.refreshIntervalMs) {
      refreshIntervalRef.current = setInterval(() => {
        scheduleDebouncedRun();
      }, config.refreshIntervalMs);
    }

    return () => {
      clearRefreshInterval();
      clearDebounceTimer();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [
    clearDebounceTimer,
    clearRefreshInterval,
    resolveActiveConfig,
    scheduleDebouncedRun,
    currentDirectory,
  ]);

  return { text, rightText, active, executing, lastError, padding, prompt };
}
