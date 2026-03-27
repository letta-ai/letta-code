import type { ReflectionSettings } from "../cli/helpers/memoryReminder";
import type { SharedReminderContext } from "./engine";
import type { SessionContextReason, SharedReminderState } from "./state";

// hardcoded for now as we only need plan mode reminder for listener mode
const LISTEN_REFLECTION_SETTINGS: ReflectionSettings = {
  trigger: "off",
  stepCount: 25,
};

interface BuildListenReminderContextParams {
  agentId: string;
  conversationId?: string;
  state: SharedReminderState;
  resolvePlanModeReminder: () => string | Promise<string>;
  /** Explicit working directory for session context (overrides process.cwd()). */
  workingDirectory?: string;
  /** Reason for injecting session context (controls intro text). */
  sessionContextReason?: SessionContextReason;
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
      conversationId: params.conversationId,
    },
    state: params.state,
    sessionContextReminderEnabled: true,
    reflectionSettings: LISTEN_REFLECTION_SETTINGS,
    skillSources: [],
    resolvePlanModeReminder: params.resolvePlanModeReminder,
    workingDirectory: params.workingDirectory,
    sessionContextSource: "listen",
    sessionContextReason: params.sessionContextReason,
  };
}
