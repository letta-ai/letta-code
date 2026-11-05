import type {
  ChatGPTRateLimitResetConsumeOutcome,
  ChatGPTRateLimitResetCredit,
  ChatGPTRateLimitResetCredits,
} from "@/providers/chatgpt-reset-credit-service";

export type ResetNoticeTone = "success" | "info" | "warning";

export interface ResetNotice {
  tone: ResetNoticeTone;
  message: string;
}

function formatExpiryDistance(
  expiresAt: string | null,
  now: Date,
): string | null {
  if (!expiresAt) return null;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return null;
  const deltaMs = expiresMs - now.getTime();
  if (deltaMs <= 0) return "expired";

  const hours = Math.ceil(deltaMs / 3_600_000);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires in ${Math.ceil(hours / 24)}d`;
}

/** Credits the user can still spend, soonest-expiring first. */
export function spendableResetCredits(
  credits: ChatGPTRateLimitResetCredits,
  now: Date = new Date(),
): ChatGPTRateLimitResetCredit[] {
  return credits.credits
    .filter((credit) => credit.status === "available")
    .filter(
      (credit) =>
        !credit.expiresAt || Date.parse(credit.expiresAt) > now.getTime(),
    )
    .sort(
      (a, b) =>
        (a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY) -
        (b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY),
    );
}

export function formatResetCreditsSummary(
  credits: ChatGPTRateLimitResetCredits,
  now: Date = new Date(),
): string {
  const spendable = spendableResetCredits(credits, now);
  if (spendable.length === 0) return "Resets: none available";
  const count = `${spendable.length} available`;
  const nextExpiry = formatExpiryDistance(spendable[0]?.expiresAt ?? null, now);
  return nextExpiry
    ? `Resets: ${count} · next ${nextExpiry}`
    : `Resets: ${count}`;
}

export function formatResetCreditLabel(
  credit: ChatGPTRateLimitResetCredit,
  now: Date = new Date(),
): string {
  const title = credit.title ?? "Usage reset";
  const expiry = formatExpiryDistance(credit.expiresAt, now);
  return expiry ? `${title} · ${expiry}` : title;
}

/**
 * Copy shown after a consume attempt. A reset only lifts the ChatGPT limit;
 * the user stays in charge of resending whatever turn was rate limited.
 */
export function resetOutcomeNotice(
  outcome: ChatGPTRateLimitResetConsumeOutcome,
  providerName: string,
): ResetNotice {
  switch (outcome) {
    case "reset":
      return {
        tone: "success",
        message: `Reset applied to ${providerName}. Resend your message to continue.`,
      };
    case "already_redeemed":
      return {
        tone: "success",
        message: `This reset was already applied to ${providerName}.`,
      };
    case "nothing_to_reset":
      return {
        tone: "info",
        message: `${providerName} isn't rate limited right now, so no reset was used.`,
      };
    case "no_credit":
      return {
        tone: "warning",
        message: `No resets are left for ${providerName}.`,
      };
  }
}
