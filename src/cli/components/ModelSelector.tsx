import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";
import { useMemo, useState } from "react";
import type { ModelReasoningSelection } from "@/agent/model";
import { ModelReasoningSelector } from "./ModelReasoningSelector";
import { SearchablePicker } from "./SearchablePicker";

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

export function ModelSelector({
  entries,
  onSelect,
  onCancel,
}: {
  entries: LettaCodeModelEntry[];
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
    <SearchablePicker
      title="Switch model"
      items={[...grouped].map(([key, group]) => ({
        key,
        label: group[0]?.label ?? key,
        description: key,
      }))}
      onSelect={(key) => {
        const group = grouped.get(key);
        if (group?.length === 1 && group[0]) onSelect(group[0].id);
        else setHandle(key);
      }}
      onCancel={onCancel}
    />
  );
}
