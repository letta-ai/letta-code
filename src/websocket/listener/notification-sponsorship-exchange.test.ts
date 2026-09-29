import { describe, expect, test } from "bun:test";
import { NotificationSponsorshipExchangeError } from "@/backend/api/request";
import { exchangeNotificationSponsorshipWhenReady } from "./turn-send";

describe("notification sponsorship exchange", () => {
  test("retries the listener-acceptance race without retaining a capability", async () => {
    let attempts = 0;
    const result = await exchangeNotificationSponsorshipWhenReady(
      { deliveryId: "delivery-1", clientMessageId: "notification-v1-stable" },
      undefined,
      async () => {
        attempts += 1;
        if (attempts < 3) throw new NotificationSponsorshipExchangeError(409);
        return { kind: "capability", capability: "one-use-capability" };
      },
    );

    expect(result).toEqual({
      kind: "capability",
      capability: "one-use-capability",
    });
    expect(attempts).toBe(3);
  });

  test("does not retry authorization or rollout failures", async () => {
    let attempts = 0;
    await expect(
      exchangeNotificationSponsorshipWhenReady(
        {
          deliveryId: "delivery-1",
          clientMessageId: "notification-v1-stable",
        },
        undefined,
        async () => {
          attempts += 1;
          throw new NotificationSponsorshipExchangeError(403);
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });

  test("treats an existing admission as an idempotent receipt", async () => {
    await expect(
      exchangeNotificationSponsorshipWhenReady(
        {
          deliveryId: "delivery-1",
          clientMessageId: "notification-v1-stable",
        },
        undefined,
        async () => ({
          kind: "receipt",
          admissionState: "core_accepted",
        }),
      ),
    ).resolves.toEqual({
      kind: "receipt",
      admissionState: "core_accepted",
    });
  });
});
