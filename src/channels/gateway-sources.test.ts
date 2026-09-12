import { expect, test } from "bun:test";
import {
  sourceLifecycleKey,
  sourceRouteKey,
  uniqueLifecycleSources,
  uniqueRoutedSources,
} from "./gateway-sources";
import { makeSource } from "./gateway-test-support";

test("one route retains distinct input ownership and the latest source metadata", () => {
  const first = makeSource({ threadId: "thread", messageId: "first" });
  const next = { ...first, messageId: "next" };
  const enriched = { ...first, showStartupStatus: true };
  expect(sourceRouteKey(first)).toBe(sourceRouteKey(next));
  expect(sourceLifecycleKey(first)).not.toBe(sourceLifecycleKey(next));
  expect(uniqueRoutedSources([first, next, enriched])).toEqual([enriched]);
  expect(uniqueLifecycleSources([first, next, enriched])).toEqual([
    enriched,
    next,
  ]);
});

test("different accounts, threads, and agents retain separate sources", () => {
  const first = makeSource({ accountId: "one", threadId: "one" });
  const account = { ...first, accountId: "two" };
  const thread = { ...first, threadId: "two" };
  const agent = { ...first, agentId: "two" };
  expect(uniqueRoutedSources([first, account, thread])).toHaveLength(3);
  expect(uniqueLifecycleSources([first, account, thread, agent])).toHaveLength(
    4,
  );
});
