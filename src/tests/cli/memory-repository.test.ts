import { describe, expect, test } from "bun:test";
import { redactUrl } from "../../cli/commands/memory-repository";

describe("redactUrl", () => {
  test("masks credentials in HTTPS URLs", () => {
    expect(redactUrl("https://user:token@host/path")).toBe(
      "https://user:***@host/path",
    );
  });

  test("leaves HTTPS URLs without passwords unchanged", () => {
    expect(redactUrl("https://user@host/path")).toBe("https://user@host/path");
  });

  test("leaves SSH URLs unchanged", () => {
    expect(redactUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
  });

  test("leaves empty strings unchanged", () => {
    expect(redactUrl("")).toBe("");
  });
});
