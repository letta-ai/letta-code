export function createIsolatedCliTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LETTA_DISABLE_SESSION_PERSIST: "1",
    DISABLE_AUTOUPDATER: "1",
    ...extraEnv,
  };

  delete env.LETTA_CODE_AGENT_ROLE;
  return env;
}
