import type { ReflectionSettings } from "../cli/helpers/memoryReminder";
import type { SharedReminderContext } from "./engine";
import type { SharedReminderState } from "./state";

// hardcoded for now as we only need plan mode reminder for listener mode
const LISTEN_REFLECTION_SETTINGS: ReflectionSettings = {
  trigger: "off",
  stepCount: 25,
};

interface BuildListenReminderContextParams {
  agentId: string;
  state: SharedReminderState;
  resolvePlanModeReminder: () => string | Promise<string>;
}

export function buildListenReminderContext(
  params: BuildListenReminderContextParams,
): SharedReminderContext {
  return {
    mode: "listen",
    agent: {
      id: params.agentId,
      name: null,
      description: null,
      lastRunAt: null,
    },
    state: params.state,
    sessionContextReminderEnabled: false,
    reflectionSettings: LISTEN_REFLECTION_SETTINGS,
    skillSources: [],
    resolvePlanModeReminder: params.resolvePlanModeReminder,
  };
}
