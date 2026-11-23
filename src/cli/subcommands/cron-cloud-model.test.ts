import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import { type Settings, settingsManager } from "@/settings-manager";

test.each(["openai/gpt-4.1", null, undefined])(
  "Cloud cron list and get show model %s",
  async (model) => {
    const home = mkdtempSync(join(tmpdir(), "letta-cron-model-"));
    const keys = [
      "LETTA_HOME",
      "LETTA_BASE_URL",
      "LETTA_API_KEY",
      "LETTA_CONVERSATION_ID",
    ] as const;
    const originalEnv = keys.map((key) => process.env[key]);
    process.env.LETTA_HOME = home;
    process.env.LETTA_BASE_URL = "https://example.test";
    process.env.LETTA_API_KEY = "test-key";
    delete process.env.LETTA_CONVERSATION_ID;

    const schedule = {
      id: "cloud-schedule",
      agent_id: "agent-cloud-test",
      conversation_id: "new",
      schedule: { type: "recurring", cron_expression: "0 * * * *" },
      ...(model !== undefined && { model }),
    };
    const initialize = spyOn(settingsManager, "initialize").mockResolvedValue(
      undefined,
    );
    const settings = spyOn(
      settingsManager,
      "getSettingsWithSecureTokens",
    ).mockResolvedValue({ env: {} } as Settings);
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0]) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/agents/agent-cloud-test/schedule") {
            return Response.json({
              scheduled_messages: [schedule],
              has_next_page: false,
            });
          }
          if (path === "/v1/agents/agent-cloud-test/schedule/cloud-schedule") {
            return Response.json(schedule);
          }
          throw new Error(`Unexpected request to ${path}`);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      const expected = {
        id: schedule.id,
        conversation_id: "new",
        model: model ?? null,
      };
      expect(
        await runCronSubcommand(["list", "--agent", schedule.agent_id]),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject([
        expected,
      ]);

      expect(
        await runCronSubcommand([
          "get",
          schedule.id,
          "--agent",
          schedule.agent_id,
        ]),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject(
        expected,
      );
    } finally {
      log.mockRestore();
      fetch.mockRestore();
      settings.mockRestore();
      initialize.mockRestore();
      for (const [index, key] of keys.entries()) {
        const value = originalEnv[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  },
);
