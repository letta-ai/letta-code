import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";
import { useMemo, useState } from "react";
import type { ModelReasoningSelection } from "@/agent/model";
import { ModelReasoningSelector } from "@/cli/components/ModelReasoningSelector";
import { ModelSelector } from "@/cli/components/ModelSelector";

function effort(value: unknown): ModelReasoningSelection {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "none":
      return value;
    default:
      return null;
  }
}

export function SessionModelPicker({
  entries,
  handles,
  aliases,
  currentModel,
  local,
  onOpenConnect,
  refresh,
  onSelect,
  onCancel,
}: {
  entries: LettaCodeModelEntry[];
  handles?: string[] | null;
  aliases?: Record<string, string>;
  currentModel?: string;
  local: boolean;
  onOpenConnect: () => void;
  refresh: () => Promise<void>;
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [handle, setHandle] = useState<string>();
  const grouped = useMemo(() => {
    const groups = new Map<string, LettaCodeModelEntry[]>();
    for (const entry of entries) {
      const group = groups.get(entry.handle) ?? [];
      group.push(entry);
      groups.set(entry.handle, group);
    }
    return groups;
  }, [entries]);
  const tiers = handle ? grouped.get(handle) : undefined;
  if (tiers && tiers.length > 1)
    return (
      <ModelReasoningSelector
        modelLabel={tiers[0]?.label ?? handle ?? ""}
        initialModelId={
          (tiers.find((entry) => entry.isDefault) ?? tiers[0])?.id ?? ""
        }
        options={tiers.map((entry) => ({
          modelId: entry.id,
          effort: effort(entry.updateArgs?.reasoning_effort),
        }))}
        onSelect={(option) => onSelect(option.modelId)}
        onCancel={() => setHandle(undefined)}
      />
    );
  return (
    <ModelSelector
      entries={entries}
      handles={handles}
      aliases={aliases}
      currentModelHandle={currentModel}
      localModelCatalog={local}
      onOpenConnect={onOpenConnect}
      refresh={refresh}
      onCancel={onCancel}
      onSelect={(model) => {
        const group =
          grouped.get(model.handle) ?? grouped.get(model.registryHandle ?? "");
        if (group && group.length > 1) setHandle(group[0]?.handle);
        else onSelect(group?.[0]?.id ?? model.handle);
      }}
    />
  );
}
