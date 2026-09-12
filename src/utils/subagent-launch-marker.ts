/** Consumed by the child entrypoint; shell commands from that child must not inherit it. */
export const SUBAGENT_LAUNCH_ENV = "LETTA_SUBAGENT_LAUNCH";
export const SUBAGENT_LAUNCH_PROFILE_ENV = "LETTA_SUBAGENT_LAUNCH_PROFILE";
export const LISTENER_CONNECTION_ENV = "LETTA_RUNTIME_LISTENER_CONNECTION_ID";

export function consumeSubagentLaunch(env: NodeJS.ProcessEnv): boolean {
  const isLaunch = env[SUBAGENT_LAUNCH_ENV] === "1";
  delete env[SUBAGENT_LAUNCH_ENV];
  return isLaunch;
}
