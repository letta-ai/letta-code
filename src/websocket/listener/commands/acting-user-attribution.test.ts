import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACTING_USER_ID_HEADER,
  actingUserRequestOptions,
} from "@/agent/acting-user";

describe("actingUserRequestOptions", () => {
  test("header literal matches the wire contract used by message.ts and cloud-api", () => {
    expect(ACTING_USER_ID_HEADER).toBe("X-Letta-Acting-User-Id");
  });

  test("builds header options when an acting user is present", () => {
    expect(actingUserRequestOptions("user-123")).toEqual({
      headers: { "X-Letta-Acting-User-Id": "user-123" },
    });
  });

  test("returns undefined for self-hosted / direct flows", () => {
    expect(actingUserRequestOptions(undefined)).toBeUndefined();
    expect(actingUserRequestOptions("")).toBeUndefined();
  });
});

describe("listener conversation-create attribution wiring (contract)", () => {
  const handlerSource = readFileSync(
    fileURLToPath(new URL("./agents-conversations.ts", import.meta.url)),
    "utf-8",
  );
  const commandsSource = readFileSync(
    fileURLToPath(new URL("../commands.ts", import.meta.url)),
    "utf-8",
  );

  test("conversation_create echoes the relayed acting user", () => {
    expect(handlerSource).toMatch(
      /backend\.createConversation\(\s*parsed\.body,\s*actingUserRequestOptions\(parsed\.acting_user_id\),\s*\)/,
    );
  });

  test("conversation_fork echoes the relayed acting user", () => {
    expect(handlerSource).toMatch(
      /backend\.forkConversation\([\s\S]*?actingUserRequestOptions\(parsed\.acting_user_id\)/,
    );
  });

  test("the listener command dispatcher creates no conversations of its own", () => {
    expect(commandsSource).not.toContain("createConversation");
  });
});
