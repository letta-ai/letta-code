import { useEffect, useMemo, useRef } from "react";
import { isLocalBackendEnabled } from "@/backend";
import { isLocalAgentId } from "@/cli/helpers/app-urls";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { debugWarn } from "@/utils/debug";
import {
  type LocalSessionOwnerHandle,
  startLocalSessionOwner,
} from "@/websocket/local-session-owner";

export interface LocalSessionOwnerController {
  ready(signal?: AbortSignal): Promise<boolean>;
  stopAdmission(): void;
  resumeAdmission(): void;
  release(): Promise<boolean>;
}

type LocalSessionOwnerStarter = (
  options: Parameters<typeof startLocalSessionOwner>[0],
) => Promise<LocalSessionOwnerHandle>;
let testLocalSessionOwnerStarter: LocalSessionOwnerStarter | null = null;

export function __testSetLocalSessionOwnerStarter(
  starter: LocalSessionOwnerStarter | null,
): void {
  testLocalSessionOwnerStarter = starter;
}

export function useLocalSessionOwner(params: {
  agentId: string;
  conversationId: string;
  queueRuntime: QueueRuntime;
  onQueueChanged: () => void;
  onAbort: () => boolean;
  isProcessing: boolean;
}): LocalSessionOwnerController {
  const onQueueChangedRef = useRef(params.onQueueChanged);
  const onAbortRef = useRef(params.onAbort);
  const isProcessingRef = useRef(params.isProcessing);
  const ownerPromiseRef = useRef<
    ReturnType<typeof startLocalSessionOwner> | undefined
  >(undefined);
  const scopeKey = `${params.agentId}:${params.conversationId || "default"}`;
  const readinessRef = useRef<{
    key: string;
    promise: Promise<boolean>;
    resolve: (ready: boolean) => void;
  } | null>(null);
  if (readinessRef.current?.key !== scopeKey) {
    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    readinessRef.current = { key: scopeKey, promise, resolve };
  }
  const acceptingRef = useRef(true);
  onQueueChangedRef.current = params.onQueueChanged;
  onAbortRef.current = params.onAbort;
  isProcessingRef.current = params.isProcessing;
  useEffect(() => {
    const readiness = readinessRef.current;
    if (
      isLocalBackendEnabled() ||
      !params.agentId ||
      params.agentId === "loading" ||
      isLocalAgentId(params.agentId)
    ) {
      readiness?.resolve(false);
      return;
    }

    let disposed = false;
    let release: (() => Promise<boolean>) | undefined;
    acceptingRef.current = true;
    const ownerPromise = (
      testLocalSessionOwnerStarter ?? startLocalSessionOwner
    )({
      agentId: params.agentId,
      conversationId: params.conversationId || "default",
      queueRuntime: params.queueRuntime,
      surfaceName: "TUI",
      onQueueChanged: () => onQueueChangedRef.current(),
      onAbort: () => onAbortRef.current(),
      isProcessing: () => isProcessingRef.current,
      waitForAcceptedInputs: async () => {
        const hasAcceptedScopeInput = params.queueRuntime
          .peek()
          .some(
            (item) =>
              (item.agentId === undefined &&
                item.conversationId === undefined) ||
              (item.agentId === params.agentId &&
                item.conversationId === (params.conversationId || "default")),
          );
        if (hasAcceptedScopeInput) {
          throw new Error(
            "Cannot release a local session owner before its accepted input drains",
          );
        }
      },
      onError: (error) => debugWarn("tui-session-owner", error.message),
    });
    ownerPromiseRef.current = ownerPromise;
    void ownerPromise
      .then((owner) => {
        void owner.ready().then((ready) => readiness?.resolve(ready));
        if (!acceptingRef.current) owner.stopAdmission();
        if (disposed) {
          void owner.release().catch((error: unknown) => {
            debugWarn(
              "tui-session-owner",
              error instanceof Error ? error.message : String(error),
            );
          });
        } else release = () => owner.release();
      })
      .catch((error: unknown) => {
        debugWarn(
          "tui-session-owner",
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      disposed = true;
      if (ownerPromiseRef.current === ownerPromise) {
        ownerPromiseRef.current = undefined;
      }
      void release?.().catch((error: unknown) => {
        debugWarn(
          "tui-session-owner",
          error instanceof Error ? error.message : String(error),
        );
      });
    };
  }, [params.agentId, params.conversationId, params.queueRuntime]);

  return useMemo(
    () => ({
      async ready(signal) {
        const ownerPromise = ownerPromiseRef.current;
        if (ownerPromise) return await (await ownerPromise).ready(signal);
        return (await readinessRef.current?.promise) ?? false;
      },
      stopAdmission() {
        acceptingRef.current = false;
        void ownerPromiseRef.current?.then((owner) => owner.stopAdmission());
      },
      resumeAdmission() {
        acceptingRef.current = true;
        void ownerPromiseRef.current?.then((owner) => owner.resumeAdmission());
      },
      async release() {
        acceptingRef.current = false;
        const owner = await ownerPromiseRef.current;
        return owner ? await owner.release() : true;
      },
    }),
    [],
  );
}
