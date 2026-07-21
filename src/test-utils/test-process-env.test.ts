import { afterEach, describe, expect, test } from "bun:test";
import {
  createAuthenticatedCliTestEnv,
  createIsolatedCliTestEnv,
  isolateAmbientLettaTestEnv,
} from "@/test-utils/test-process-env";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

describe("test process env helpers", () => {
  test("createIsolatedCliTestEnv strips ambient agent, API, local backend, and memory env", () => {
    restores.push(
      isolateAmbientLettaTestEnv({
        AGENT_ID: "agent-ambient",
        CONVERSATION_ID: "conv-ambient",
        LETTA_AGENT_ID: "agent-letta",
        LETTA_API_KEY: "sk-ambient",
        LETTA_CODE_AGENT_ROLE: "subagent",
        LETTA_LOCAL_BACKEND_DIR: "/tmp/local-backend",
        LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
        LETTA_CODE_DEV_PI_PROVIDER: "anthropic",
        LETTA_MEMORY_DIR: "/tmp/letta-memory",
        MEMORY_DIR: "/tmp/memory",
      }),
    );

    const env = createIsolatedCliTestEnv();

    expect(env.AGENT_ID).toBeUndefined();
    expect(env.CONVERSATION_ID).toBeUndefined();
    expect(env.LETTA_AGENT_ID).toBeUndefined();
    expect(env.LETTA_API_KEY).toBeUndefined();
    expect(env.LETTA_CODE_AGENT_ROLE).toBeUndefined();
    expect(env.LETTA_LOCAL_BACKEND_DIR).toBeUndefined();
    expect(env.LETTA_LOCAL_BACKEND_EXPERIMENTAL).toBeUndefined();
    expect(env.LETTA_CODE_DEV_PI_PROVIDER).toBeUndefined();
    expect(env.LETTA_MEMORY_DIR).toBeUndefined();
    expect(env.MEMORY_DIR).toBeUndefined();
    expect(env.LETTA_DISABLE_SESSION_PERSIST).toBe("1");
    expect(env.LETTA_SKIP_KEYCHAIN_CHECK).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
  });

  test("extra env opts back into values deliberately", () => {
    restores.push(
      isolateAmbientLettaTestEnv({
        LETTA_API_KEY: "sk-ambient",
        MEMORY_DIR: "/tmp/ambient-memory",
      }),
    );

    const env = createIsolatedCliTestEnv({
      LETTA_API_KEY: "sk-explicit",
      MEMORY_DIR: "/tmp/explicit-memory",
    });

    expect(env.LETTA_API_KEY).toBe("sk-explicit");
    expect(env.MEMORY_DIR).toBe("/tmp/explicit-memory");
  });

  test("createAuthenticatedCliTestEnv preserves only explicit API connection env", () => {
    restores.push(
      isolateAmbientLettaTestEnv({
        AGENT_ID: "agent-ambient",
        LETTA_API_KEY: "sk-ambient",
        LETTA_BASE_URL: "https://api.example.test",
        MEMORY_DIR: "/tmp/ambient-memory",
      }),
    );

    const env = createAuthenticatedCliTestEnv();

    expect(env.LETTA_API_KEY).toBe("sk-ambient");
    expect(env.LETTA_BASE_URL).toBe("https://api.example.test");
    expect(env.AGENT_ID).toBeUndefined();
    expect(env.MEMORY_DIR).toBeUndefined();
  });
});
