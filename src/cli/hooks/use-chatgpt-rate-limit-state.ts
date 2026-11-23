import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ResetNotice,
  resetOutcomeNotice,
  spendableResetCredits,
} from "@/cli/components/chatgpt-reset-credit-helpers";
import {
  type ProviderManageAction,
  postResetOptionIndex,
} from "@/cli/components/provider-selector-helpers";
import type { ProviderStorageTarget } from "@/providers/byok-providers";
import {
  type ChatGPTRateLimitResetCredit,
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

export function useChatGPTRateLimitState(target: ProviderStorageTarget) {
  const [usageByProvider, setUsageByProvider] = useState<
    Record<string, ChatGPTUsageStatus>
  >({});
  const [creditsByProvider, setCreditsByProvider] = useState<
    Record<string, ChatGPTResetCreditsStatus>
  >({});
  const consumingRef = useRef(new Set<string>());
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

  const consume = useCallback(
    async (
      providerName: string,
      resetId: string,
    ): Promise<{
      notice: ResetNotice;
      credits?: ChatGPTRateLimitResetCredits;
    } | null> => {
      if (consumingRef.current.has(providerName)) return null;
      consumingRef.current.add(providerName);
      try {
        const result = await consumeChatGPTRateLimitResetCredit({
          target,
          providerName,
          resetId,
          idempotencyKey: randomUUID(),
        });
        if (!result.success) {
          return { notice: { tone: "warning", message: result.error.message } };
        }
        applyRefreshed(providerName, {
          usage: result.refreshedUsage,
          credits: result.refreshedCredits,
        });
        const notice = resetOutcomeNotice(result.outcome, providerName);
        return {
          credits: result.refreshedCredits,
          notice: result.refreshError
            ? {
                ...notice,
                message: `${notice.message} (Usage refresh failed: ${result.refreshError.message})`,
              }
            : notice,
        };
      } catch (error) {
        return {
          notice: {
            tone: "warning",
            message: errorMessage(error, "Failed to apply reset."),
          },
        };
      } finally {
        consumingRef.current.delete(providerName);
      }
    },
    [applyRefreshed, target],
  );

  const spendableCreditsFor = useCallback(
    (providerName: string): ChatGPTRateLimitResetCredit[] => {
      const status = creditsByProvider[providerName];
      return status?.status === "ready"
        ? spendableResetCredits(status.credits)
        : [];
    },
    [creditsByProvider],
  );

  const resettable = useCallback(
    (records: readonly { name: string }[]): string[] =>
      records
        .map((record) => record.name)
        .filter((name) => spendableCreditsFor(name).length > 0),
    [spendableCreditsFor],
  );

  return {
    usageByProvider,
    creditsByProvider,
    load,
    consume,
    spendableCreditsFor,
    resettable,
  };
}

export function usePostResetCursor(
  actions: readonly ProviderManageAction[] | null,
  setOptionIndex: (index: number) => void,
): () => void {
  const [pending, setPending] = useState(false);
  const targetIndex = actions ? postResetOptionIndex(actions) : null;
  useEffect(() => {
    if (!pending || targetIndex === null) return;
    setPending(false);
    setOptionIndex(targetIndex);
  }, [pending, targetIndex, setOptionIndex]);
  return useCallback(() => setPending(true), []);
}
