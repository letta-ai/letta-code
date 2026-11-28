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
import type { ModContext, ModPanel } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import {
  getWorkflowExecutionsVersion,
  listWorkflowExecutions,
  subscribeToWorkflowExecutions,
} from "@/tools/workflow/execution-registry";

const emptyAgents: ReturnType<typeof getSubagentLifecycleSnapshot> = [];
const noUpdates = () => () => {};
const emptySnapshot = () => emptyAgents;
const zero = () => 0;
export function useProductStatusPanels(params: {
  modContext: ModContext;
  modAdapter: Partial<Pick<LocalModAdapter, "registry">>;
  remote?: boolean;
  shouldAnimate: boolean;
}): {
  panelsWithDefaultProductStatus: Record<string, ModPanel>;
  panelModContext: ModContext;
  subagentLifecycleSnapshot: ReturnType<typeof getSubagentLifecycleSnapshot>;
  subagentLifecycleTick: number;
} {
  const { modContext, modAdapter, shouldAnimate, remote } = params;

  const subagentLifecycleSnapshot = useSyncExternalStore(
    remote ? noUpdates : subscribeToSubagentLifecycle,
    remote ? emptySnapshot : getSubagentLifecycleSnapshot,
  );
  const workflowExecutionsVersion = useSyncExternalStore(
    remote ? noUpdates : subscribeToWorkflowExecutions,
    remote ? zero : getWorkflowExecutionsVersion,
  );
  const hasActiveSubagent = subagentLifecycleSnapshot.some(
    (agent) => agent.status === "pending" || agent.status === "running",
  );
  const [subagentLifecycleTick, setSubagentLifecycleTick] = useState(0);

  const workflowExecutions = useMemo(() => {
    void workflowExecutionsVersion;
    void subagentLifecycleTick;
    return remote ? [] : visibleWorkflowExecutions(listWorkflowExecutions());
  }, [remote, workflowExecutionsVersion, subagentLifecycleTick]);
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
        }),
        workflowExecutions,
      ),
    [
      modAdapter.registry?.ui.panels,
      productStatusSpinnerFrameIndex,
      productStatusSpinnerPulseOn,
      shouldAnimateProductStatus,
      activeBackgroundAgentUrl,
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
