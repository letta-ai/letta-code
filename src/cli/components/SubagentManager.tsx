/**
 * SubagentManager component - displays available subagents
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import {
  AGENTS_DIR,
  GLOBAL_AGENTS_DIR,
  clearSubagentConfigCache,
  getAllSubagentConfigs,
  getBuiltinSubagentNames,
  type SubagentConfig,
} from "../../agent/subagents";
import { colors } from "./colors";

interface SubagentManagerProps {
  onClose: () => void;
}

interface SubagentItem {
  name: string;
  config: SubagentConfig;
}

export function SubagentManager({ onClose }: SubagentManagerProps) {
  const [builtinSubagents, setBuiltinSubagents] = useState<SubagentItem[]>([]);
  const [customSubagents, setCustomSubagents] = useState<SubagentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSubagents() {
      setLoading(true);
      setError(null);
      try {
        clearSubagentConfigCache();
        const configs = await getAllSubagentConfigs();
        const builtinNames = getBuiltinSubagentNames();
        const builtin: SubagentItem[] = [];
        const custom: SubagentItem[] = [];

        for (const [name, config] of Object.entries(configs)) {
          const item = { name, config };
          if (builtinNames.has(name)) {
            builtin.push(item);
          } else {
            custom.push(item);
          }
        }

        builtin.sort((a, b) => a.name.localeCompare(b.name));
        custom.sort((a, b) => a.name.localeCompare(b.name));

        setBuiltinSubagents(builtin);
        setCustomSubagents(custom);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadSubagents();
  }, []);

  useInput((_input, key) => {
    if (key.escape || key.return) {
      onClose();
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading subagents...</Text>
      </Box>
    );
  }

  const renderSubagentList = (items: SubagentItem[]) =>
    items.map((item) => (
      <Box key={item.name} flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text bold color={colors.selector.itemHighlighted}>
            {item.name}
          </Text>
          <Text dimColor>({item.config.recommendedModel})</Text>
        </Box>
        <Text> {item.config.description}</Text>
      </Box>
    ));

  const hasNoSubagents =
    builtinSubagents.length === 0 && customSubagents.length === 0;

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text bold color={colors.selector.title}>
        Available Subagents
      </Text>

      {error && <Text color={colors.status.error}>Error: {error}</Text>}

      {hasNoSubagents ? (
        <Text dimColor>No subagents found</Text>
      ) : (
        <>
          {builtinSubagents.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>
                Built-in
              </Text>
              {renderSubagentList(builtinSubagents)}
            </Box>
          )}

          {customSubagents.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>
                Custom
              </Text>
              {renderSubagentList(customSubagents)}
            </Box>
          )}
        </>
      )}

      <Text dimColor>
      To add custom subagents, create .md files in {AGENTS_DIR}/ (project) or {GLOBAL_AGENTS_DIR}/ (global)
      </Text>
      <Text dimColor>Press ESC or Enter to close</Text>
    </Box>
  );
}
