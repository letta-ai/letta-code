// Window title configuration picker.
// Wraps MultiSelectPicker with window-title-specific logic.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  normalizeWindowTitleItems,
  previewLineForWindowTitleItems,
  renderWindowTitle,
  resolveWindowTitleConfig,
  WINDOW_TITLE_FIELD_INFO,
  WINDOW_TITLE_FIELDS,
  type WindowTitleData,
  type WindowTitleField,
} from "@/cli/helpers/window-title-config";
import { settingsManager } from "@/settings-manager";
import { MultiSelectPicker } from "./MultiSelectPicker";
import { OverlayShell } from "./OverlayShell";

interface WindowTitlePickerProps {
  projectDirectory: string;
  titleData: WindowTitleData;
  onTitlePreview: (title: string | null) => void;
  onClose: () => void;
}

export const WindowTitlePicker = memo(function WindowTitlePicker({
  projectDirectory,
  titleData,
  onTitlePreview,
  onClose,
}: WindowTitlePickerProps) {
  const currentItems = useMemo(
    () => resolveWindowTitleConfig(projectDirectory),
    [projectDirectory],
  );

  const [selectedKeys, setSelectedKeys] =
    useState<WindowTitleField[]>(currentItems);
  const hasHandledInitialSelectionChangeRef = useRef(false);

  const items = useMemo(() => {
    const selected = uniqueWindowTitleItems(currentItems);
    const selectedSet = new Set(selected);
    const ordered = [
      ...selected,
      ...WINDOW_TITLE_FIELDS.filter((key) => !selectedSet.has(key)),
    ];

    return ordered.map((key) => ({
      key,
      label: WINDOW_TITLE_FIELD_INFO[key].label,
      description: WINDOW_TITLE_FIELD_INFO[key].description,
    }));
  }, [currentItems]);

  const preview = useMemo(
    () => previewLineForWindowTitleItems(selectedKeys, titleData),
    [selectedKeys, titleData],
  );

  const applyTitlePreview = useCallback(
    (keys: WindowTitleField[]) => {
      const title = previewLineForWindowTitleItems(keys, titleData);
      onTitlePreview(title);
    },
    [onTitlePreview, titleData],
  );

  const handleSelectionChange = useCallback(
    (keys: string[]) => {
      const normalized = normalizeWindowTitleItems(keys);
      setSelectedKeys(normalized);
      if (!hasHandledInitialSelectionChangeRef.current) {
        hasHandledInitialSelectionChangeRef.current = true;
        return;
      }
      applyTitlePreview(normalized);
    },
    [applyTitlePreview],
  );

  const handleConfirm = useCallback(
    (keys: string[]) => {
      settingsManager.updateSettings({
        windowTitle: { items: normalizeWindowTitleItems(keys) },
      });
      onClose();
    },
    [onClose],
  );

  const handleCancel = useCallback(() => {
    const savedItems = resolveWindowTitleConfig(projectDirectory);
    const title = renderWindowTitle(savedItems, titleData);
    onTitlePreview(title);
    onClose();
  }, [projectDirectory, titleData, onTitlePreview, onClose]);

  return (
    <OverlayShell command="/title" title="Configure Terminal Title">
      <MultiSelectPicker
        items={items}
        selected={new Set(selectedKeys)}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onSelectionChange={handleSelectionChange}
        preview={preview ?? undefined}
        enableOrdering
      />
    </OverlayShell>
  );
});

function uniqueWindowTitleItems(
  items: readonly WindowTitleField[],
): WindowTitleField[] {
  const seen = new Set<WindowTitleField>();
  const unique: WindowTitleField[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}
