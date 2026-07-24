export function createIsolatedCliTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  stripAmbientLettaTestEnv(env);

  Object.assign(env, {
    LETTA_DISABLE_SESSION_PERSIST: "1",
    LETTA_SKIP_KEYCHAIN_CHECK: "1",
    DISABLE_AUTOUPDATER: "1",
  });

  applyEnvOverrides(env, extraEnv);
  return env;
}

export function createAuthenticatedCliTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return createIsolatedCliTestEnv({
    LETTA_API_KEY: process.env.LETTA_API_KEY,
    LETTA_BASE_URL: process.env.LETTA_BASE_URL,
    LETTA_API_BASE: process.env.LETTA_API_BASE,
    ...extraEnv,
  });
}

export const AMBIENT_LETTA_TEST_ENV_KEYS = [
  "AGENT_ID",
  "CONVERSATION_ID",
  "LETTA_ACCESS_TOKEN",
  "LETTA_AGENT_ID",
  "LETTA_API_BASE",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "LETTA_CODE_AGENT_ROLE",
  "LETTA_CONVERSATION_ID",
  "LETTA_LOCAL_BACKEND_DIR",
  "LETTA_LOCAL_BACKEND_EXPERIMENTAL",
  "LETTA_LOCAL_BACKEND_EXECUTOR",
  "LETTA_MEMORY_DIR",
  "LETTA_PARENT_AGENT_ID",
  "LETTA_REFRESH_TOKEN",
  "MEMORY_DIR",
  "LETTA_CODE_DEV_PI_MODEL",
  "LETTA_CODE_DEV_PI_PROVIDER",
  "LETTA_CODE_DEV_AI_SDK_MODEL",
  "LETTA_CODE_DEV_AI_SDK_PROVIDER",
] as const;

export function stripAmbientLettaTestEnv(env: NodeJS.ProcessEnv): void {
  for (const key of AMBIENT_LETTA_TEST_ENV_KEYS) {
    delete env[key];
  }
}

function applyEnvOverrides(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

export function snapshotAmbientLettaTestEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    AMBIENT_LETTA_TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
}

export function restoreAmbientLettaTestEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of AMBIENT_LETTA_TEST_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function isolateAmbientLettaTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): () => void {
  const snapshot = snapshotAmbientLettaTestEnv();

  stripAmbientLettaTestEnv(process.env);
  applyEnvOverrides(process.env, extraEnv);

  return () => restoreAmbientLettaTestEnv(snapshot);
}
