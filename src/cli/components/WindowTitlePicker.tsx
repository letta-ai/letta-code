// Window title configuration picker.
// Wraps MultiSelectPicker with window-title-specific logic.

import { Box } from "ink";
import { memo, useCallback, useMemo, useState } from "react";
import { settingsManager } from "../../settings-manager";
import { getVersion } from "../../version";
import {
  renderWindowTitle,
  resolveGitBranch,
  resolveWindowTitleConfig,
  WINDOW_TITLE_FIELD_INFO,
  WINDOW_TITLE_FIELDS,
  type WindowTitleField,
} from "../helpers/windowTitleConfig";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { MultiSelectPicker } from "./MultiSelectPicker";
import { Text } from "./Text";

const SOLID_LINE = "─";

interface WindowTitlePickerProps {
  agentName: string | null;
  projectDirectory: string;
  conversationSummary: string | null;
  onClose: () => void;
}

export const WindowTitlePicker = memo(function WindowTitlePicker({
  agentName,
  projectDirectory,
  conversationSummary,
  onClose,
}: WindowTitlePickerProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const currentItems = useMemo(
    () => resolveWindowTitleConfig(projectDirectory),
    [projectDirectory],
  );

  const [selectedKeys, setSelectedKeys] = useState<string[]>(currentItems);

  const items = useMemo(
    () =>
      WINDOW_TITLE_FIELDS.map((key) => ({
        key,
        label: WINDOW_TITLE_FIELD_INFO[key].label,
        description: WINDOW_TITLE_FIELD_INFO[key].description,
      })),
    [],
  );

  const titleData = useMemo(
    () => ({
      agentName,
      appName: "Letta Code",
      version: getVersion(),
      conversationSummary,
      gitBranch: resolveGitBranch(projectDirectory),
    }),
    [agentName, conversationSummary, projectDirectory],
  );

  const handleSelectionChange = useCallback(
    (keys: string[]) => {
      setSelectedKeys(keys);
      // Update terminal title live so the user sees the effect immediately
      const title = renderWindowTitle(keys as WindowTitleField[], titleData);
      process.stdout.write(`\x1b]0;${title}\x07`);
    },
    [titleData],
  );

  const handleConfirm = useCallback(
    (keys: string[]) => {
      settingsManager.updateSettings({
        windowTitle: { items: keys },
      });
      onClose();
    },
    [onClose],
  );

  const handleCancel = useCallback(() => {
    // Revert terminal title to the persisted config
    const savedItems = resolveWindowTitleConfig(projectDirectory);
    const title = renderWindowTitle(savedItems, titleData);
    process.stdout.write(`\x1b]0;${title}\x07`);
    onClose();
  }, [projectDirectory, titleData, onClose]);

  return (
    <>
      <Text dimColor>{"> /title"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />
      <MultiSelectPicker
        title="Configure Terminal Title"
        description="Select which items to display in the terminal title."
        items={items}
        selected={new Set(selectedKeys)}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onSelectionChange={handleSelectionChange}
      />
    </>
  );
});
