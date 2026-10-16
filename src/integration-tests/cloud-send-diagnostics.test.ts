import { expect, test } from "bun:test";
import { summarizeCloudSendExit } from "./process-diagnostics";

test("failed Cloud send retains safe context in the exit assertion", () => {
  const output = {
    status: "submission_failed",
    http_status: 503,
    is_error: true,
    run_ids: [],
    error: "Bearer secret response body",
    conversation_id: "private-id",
  };
  expect(() => expect(1, summarizeCloudSendExit(output)).toBe(0)).toThrow(
    "http_status: 503",
  );
  const diagnostic = summarizeCloudSendExit(output);
  expect(diagnostic).toContain("status: submission_failed");
  expect(diagnostic).not.toContain("secret");
  expect(diagnostic).not.toContain("private-id");
});

test("waiting failure reports receipt and observed runs without their contents", () => {
  const diagnostic = summarizeCloudSendExit({
    status: "wait_failed",
    receipt: { token: "secret" },
    run_ids: ["private-run"],
  });
  expect(diagnostic).toContain("receipt_present: true");
  expect(diagnostic).toContain("observed_run_count: 1");
  expect(diagnostic).not.toContain("private-run");
  expect(diagnostic).not.toContain("secret");
});

test("unknown values are omitted and success still passes the original assertion", () => {
  const diagnostic = summarizeCloudSendExit({
    status: "secret".repeat(10000),
    http_status: "secret",
    is_error: "secret",
    run_ids: "secret",
  });
  expect(diagnostic.length).toBeLessThan(250);
  expect(diagnostic).not.toContain("secret");
  expect(() =>
    expect(
      0,
      summarizeCloudSendExit({ status: "completed", is_error: false }),
    ).toBe(0),
  ).not.toThrow();
});
