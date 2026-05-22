import { Box } from "ink";
import type { WorktreeDiffOption } from "@/web/worktree-diff-list";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { type SelectableItem, SingleSelectPicker } from "./SingleSelectPicker";
import { Text } from "./Text";

type WorktreeDiffSelectorProps = {
  worktrees: WorktreeDiffOption[];
  onSelect: (path: string) => void;
  onCancel: () => void;
};

export function WorktreeDiffSelector({
  worktrees,
  onSelect,
  onCancel,
}: WorktreeDiffSelectorProps) {
  const items: SelectableItem[] = worktrees.map((worktree) => ({
    key: worktree.path,
    label: worktree.name,
    description: `${worktree.branch} · ${worktree.fileCount} files · +${worktree.insertions}/-${worktree.deletions}`,
    isCurrent: worktree.isCurrent,
    dimLabel: !worktree.hasChanges,
  }));

  return (
    <OverlayShell command="/experiments diffs" title="Open Worktree Diff">
      {items.length === 0 ? (
        <Text dimColor>No worktrees found.</Text>
      ) : (
        <SingleSelectPicker
          items={items}
          onSelect={onSelect}
          onCancel={onCancel}
          renderItem={(item, _index, isSelected) => {
            const worktree = worktrees.find((entry) => entry.path === item.key);
            if (!worktree) return null;
            return (
              <Box flexDirection="column" marginBottom={1}>
                <Box>
                  <Text
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isSelected ? "> " : "  "}
                  </Text>
                  <Text
                    bold={isSelected}
                    dimColor={!worktree.hasChanges}
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {worktree.name}
                    {worktree.isCurrent ? " (current)" : ""}
                  </Text>
                  <Text dimColor>{` · ${worktree.branch}`}</Text>
                  <Text color={worktree.hasChanges ? "green" : undefined}>
                    {` · ${worktree.fileCount} files`}
                  </Text>
                  <Text color="green">{` +${worktree.insertions}`}</Text>
                  <Text color="red">{` -${worktree.deletions}`}</Text>
                </Box>
                <Box marginLeft={2}>
                  <Text dimColor>{worktree.path}</Text>
                </Box>
              </Box>
            );
          }}
        />
      )}
    </OverlayShell>
  );
}
