import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACTING_USER_ID_HEADER,
  actingUserRequestOptions,
} from "@/agent/acting-user";

/**
 * Attribution contract for listener-created conversations.
 *
 * Cloud-api stamps `acting_user_id` onto relayed `conversation_create` and
 * `conversation_fork` frames; the listener must echo it back as the
 * `X-Letta-Acting-User-Id` header on the outbound create/fork HTTP calls so
 * cloud attributes the new conversation to the human who actually created it
 * (see tryApplyActingUserOverride in cloud-api). Without the echo,
 * conversations created from the sidebar are stamped as the sandbox/API-key
 * owner.
 *
 * Source-level pins are used for the handler wiring (matching the
 * existing `send-message-stream-acting-user.test.ts` convention, and
 * for the same reason: `mock.module` in other suites is process-global
 * under Bun). The helper itself is tested behaviorally.
 */

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
    // Remote /clear was the only execute_command that created a conversation,
    // and it is gone. Anything new here needs its own attribution pin above.
    expect(commandsSource).not.toContain("createConversation");
  });
});
