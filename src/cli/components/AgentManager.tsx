/**
 * AgentManager component for managing subagents
 *
 * Provides an interactive UI for:
 * - Listing all available subagents
 * - Creating new subagents
 * - Editing existing subagents
 * - Deleting subagents
 */

import { Box, Text, useInput } from "ink";
import { spawn } from "node:child_process";
import { useEffect, useState } from "react";
import {
  clearSubagentConfigCache,
  createSubagentFile,
  deleteSubagentFile,
  getAllSubagentConfigs,
  getSubagentPath,
  type SubagentConfig,
} from "../../agent/subagents";
import { colors } from "./colors";

interface AgentManagerProps {
  onClose: () => void;
}

type Mode = "list" | "create-name" | "create-description" | "create-tools" | "create-model" | "confirm-delete";

interface SubagentItem {
  name: string;
  config: SubagentConfig;
}

const TOOL_OPTIONS = [
  { label: "All tools", value: "all" },
  { label: "Read-only (Glob, Grep, Read, LS)", value: "Glob, Grep, Read, LS, BashOutput" },
  { label: "Standard (Read, Write, Edit, Glob, Grep)", value: "Read, Write, Edit, Glob, Grep, LS, BashOutput" },
];

const MODEL_OPTIONS = [
  { label: "inherit (use parent model)", value: "inherit" },
  { label: "haiku (fast, lightweight)", value: "haiku" },
  { label: "sonnet (balanced)", value: "sonnet" },
  { label: "opus (most capable)", value: "opus" },
];

