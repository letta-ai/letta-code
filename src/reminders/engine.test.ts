import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { setCurrentAgentId } from "@/agent/context";
import { permissionMode } from "@/permissions/mode";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
  sharedReminderProviders,
} from "@/reminders/engine";
import {
  createSharedReminderState,
  markSecretsInfoReminderPending,
} from "@/reminders/state";
import {
  clearSecretsCache,
  initSecretsFromServer,
} from "@/utils/secrets-store";

const SECRETS_AGENT_ID = "agent-reminder-secrets";
const ORIGINAL_LETTA_API_KEY = process.env.LETTA_API_KEY;
const ORIGINAL_LETTA_BASE_URL = process.env.LETTA_BASE_URL;

async function buildSecretsTestReminderParts(
  state: ReturnType<typeof createSharedReminderState>,
) {
  const origReflectionStep = sharedReminderProviders["reflection-step-count"];
  const origReflectionCompaction =
    sharedReminderProviders["reflection-compaction"];
  sharedReminderProviders["reflection-step-count"] = async () => null;
  sharedReminderProviders["reflection-compaction"] = async () => null;
  try {
    return await buildSharedReminderParts({
      mode: "listen",
      agent: { id: SECRETS_AGENT_ID, name: null },
      state,
      systemInfoReminderEnabled: false,
      reflectionSettings: { trigger: "off", stepCount: 25 },
      skillSources: [],
    });
  } finally {
    sharedReminderProviders["reflection-step-count"] = origReflectionStep;
    sharedReminderProviders["reflection-compaction"] = origReflectionCompaction;
  }
}

beforeEach(() => {
  delete process.env.LETTA_API_KEY;
  delete process.env.LETTA_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL_LETTA_API_KEY === undefined) {
    delete process.env.LETTA_API_KEY;
  } else {
    process.env.LETTA_API_KEY = ORIGINAL_LETTA_API_KEY;
  }
  if (ORIGINAL_LETTA_BASE_URL === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = ORIGINAL_LETTA_BASE_URL;
  }
  clearSecretsCache(SECRETS_AGENT_ID);
  setCurrentAgentId(null);
});

describe("headless shared reminder content helpers", () => {
  test("prepends reminder text to string user content as parts array", () => {
    const result = prependReminderPartsToContent("hello", [
      { type: "text", text: "<skills>demo</skills>" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toEqual({ type: "text", text: "<skills>demo</skills>" });
    expect(result[1]).toEqual({ type: "text", text: "hello" });
  });

  test("prepends reminder parts for multimodal user content", () => {
    const multimodal = [
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ] as unknown as Exclude<MessageCreate["content"], string>;

    const result = prependReminderPartsToContent(
      multimodal as MessageCreate["content"],
      [{ type: "text", text: "<skills>demo</skills>" }],
    );

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toEqual({
      type: "text",
      text: "<skills>demo</skills>",
    });
    expect(result[1]).toEqual(multimodal[0]);
    expect(result[2]).toEqual(multimodal[1]);
  });

  test("uses only reminder parts when user content is nullish", () => {
    const reminder = { type: "text" as const, text: "<skills>demo</skills>" };

    expect(
      prependReminderPartsToContent(
        null as unknown as MessageCreate["content"],
        [reminder],
      ),
    ).toEqual([reminder]);
    expect(
      prependReminderPartsToContent(
        undefined as unknown as MessageCreate["content"],
        [reminder],
      ),
    ).toEqual([reminder]);
  });

  test("stringifies unexpected user content when prepending reminders", () => {
    const result = prependReminderPartsToContent(
      { ref: "abc" } as unknown as MessageCreate["content"],
      [{ type: "text", text: "<skills>demo</skills>" }],
    );

    expect(result).toEqual([
      { type: "text", text: "<skills>demo</skills>" },
      { type: "text", text: '{"ref":"abc"}' },
    ]);
  });
});

describe("secrets info reminders", () => {
  test("emits secret names when the cached name list changes", async () => {
    const state = createSharedReminderState();
    state.lastNotifiedPermissionMode = permissionMode.getMode();

    const initial = await buildSecretsTestReminderParts(state);
    expect(initial.appliedReminderIds).not.toContain("secrets-info");

    await initSecretsFromServer(SECRETS_AGENT_ID, {
      secrets: [{ key: "PLAYGROUND_AGENT_ID", value: "agent-123" }],
    });

    const updated = await buildSecretsTestReminderParts(state);

    const text = updated.parts.map((part) => part.text).join("\n");
    expect(updated.appliedReminderIds).toContain("secrets-info");
    expect(text).toContain("The agent secrets were updated");
    expect(text).toContain("$PLAYGROUND_AGENT_ID");
  });

  test("re-emits secret names after a secrets refresh", async () => {
    await initSecretsFromServer(SECRETS_AGENT_ID, {
      secrets: [{ key: "PLAYGROUND_AGENT_ID", value: "agent-123" }],
    });
    setCurrentAgentId(SECRETS_AGENT_ID);
    const state = createSharedReminderState();
    state.hasSentSecretsInfo = true;
    state.lastNotifiedPermissionMode = permissionMode.getMode();

    markSecretsInfoReminderPending(state);

    const result = await buildSecretsTestReminderParts(state);

    const text = result.parts.map((part) => part.text).join("\n");
    expect(result.appliedReminderIds).toContain("secrets-info");
    expect(text).toContain("The agent secrets were updated");
    expect(text).toContain("$PLAYGROUND_AGENT_ID");
    expect(state.hasSentSecretsInfo).toBe(true);
    expect(state.pendingSecretsInfoRefresh).toBe(false);
  });

  test("reminds shell callers to pair LETTA_API_KEY with LETTA_BASE_URL", async () => {
    process.env.LETTA_API_KEY = "proxy-session-token";
    process.env.LETTA_BASE_URL = "http://localhost:57294";

    const state = createSharedReminderState();
    state.lastNotifiedPermissionMode = permissionMode.getMode();

    const result = await buildSecretsTestReminderParts(state);

    const text = result.parts.map((part) => part.text).join("\n");
    expect(result.appliedReminderIds).toContain("secrets-info");
    expect(text).toContain("use `$LETTA_BASE_URL` as the API host");
    expect(text).toContain("Do not hardcode `https://api.letta.com`");
    expect(text).toContain("$LETTA_BASE_URL/v1/...");
  });
});
