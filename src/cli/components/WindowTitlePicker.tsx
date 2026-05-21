// Window title configuration picker.
// Wraps MultiSelectPicker with window-title-specific logic.

import { memo, useCallback, useMemo, useState } from "react";
import {
  renderWindowTitle,
  resolveWindowTitleConfig,
  WINDOW_TITLE_FIELD_INFO,
  WINDOW_TITLE_FIELDS,
  type WindowTitleField,
} from "@/cli/helpers/window-title-config";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version";
import { MultiSelectPicker } from "./MultiSelectPicker";
import { OverlayShell } from "./OverlayShell";

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
    }),
    [agentName, conversationSummary],
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
    <OverlayShell command="/title" title="Configure Terminal Title">
      <MultiSelectPicker
        items={items}
        selected={new Set(selectedKeys)}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onSelectionChange={handleSelectionChange}
      />
    </OverlayShell>
  );
});
