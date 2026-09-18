import { afterEach, describe, expect, test } from "bun:test";
import {
  configureBackendMode,
  getBackend,
  isLocalBackendEnabled,
} from "@/backend";
import type { Settings } from "@/settings-manager";
import { completeLettaLogin } from "./LettaLoginView";

const TOKENS = {
  access_token: "cloud-access-token",
  refresh_token: "cloud-refresh-token",
  token_type: "bearer",
  expires_in: 60,
};

function createSettingsWriter() {
  const state = {
    updates: [] as Partial<Settings>[],
    flushCount: 0,
  };
  return {
    state,
    writer: {
      updateSettings(updates: Partial<Settings>): void {
        state.updates.push(updates);
      },
      async flush(): Promise<void> {
        state.flushCount += 1;
      },
    },
  };
}

afterEach(() => {
  configureBackendMode("api");
});

describe("completeLettaLogin", () => {
  test("preserves the active local backend for in-session login", async () => {
    configureBackendMode("local");
    const localBackend = getBackend();
    const { state, writer } = createSettingsWriter();

    await completeLettaLogin(TOKENS, {
      activateCloudBackend: false,
      settings: writer,
      now: () => 1_000,
    });

    expect(getBackend()).toBe(localBackend);
    expect(isLocalBackendEnabled()).toBe(true);
    expect(state.updates).toEqual([
      {
        env: { LETTA_API_KEY: "cloud-access-token" },
        refreshToken: "cloud-refresh-token",
        tokenExpiresAt: 61_000,
        preferredBackendMode: "api",
      },
    ]);
    expect(state.flushCount).toBe(1);
  });

  test("activates the cloud backend when setup requests it", async () => {
    configureBackendMode("local");
    const { writer } = createSettingsWriter();

    await completeLettaLogin(TOKENS, {
      activateCloudBackend: true,
      settings: writer,
    });

    expect(isLocalBackendEnabled()).toBe(false);
    expect(getBackend().capabilities.remoteMemfs).toBe(true);
  });
});
