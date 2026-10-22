import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ResetNotice,
  resetOutcomeNotice,
} from "@/cli/components/chatgpt-reset-credit-helpers";
import type { ProviderStorageTarget } from "@/providers/byok-providers";
import {
  type ChatGPTRateLimitResetCredits,
  consumeChatGPTRateLimitResetCredit,
  readChatGPTRateLimitResetCredits,
} from "@/providers/chatgpt-reset-credit-service";
import {
  type ChatGPTUsageSnapshot,
  formatChatGPTUsageQuotaRows,
  readChatGPTUsage,
} from "@/providers/chatgpt-usage-service";

export type ChatGPTUsageStatus =
  | { status: "loading" }
  | { status: "ready"; rows: string[] }
  | { status: "error"; message: string };

export type ChatGPTResetCreditsStatus =
  | { status: "loading" }
  | { status: "ready"; credits: ChatGPTRateLimitResetCredits }
  | { status: "error"; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Per-account ChatGPT usage and banked reset-credit state for the provider
 * manager. Usage and credits load independently so one failing does not hide
 * the other.
 */
export function useChatGPTRateLimitState(target: ProviderStorageTarget) {
  const [usageByProvider, setUsageByProvider] = useState<
    Record<string, ChatGPTUsageStatus>
  >({});
  const [creditsByProvider, setCreditsByProvider] = useState<
    Record<string, ChatGPTResetCreditsStatus>
  >({});
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    (providerNames: readonly string[], forceRefresh = false) => {
      for (const providerName of providerNames) {
        setUsageByProvider((previous) => ({
          ...previous,
          [providerName]: { status: "loading" },
        }));
        setCreditsByProvider((previous) => ({
          ...previous,
          [providerName]: { status: "loading" },
        }));

        void readChatGPTUsage({ target, providerName, forceRefresh })
          .then((result) => {
            if (!mountedRef.current) return;
            setUsageByProvider((previous) => ({
              ...previous,
              [providerName]: result.success
                ? {
                    status: "ready",
                    rows: formatChatGPTUsageQuotaRows(result.usage),
                  }
                : { status: "error", message: result.error.message },
            }));
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            setUsageByProvider((previous) => ({
              ...previous,
              [providerName]: {
                status: "error",
                message: errorMessage(error, "Failed to read ChatGPT usage."),
              },
            }));
          });

        void readChatGPTRateLimitResetCredits({
          target,
          providerName,
          forceRefresh,
        })
          .then((result) => {
            if (!mountedRef.current) return;
            setCreditsByProvider((previous) => ({
              ...previous,
              [providerName]: result.success
                ? { status: "ready", credits: result.credits }
                : { status: "error", message: result.error.message },
            }));
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            setCreditsByProvider((previous) => ({
              ...previous,
              [providerName]: {
                status: "error",
                message: errorMessage(
                  error,
                  "Failed to read ChatGPT reset credits.",
                ),
              },
            }));
          });
      }
    },
    [target],
  );

  /** Applies the fresh state returned alongside a successful reset. */
  const applyRefreshed = useCallback(
    (
      providerName: string,
      refreshed: {
        usage?: ChatGPTUsageSnapshot;
        credits?: ChatGPTRateLimitResetCredits;
      },
    ) => {
      const { usage, credits } = refreshed;
      if (usage) {
        setUsageByProvider((previous) => ({
          ...previous,
          [providerName]: {
            status: "ready",
            rows: formatChatGPTUsageQuotaRows(usage),
          },
        }));
      }
      if (credits) {
        setCreditsByProvider((previous) => ({
          ...previous,
          [providerName]: { status: "ready", credits },
        }));
      }
    },
    [],
  );

  /**
   * Spends one reset credit and applies the refreshed usage/credit state.
   * Only lifts the ChatGPT limit: the user stays in charge of resending any
   * rate-limited turn. A fresh idempotency key per confirmation means a
   * retried request is deduplicated upstream while a later deliberate reset
   * is a new redemption.
   */
  const consume = useCallback(
    async (providerName: string, resetId: string): Promise<ResetNotice> => {
      try {
        const result = await consumeChatGPTRateLimitResetCredit({
          target,
          providerName,
          resetId,
          idempotencyKey: randomUUID(),
        });
        if (!result.success) {
          return { tone: "warning", message: result.error.message };
        }
        applyRefreshed(providerName, {
          usage: result.refreshedUsage,
          credits: result.refreshedCredits,
        });
        const notice = resetOutcomeNotice(result.outcome, providerName);
        return result.refreshError
          ? {
              ...notice,
              message: `${notice.message} (Usage refresh failed: ${result.refreshError.message})`,
            }
          : notice;
      } catch (error) {
        return {
          tone: "warning",
          message: errorMessage(error, "Failed to apply reset."),
        };
      }
    },
    [applyRefreshed, target],
  );

  return { usageByProvider, creditsByProvider, load, consume };
}
