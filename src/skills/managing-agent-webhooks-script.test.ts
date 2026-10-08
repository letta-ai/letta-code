import { describe, expect, test } from "bun:test";
import {
  buildAgentWebhookBasicAuthorization,
  parseAgentWebhookArgs,
  resolveAgentWebhookTarget,
  safeAgentWebhook,
} from "@/skills/builtin/managing-agent-webhooks/scripts/manage-agent-webhooks.mjs";

describe("managing-agent-webhooks helper", () => {
  test("parses a public create request", () => {
    expect(
      parseAgentWebhookArgs([
        "create",
        "--name",
        "Build events",
        "--preprompt",
        "Summarize the build.",
        "--public",
      ]),
    ).toEqual({
      command: "create",
      args: {
        name: "Build events",
        preprompt: "Summarize the build.",
        public: true,
      },
    });
  });

  test("rejects management of another active agent", () => {
    expect(() =>
      resolveAgentWebhookTarget({
        currentAgentId: "agent-current",
        requestedAgentId: "agent-other",
      }),
    ).toThrow("Refusing to manage agent-other");
  });

  test("permits an explicit current agent when the environment has no ID", () => {
    expect(
      resolveAgentWebhookTarget({ requestedAgentId: "agent-current" }),
    ).toBe("agent-current");
  });

  test("redacts one-time credentials and the internal slug", () => {
    expect(
      safeAgentWebhook({
        authorization_header: "Basic do-not-print",
        id: "webhook-agent-1",
        name: "Build events",
        webhook_slug: "private-slug",
        webhook_url: "https://api.example.test/v1/agent-webhooks/private-slug",
      }),
    ).toEqual({
      id: "webhook-agent-1",
      name: "Build events",
      webhook_url: "https://api.example.test/v1/agent-webhooks/private-slug",
    });
  });

  test("builds the documented Basic authorization value", () => {
    expect(buildAgentWebhookBasicAuthorization("secret-key")).toBe(
      `Basic ${Buffer.from("webhook:secret-key").toString("base64")}`,
    );
  });
});
