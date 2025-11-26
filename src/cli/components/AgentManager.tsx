/**
 * AgentManager component - displays available subagents
 */

import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import {
  clearSubagentConfigCache,
  getAllSubagentConfigs,
  AGENTS_DIR,
  type SubagentConfig,
} from "../../agent/subagents";
import { colors } from "./colors";

interface AgentManagerProps {
  onClose: () => void;
}

interface SubagentItem {
  name: string;
  config: SubagentConfig;
}

export function AgentManager({ onClose }: AgentManagerProps) {
  const [subagents, setSubagents] = useState<SubagentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSubagents();
  }, []);

  async function loadSubagents() {
    setLoading(true);
    setError(null);
    try {
      clearSubagentConfigCache();
      const configs = await getAllSubagentConfigs();
      const items: SubagentItem[] = Object.entries(configs).map(([name, config]) => ({
        name,
        config,
      }));
      items.sort((a, b) => a.name.localeCompare(b.name));
      setSubagents(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

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

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text bold color={colors.selector.title}>
        Available Subagents
      </Text>

      {error && (
        <Text color={colors.status.error}>Error: {error}</Text>
      )}

      <Box flexDirection="column">
        {subagents.length === 0 ? (
          <Text dimColor>No subagents found in {AGENTS_DIR}/</Text>
        ) : (
          subagents.map((item) => (
            <Box key={item.name} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text bold color={colors.selector.itemHighlighted}>
                  {item.name}
                </Text>
                <Text dimColor>({item.config.recommendedModel})</Text>
              </Box>
              <Text>  {item.config.description}</Text>
            </Box>
          ))
        )}
      </Box>

      <Text dimColor>
        To create or edit subagents, add .md files to {AGENTS_DIR}/
      </Text>
      <Text dimColor>Press ESC or Enter to close</Text>
    </Box>
  );
}
