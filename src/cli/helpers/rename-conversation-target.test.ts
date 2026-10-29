import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONVERSATION_RENAME_ERROR,
  renameConvo,
} from "@/cli/helpers/rename-conversation-target";

describe("renameConvo", () => {
  test("rejects the default conversation alias with a clear message", async () => {
    await expect(renameConvo("default", "cube")).rejects.toThrow(
      DEFAULT_CONVERSATION_RENAME_ERROR,
    );
  });
});
