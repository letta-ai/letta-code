import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { type Buffers, type Line, toLines } from "@/cli/helpers/accumulator";
import { backfillBuffers } from "@/cli/helpers/backfill";
import type { StaticItem } from "./types";

export function restoreConversationView(params: {
  buffers: Buffers;
  history: Message[];
  emittedIds: Set<string>;
  hasBackfilledRef: MutableRefObject<boolean>;
  resetDeferredToolCallCommits: () => void;
  resetTrajectoryBases: () => void;
  setLines: Dispatch<SetStateAction<Line[]>>;
  setStaticItems: Dispatch<SetStateAction<StaticItem[]>>;
  separatorId: string;
}): void {
  params.buffers.tokenCount = 0;
  params.emittedIds.clear();
  params.resetDeferredToolCallCommits();
  params.resetTrajectoryBases();
  backfillBuffers(params.buffers, params.history);
  const items: StaticItem[] = [];
  for (const id of params.buffers.order) {
    const line = params.buffers.byId.get(id);
    if (!line) continue;
    params.emittedIds.add(id);
    items.push({ ...line } as StaticItem);
  }
  params.setStaticItems([
    { kind: "separator", id: params.separatorId },
    ...items,
  ]);
  params.setLines(toLines(params.buffers));
  params.hasBackfilledRef.current = true;
}
