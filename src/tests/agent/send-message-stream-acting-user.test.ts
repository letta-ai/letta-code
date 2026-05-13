import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Header propagation contract for the multi-user sandbox flow.
 *
 * When the listener turn passes
 * `SendMessageStreamOptions.actingUserId`, the outbound SDK call must
 * carry the `X-Letta-Acting-User-Id` HTTP header so cloud-api can
 * re-attribute credits + rate limits to the actual sender (rather
 * than the user whose API key spawned the sandbox).
 *
 * Self-hosted / single-user flows never set the option, so the
 * header is absent and behavior is unchanged.
 *
 * NOTE: This is a source-level test (rather than a behavioral one
 * with a mocked backend) because another test file in the suite
 * (`listen-client-concurrency.test.ts`) uses Bun's
 * `mock.module("../../agent/message", …)` which is process-global
 * and replaces the real `sendMessageStream` with a stub for the
 * remainder of the test run. A source-level check avoids that
 * cross-test pollution while still pinning the contract — the
 * actual behavior is exercised end-to-end by the queue and
 * listener integration tests.
 */
describe("sendMessageStream acting-user header propagation (contract)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../agent/message.ts", import.meta.url)),
    "utf-8",
  );

  test("public option is declared on SendMessageStreamOptions", () => {
    expect(source).toContain("actingUserId?: string;");
  });

  test("header is set from opts.actingUserId when present", () => {
    // Pin the precise injection so a refactor that drops the
    // condition or renames the header is caught.
    expect(source).toMatch(/if\s*\(\s*opts\.actingUserId\s*\)\s*\{/);
    expect(source).toContain(
      'extraHeaders["X-Letta-Acting-User-Id"] = opts.actingUserId',
    );
  });

  test("extraHeaders are merged into the SDK request headers", () => {
    // Guard the merge path so the header actually reaches the SDK
    // call's options.headers.
    expect(source).toMatch(/headers:\s*\{[\s\S]*?\.\.\.extraHeaders[\s\S]*?\}/);
  });
});
