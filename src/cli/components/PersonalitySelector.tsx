// Personality selector.
// Wraps SingleSelectPicker with personality-specific logic.

import { memo, useMemo } from "react";
import {
  PERSONALITY_OPTIONS,
  type PersonalityId,
} from "@/agent/personality-presets";
import { OverlayShell } from "./OverlayShell";
import type { SelectableItem } from "./SingleSelectPicker";
import { SingleSelectPicker } from "./SingleSelectPicker";

interface PersonalitySelectorProps {
  currentPersonalityId?: PersonalityId;
  onSelect: (personalityId: PersonalityId) => void;
  onCancel: () => void;
}

export const PersonalitySelector = memo(function PersonalitySelector({
  currentPersonalityId,
  onSelect,
  onCancel,
}: PersonalitySelectorProps) {
  const items = useMemo<SelectableItem[]>(
    () =>
      PERSONALITY_OPTIONS.map((option) => ({
        key: option.id,
        label: option.label,
        description: option.description,
        isCurrent: option.id === currentPersonalityId,
      })),
    [currentPersonalityId],
  );

  return (
    <OverlayShell command="/personality" title="Swap your agent personality">
      <SingleSelectPicker
        items={items}
        onSelect={(key) => onSelect(key as PersonalityId)}
        onCancel={onCancel}
      />
    </OverlayShell>
  );
});
