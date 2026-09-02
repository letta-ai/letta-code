/**
 * Host-owned panels around the input: the product-status row above it (the
 * "dreaming" spinner for silent background agents, or the idle "waiting for
 * N workflows" line) and the Workflow execution rows below it.
 *
 * Everything here reads external stores (subagent lifecycle, workflow
 * execution registry) and a 1 s ticker while something is active, so the
 * rows stay live without any state living in App.tsx.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  getSubagentLifecycleSnapshot,
  subscribeToSubagentLifecycle,
} from "@/agent/subagent-state";
import { BRAILLE_SPINNER_FRAMES } from "@/cli/components/BlinkingSpinner";
import {
  PRODUCT_STATUS_SPINNER_INTERVAL_MS,
  PRODUCT_STATUS_SPINNER_PULSE_INTERVAL_MS,
  withDefaultProductStatusPanel,
} from "@/cli/display/product-status/default";
import {
  visibleWorkflowExecutions,
  withWorkflowStatusPanel,
} from "@/cli/display/product-status/workflows";
import type { ExecutionPhase } from "@/cli/helpers/phase-visuals";
import type { ModContext, ModPanel } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import {
  getWorkflowExecutionsVersion,
  listWorkflowExecutions,
  subscribeToWorkflowExecutions,
} from "@/tools/workflow/execution-registry";

export function useProductStatusPanels(params: {
  modContext: ModContext;
  modAdapter: LocalModAdapter;
  shouldAnimate: boolean;
  executionPhase: ExecutionPhase;
}): {
  panelsWithDefaultProductStatus: Record<string, ModPanel>;
  panelModContext: ModContext;
  subagentLifecycleSnapshot: ReturnType<typeof getSubagentLifecycleSnapshot>;
  subagentLifecycleTick: number;
} {
  const { modContext, modAdapter, shouldAnimate, executionPhase } = params;

  const subagentLifecycleSnapshot = useSyncExternalStore(
    subscribeToSubagentLifecycle,
    getSubagentLifecycleSnapshot,
  );
  const workflowExecutionsVersion = useSyncExternalStore(
    subscribeToWorkflowExecutions,
    getWorkflowExecutionsVersion,
  );
  const hasActiveSubagent = subagentLifecycleSnapshot.some(
    (agent) => agent.status === "pending" || agent.status === "running",
  );
  const [subagentLifecycleTick, setSubagentLifecycleTick] = useState(0);

  // Executions worth a row: running, or finished within the linger window.
  // Re-evaluated on registry changes and on the ticker (so elapsed time
  // advances and finished rows eventually drop off).
  const workflowExecutions = useMemo(() => {
    void workflowExecutionsVersion;
    void subagentLifecycleTick;
    return visibleWorkflowExecutions(listWorkflowExecutions());
  }, [workflowExecutionsVersion, subagentLifecycleTick]);
  const runningWorkflowCount = workflowExecutions.filter(
    (execution) => execution.status === "running",
  ).length;
  const hasVisibleWorkflow = workflowExecutions.length > 0;

  useEffect(() => {
    if (!hasActiveSubagent && !hasVisibleWorkflow) return;
    const timer = setInterval(
      () => setSubagentLifecycleTick((value) => value + 1),
      1000,
    );
    return () => clearInterval(timer);
  }, [hasActiveSubagent, hasVisibleWorkflow]);

  const liveBackgroundAgents = useMemo<ModContext["backgroundAgents"]>(() => {
    void subagentLifecycleTick;
    const now = Date.now();
    return subagentLifecycleSnapshot
      .filter(
        (agent) =>
          !agent.visibleInTranscript &&
          (agent.status === "pending" || agent.status === "running"),
      )
      .map((agent) => ({
        type: agent.type,
        status: agent.status,
        durationMs: Math.max(0, now - agent.startedAtMs),
        agentId: agent.agentId ?? null,
      }));
  }, [subagentLifecycleSnapshot, subagentLifecycleTick]);

  const hasActiveProductStatus = liveBackgroundAgents.length > 0;
  const shouldAnimateProductStatus = hasActiveProductStatus && shouldAnimate;
  const [productStatusSpinnerFrameIndex, setProductStatusSpinnerFrameIndex] =
    useState(0);
  const [productStatusSpinnerPulseOn, setProductStatusSpinnerPulseOn] =
    useState(true);

  useEffect(() => {
    setProductStatusSpinnerFrameIndex(0);
    if (!shouldAnimateProductStatus) return;
    const timer = setInterval(() => {
      setProductStatusSpinnerFrameIndex(
        (value) => (value + 1) % BRAILLE_SPINNER_FRAMES.length,
      );
    }, PRODUCT_STATUS_SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldAnimateProductStatus]);

  useEffect(() => {
    setProductStatusSpinnerPulseOn(true);
    if (!shouldAnimateProductStatus) return;
    const timer = setInterval(() => {
      setProductStatusSpinnerPulseOn((value) => !value);
    }, PRODUCT_STATUS_SPINNER_PULSE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldAnimateProductStatus]);

  const panelModContext = useMemo<ModContext>(
    () => ({
      ...modContext,
      backgroundAgents: liveBackgroundAgents,
    }),
    [liveBackgroundAgents, modContext],
  );

  const activeBackgroundAgentUrl = useMemo(() => {
    const agent = subagentLifecycleSnapshot.find(
      (a) =>
        !a.visibleInTranscript &&
        (a.status === "pending" || a.status === "running") &&
        a.agentUrl,
    );
    return agent?.agentUrl ?? null;
  }, [subagentLifecycleSnapshot]);

  const panelsWithDefaultProductStatus = useMemo(
    () =>
      withWorkflowStatusPanel(
        withDefaultProductStatusPanel(modAdapter.registry?.ui.panels, {
          spinnerDimmed:
            shouldAnimateProductStatus && !productStatusSpinnerPulseOn,
          spinnerFrame:
            BRAILLE_SPINNER_FRAMES[productStatusSpinnerFrameIndex] ??
            BRAILLE_SPINNER_FRAMES[0],
          agentUrl: activeBackgroundAgentUrl,
          runningWorkflowCount,
          modelIdle: executionPhase === null,
        }),
        workflowExecutions,
      ),
    [
      modAdapter.registry?.ui.panels,
      productStatusSpinnerFrameIndex,
      productStatusSpinnerPulseOn,
      shouldAnimateProductStatus,
      activeBackgroundAgentUrl,
      runningWorkflowCount,
      executionPhase,
      workflowExecutions,
    ],
  );

  return {
    panelsWithDefaultProductStatus,
    panelModContext,
    subagentLifecycleSnapshot,
    subagentLifecycleTick,
  };
}
