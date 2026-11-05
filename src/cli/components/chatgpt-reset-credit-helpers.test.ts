import { describe, expect, test } from "bun:test";
import {
  formatResetCreditLabel,
  formatResetCreditsSummary,
  resetOutcomeNotice,
  spendableResetCredits,
} from "@/cli/components/chatgpt-reset-credit-helpers";
import type {
  ChatGPTRateLimitResetCredit,
  ChatGPTRateLimitResetCredits,
} from "@/providers/chatgpt-reset-credit-service";

const NOW = new Date("2026-10-21T12:00:00Z");

function credit(
  id: string,
  overrides: Partial<ChatGPTRateLimitResetCredit> = {},
): ChatGPTRateLimitResetCredit {
  return {
    id,
    resetType: "codex_rate_limits",
    status: "available",
    grantedAt: "2026-10-01T00:00:00Z",
    expiresAt: null,
    title: "Full reset",
    description: null,
    ...overrides,
  };
}

function inventory(
  credits: ChatGPTRateLimitResetCredit[],
): ChatGPTRateLimitResetCredits {
  return {
    providerName: "chatgpt-plus-pro",
    fetchedAt: NOW.toISOString(),
    availableCount: credits.length,
    credits,
  };
}

describe("spendableResetCredits", () => {
  test("drops redeemed and expired credits and orders by soonest expiry", () => {
    const credits = inventory([
      credit("later", { expiresAt: "2026-11-15T00:00:00Z" }),
      credit("redeemed", { status: "redeemed" }),
      credit("expired", { expiresAt: "2026-10-20T00:00:00Z" }),
      credit("no-expiry"),
      credit("sooner", { expiresAt: "2026-10-23T00:00:00Z" }),
    ]);

    expect(spendableResetCredits(credits, NOW).map((c) => c.id)).toEqual([
      "sooner",
      "later",
      "no-expiry",
    ]);
  });
});

describe("reset credit formatting", () => {
  test("summarizes count and nearest expiry", () => {
    expect(
      formatResetCreditsSummary(
        inventory([
          credit("a", { expiresAt: "2026-10-23T00:00:00Z" }),
          credit("b", { expiresAt: "2026-11-15T00:00:00Z" }),
        ]),
        NOW,
      ),
    ).toBe("Resets: 2 available · next expires in 36h");
    expect(formatResetCreditsSummary(inventory([]), NOW)).toBe(
      "Resets: none available",
    );
  });

  test("labels a credit with its title and expiry", () => {
    expect(
      formatResetCreditLabel(
        credit("a", { expiresAt: "2026-11-15T00:00:00Z" }),
        NOW,
      ),
    ).toBe("Full reset · expires in 25d");
    expect(formatResetCreditLabel(credit("b", { title: null }), NOW)).toBe(
      "Usage reset",
    );
  });
});

describe("resetOutcomeNotice", () => {
  test("tells the user to resend after a reset instead of resuming for them", () => {
    expect(resetOutcomeNotice("reset", "chatgpt-plus-pro")).toEqual({
      tone: "success",
      message:
        "Reset applied to chatgpt-plus-pro. Resend your message to continue.",
    });
  });

  test("explains outcomes where no credit was spent", () => {
    expect(resetOutcomeNotice("nothing_to_reset", "work").tone).toBe("info");
    expect(resetOutcomeNotice("no_credit", "work").tone).toBe("warning");
  });
});
