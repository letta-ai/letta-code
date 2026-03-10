import type { ReflectionSettings } from "../cli/helpers/memoryReminder";
import type { SharedReminderContext } from "./engine";
import type { SharedReminderState } from "./state";

// hardcoded for now as we only need plan mode reminder for listener mode
const LISTENER_REFLECTION_SETTINGS: ReflectionSettings = {
  trigger: "off",
  behavior: "reminder",
  stepCount: 25,
};

interface BuildListenerReminderContextParams {
  agentId: string;
  state: SharedReminderState;
  resolvePlanModeReminder: () => string | Promise<string>;
}

export function buildListenerReminderContext(
  params: BuildListenerReminderContextParams,
): SharedReminderContext {
  return {
    mode: "listener",
    agent: {
      id: params.agentId,
      name: null,
      description: null,
      lastRunAt: null,
    },
    state: params.state,
    sessionContextReminderEnabled: false,
    reflectionSettings: LISTENER_REFLECTION_SETTINGS,
    skillSources: [],
    resolvePlanModeReminder: params.resolvePlanModeReminder,
  };
}
