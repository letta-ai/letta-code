import { AsyncLocalStorage } from "node:async_hooks";
import type { ModInvocationContext } from "@/mods/types";

export type ModNotificationHandler = (
  message: string,
  context: ModInvocationContext | null,
) => void;

const modInvocationContext = new AsyncLocalStorage<ModInvocationContext>();

export function notifyMod(
  handler: ModNotificationHandler,
  message: string,
): void {
  handler(message.trim(), modInvocationContext.getStore() ?? null);
}

export function runWithModInvocationContext<TResult>(
  context: ModInvocationContext,
  callback: () => TResult,
): TResult {
  return modInvocationContext.run(context, callback);
}

export function invoke<TEvent, TContext extends ModInvocationContext, TResult>(
  context: TContext,
  registration: {
    handler: (event: TEvent, context: TContext) => TResult;
  },
  event: TEvent,
): TResult {
  return modInvocationContext.run(context, () =>
    registration.handler(event, context),
  );
}
