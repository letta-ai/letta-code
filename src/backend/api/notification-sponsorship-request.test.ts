import { describe, expect, test } from "bun:test";
import { parseNotificationSponsorshipExchange } from "./request";

describe("notification sponsorship exchange responses", () => {
  test("accepts a one-use capability without exposing it elsewhere", () => {
    expect(
      parseNotificationSponsorshipExchange({
        admission_state: "new",
        capability: "raw-one-use-capability",
        expires_at: "2026-09-29T22:00:00.000Z",
      }),
    ).toEqual({ kind: "capability", capability: "raw-one-use-capability" });
  });

  test("accepts the complete admission receipt returned after an ambiguous retry", () => {
    expect(
      parseNotificationSponsorshipExchange({
        admission_state: "core_accepted",
        request_id: "request-1",
        core_message_id: "message-1",
        core_run_id: "run-1",
      }),
    ).toEqual({ kind: "receipt", admissionState: "core_accepted" });
  });

  test("rejects raw capabilities on receipt responses", () => {
    expect(() =>
      parseNotificationSponsorshipExchange({
        admission_state: "core_accepted",
        request_id: "request-1",
        core_message_id: "message-1",
        core_run_id: "run-1",
        capability: "must-not-be-returned",
      }),
    ).toThrow("invalid receipt");
  });

  test("rejects receipts whose Core IDs do not match their state", () => {
    expect(() =>
      parseNotificationSponsorshipExchange({
        admission_state: "core_accepted",
        request_id: "request-1",
        core_message_id: null,
        core_run_id: null,
      }),
    ).toThrow("invalid receipt");
    expect(() =>
      parseNotificationSponsorshipExchange({
        admission_state: "admitting",
        request_id: "request-1",
        core_message_id: "message-1",
        core_run_id: "run-1",
      }),
    ).toThrow("invalid receipt");
  });
});
