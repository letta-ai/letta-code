// Toolset selector.
// Wraps SingleSelectPicker with toolset-specific logic.

import { memo, useCallback, useMemo, useState } from "react";
import type { ToolsetName, ToolsetPreference } from "@/tools/toolset";
import { formatToolsetName } from "@/tools/toolset-labels";
import { OverlayShell } from "./OverlayShell";
import type { SelectableItem } from "./SingleSelectPicker";
import { SingleSelectPicker } from "./SingleSelectPicker";

const SHOW_ALL_KEY = "__show_all__";

interface ToolsetOption {
  id: ToolsetPreference;
  label: string;
  description: string;
  isFeatured?: boolean;
}

const toolsets: ToolsetOption[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Auto-select based on the model",
    isFeatured: true,
  },
  {
    id: "none",
    label: "None",
    description: "Remove all Letta Code tools from your agent",
    isFeatured: true,
  },
  {
    id: "default",
    label: "Claude toolset",
    description: "Optimized for Anthropic models",
    isFeatured: true,
  },
  {
    id: "codex",
    label: "Codex toolset",
    description: "Optimized for GPT/Codex models",
    isFeatured: true,
  },
  {
    id: "gemini",
    label: "Gemini toolset",
    description: "Optimized for Google Gemini models",
    isFeatured: true,
  },
  {
    id: "codex_snake",
    label: "Codex toolset (snake_case)",
    description: "Optimized for GPT/Codex models (snake_case)",
  },
  {
    id: "gemini_snake",
    label: "Gemini toolset (snake_case)",
    description: "Optimized for Google Gemini models (snake_case)",
  },
];

interface ToolsetSelectorProps {
  currentToolset?: ToolsetName;
  currentPreference?: ToolsetPreference;
  onSelect: (toolsetId: ToolsetPreference) => void;
  onCancel: () => void;
}

export const ToolsetSelector = memo(function ToolsetSelector({
  currentToolset,
  currentPreference = "auto",
  onSelect,
  onCancel,
}: ToolsetSelectorProps) {
  const [showAll, setShowAll] = useState(false);

  const featuredToolsets = useMemo(
    () => toolsets.filter((toolset) => toolset.isFeatured),
    [],
  );

  const hasShowAllOption =
    !showAll && featuredToolsets.length < toolsets.length;

  const visibleToolsets = useMemo(() => {
    if (showAll) return toolsets;
    if (featuredToolsets.length > 0) return featuredToolsets;
    return toolsets;
  }, [featuredToolsets, showAll]);

  const items = useMemo<SelectableItem[]>(() => {
    const toolsetItems: SelectableItem[] = visibleToolsets.map((toolset) => {
      const isCurrent = toolset.id === currentPreference;

      // For "auto" when current, show resolved name in the label and skip
      // isCurrent to avoid double "(current)". For all others, let
      // SingleSelectPicker's isCurrent handle the "(current)" marker.
      if (toolset.id === "auto" && isCurrent) {
        return {
          key: toolset.id,
          label: `Auto (current - ${formatToolsetName(currentToolset)})`,
          description: toolset.description,
          isCurrent: false,
        };
      }

      return {
        key: toolset.id,
        label: toolset.label,
        description: toolset.description,
        isCurrent,
      };
    });

    if (hasShowAllOption) {
      toolsetItems.push({
        key: SHOW_ALL_KEY,
        label: "Show all toolsets",
        dimLabel: true,
      });
    }

    return toolsetItems;
  }, [visibleToolsets, hasShowAllOption, currentPreference, currentToolset]);

  const handleSelect = useCallback(
    (key: string) => {
      if (key === SHOW_ALL_KEY) {
        setShowAll(true);
        return;
      }
      onSelect(key as ToolsetPreference);
    },
    [onSelect],
  );

  return (
    <OverlayShell command="/toolset" title="Swap your agent's toolset">
      <SingleSelectPicker
        items={items}
        onSelect={handleSelect}
        onCancel={onCancel}
      />
    </OverlayShell>
  );
});