export function AgentManager({ onClose }: AgentManagerProps) {
  const [mode, setMode] = useState<Mode>("list");
  const [subagents, setSubagents] = useState<SubagentItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create wizard state
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [toolsIndex, setToolsIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);

  // Load subagents on mount
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
      // Sort alphabetically
      items.sort((a, b) => a.name.localeCompare(b.name));
      setSubagents(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    try {
      const toolsValue = TOOL_OPTIONS[toolsIndex]?.value || "all";
      const modelValue = MODEL_OPTIONS[modelIndex]?.value || "inherit";

      const filePath = await createSubagentFile(
        newName,
        newDescription,
        {
          tools: toolsValue === "all" ? undefined : toolsValue,
          model: modelValue === "inherit" ? undefined : modelValue,
        },
      );

      // Open in editor
      const editor = process.env.EDITOR || "vim";
      const child = spawn(editor, [filePath], {
        stdio: "inherit",
      });

      child.on("close", () => {
        // Reload after editing
        loadSubagents();
        resetCreateState();
        setMode("list");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      resetCreateState();
      setMode("list");
    }
  }

  async function handleDelete() {
    const selected = subagents[selectedIndex];
    if (!selected) return;

    try {
      await deleteSubagentFile(selected.name);
      await loadSubagents();
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setMode("list");
  }

  async function handleEdit() {
    const selected = subagents[selectedIndex];
    if (!selected) return;

    const filePath = getSubagentPath(selected.name);
    const editor = process.env.EDITOR || "vim";
    const child = spawn(editor, [filePath], {
      stdio: "inherit",
    });

    child.on("close", () => {
      loadSubagents();
    });
  }

  function resetCreateState() {
    setNewName("");
    setNewDescription("");
    setToolsIndex(0);
    setModelIndex(0);
  }

  useInput((input, key) => {
    if (mode === "list") {
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(subagents.length - 1, prev + 1));
      } else if (key.escape) {
        onClose();
      } else if (input === "c" || input === "C") {
        setMode("create-name");
      } else if (input === "e" || input === "E") {
        if (subagents[selectedIndex]) {
          handleEdit();
        }
      } else if (input === "d" || input === "D") {
        if (subagents[selectedIndex]) {
          setMode("confirm-delete");
        }
      }
    } else if (mode === "create-name") {
      if (key.escape) {
        resetCreateState();
        setMode("list");
      } else if (key.return) {
        if (newName.trim()) {
          setMode("create-description");
        }
      } else if (key.backspace || key.delete) {
        setNewName((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        // Only allow valid name characters
        if (/^[a-z0-9-]$/.test(input)) {
          setNewName((prev) => prev + input);
        }
      }
    } else if (mode === "create-description") {
      if (key.escape) {
        resetCreateState();
        setMode("list");
      } else if (key.return) {
        if (newDescription.trim()) {
          setMode("create-tools");
        }
      } else if (key.backspace || key.delete) {
        setNewDescription((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setNewDescription((prev) => prev + input);
      }
    } else if (mode === "create-tools") {
      if (key.escape) {
        resetCreateState();
        setMode("list");
      } else if (key.upArrow) {
        setToolsIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setToolsIndex((prev) => Math.min(TOOL_OPTIONS.length - 1, prev + 1));
      } else if (key.return) {
        setMode("create-model");
      }
    } else if (mode === "create-model") {
      if (key.escape) {
        resetCreateState();
        setMode("list");
      } else if (key.upArrow) {
        setModelIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setModelIndex((prev) => Math.min(MODEL_OPTIONS.length - 1, prev + 1));
      } else if (key.return) {
        handleCreate();
      }
    } else if (mode === "confirm-delete") {
      if (key.escape || input === "n" || input === "N") {
        setMode("list");
      } else if (input === "y" || input === "Y") {
        handleDelete();
      }
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading subagents...</Text>
      </Box>
    );
  }

  if (mode === "confirm-delete") {
    const selected = subagents[selectedIndex];
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text bold color={colors.status.error}>
          Delete Subagent
        </Text>
        <Text>
          Are you sure you want to delete "{selected?.name}"? (y/n)
        </Text>
      </Box>
    );
  }

  if (mode.startsWith("create-")) {
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Text bold color={colors.selector.title}>
          Create Subagent
        </Text>

        {mode === "create-name" && (
          <Box flexDirection="column" gap={1}>
            <Text>Name (lowercase, hyphens allowed):</Text>
            <Box>
              <Text color={colors.selector.itemHighlighted}>&gt; </Text>
              <Text>{newName}</Text>
              <Text color={colors.text.dim}>|</Text>
            </Box>
            <Text dimColor>Press Enter to continue, ESC to cancel</Text>
          </Box>
        )}

        {mode === "create-description" && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>Name: {newName}</Text>
            <Text>Description (when to use this subagent):</Text>
            <Box>
              <Text color={colors.selector.itemHighlighted}>&gt; </Text>
              <Text>{newDescription}</Text>
              <Text color={colors.text.dim}>|</Text>
            </Box>
            <Text dimColor>Press Enter to continue, ESC to cancel</Text>
          </Box>
        )}

        {mode === "create-tools" && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>Name: {newName}</Text>
            <Text dimColor>Description: {newDescription}</Text>
            <Text>Select tools:</Text>
            <Box flexDirection="column">
              {TOOL_OPTIONS.map((opt, idx) => (
                <Box key={opt.value}>
                  <Text color={idx === toolsIndex ? colors.selector.itemHighlighted : undefined}>
                    {idx === toolsIndex ? ">" : " "} {opt.label}
                  </Text>
                </Box>
              ))}
            </Box>
            <Text dimColor>Press Enter to continue, ESC to cancel</Text>
          </Box>
        )}

        {mode === "create-model" && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>Name: {newName}</Text>
            <Text dimColor>Description: {newDescription}</Text>
            <Text dimColor>Tools: {TOOL_OPTIONS[toolsIndex]?.label}</Text>
            <Text>Select model:</Text>
            <Box flexDirection="column">
              {MODEL_OPTIONS.map((opt, idx) => (
                <Box key={opt.value}>
                  <Text color={idx === modelIndex ? colors.selector.itemHighlighted : undefined}>
                    {idx === modelIndex ? ">" : " "} {opt.label}
                  </Text>
                </Box>
              ))}
            </Box>
            <Text dimColor>Press Enter to create and open in editor, ESC to cancel</Text>
          </Box>
        )}
      </Box>
    );
  }

  // List mode
  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text bold color={colors.selector.title}>
        Subagent Manager (ESC to close)
      </Text>

      {error && (
        <Text color={colors.status.error}>Error: {error}</Text>
      )}

      <Box flexDirection="column">
        {subagents.length === 0 ? (
          <Text dimColor>No subagents found. Press C to create one.</Text>
        ) : (
          subagents.map((item, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <Box key={item.name} gap={1}>
                <Text color={isSelected ? colors.selector.itemHighlighted : undefined}>
                  {isSelected ? ">" : " "}
                </Text>
                <Text
                  bold={isSelected}
                  color={isSelected ? colors.selector.itemHighlighted : undefined}
                >
                  {item.name}
                </Text>
                <Text dimColor>- {item.config.description.slice(0, 50)}</Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box gap={2}>
        <Text dimColor>[C]reate</Text>
        <Text dimColor>[E]dit</Text>
        <Text dimColor>[D]elete</Text>
      </Box>
    </Box>
  );
}
