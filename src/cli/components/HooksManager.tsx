// src/cli/components/HooksManager.tsx
// Interactive TUI for managing hooks configuration

import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useCallback, useEffect, useState } from "react";
import {
  type HookEvent,
  type HookMatcher,
  isToolEvent,
  type SimpleHookEvent,
  type SimpleHookMatcher,
  type ToolHookEvent,
} from "../../hooks/types";
import {
  addHookMatcher,
  addSimpleHookMatcher,
  countHooksForEvent,
  countTotalHooks,
  type HookMatcherWithSource,
  type HookWithSource,
  loadMatchersWithSource,
  loadSimpleMatchersWithSource,
  removeHook,
  type SaveLocation,
} from "../../hooks/writer";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

// Box drawing characters
const BOX_TOP_LEFT = "╭";
const BOX_TOP_RIGHT = "╮";
const BOX_BOTTOM_LEFT = "╰";
const BOX_BOTTOM_RIGHT = "╯";
const BOX_HORIZONTAL = "─";
const BOX_VERTICAL = "│";

interface HooksManagerProps {
  onClose: () => void;
  agentId?: string;
}

type Screen =
  | "events"
  | "hooks-list" // Was "matchers" - now handles both matchers and commands
  | "add-matcher" // For tool events only
  | "add-command"
  | "save-location"
  | "delete-confirm";

// All hook events with descriptions
const HOOK_EVENTS: { event: HookEvent; description: string }[] = [
  { event: "PreToolUse", description: "Before tool execution" },
  { event: "PostToolUse", description: "After tool execution" },
  { event: "PermissionRequest", description: "When permission is requested" },
  { event: "UserPromptSubmit", description: "When user submits a prompt" },
  { event: "Notification", description: "When notifications are sent" },
  { event: "Stop", description: "When the agent finishes responding" },
  { event: "SubagentStop", description: "When a subagent completes" },
  { event: "PreCompact", description: "Before context compaction" },
  { event: "Setup", description: "When invoked with --init flags" },
  { event: "SessionStart", description: "When a session starts" },
  { event: "SessionEnd", description: "When a session ends" },
];

// Fallback tool names if agent tools can't be fetched
const FALLBACK_TOOL_NAMES = [
  "Task",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
  "BashOutput",
  "KillBash",
];

// Save location options
const SAVE_LOCATIONS: {
  location: SaveLocation;
  label: string;
  path: string;
}[] = [
  {
    location: "project-local",
    label: "Project settings (local)",
    path: ".letta/settings.local.json",
  },
  {
    location: "project",
    label: "Project settings",
    path: ".letta/settings.json",
  },
  { location: "user", label: "User settings", path: "~/.letta/settings.json" },
];

function getSourceLabel(source: SaveLocation): string {
  switch (source) {
    case "user":
      return "User";
    case "project":
      return "Project";
    case "project-local":
      return "Local";
  }
}

/**
 * Create a box border line
 */
function boxLine(content: string, width: number): string {
  const innerWidth = width - 2;
  const paddedContent = content.padEnd(innerWidth).slice(0, innerWidth);
  return `${BOX_VERTICAL}${paddedContent}${BOX_VERTICAL}`;
}

function boxTop(width: number): string {
  return `${BOX_TOP_LEFT}${BOX_HORIZONTAL.repeat(width - 2)}${BOX_TOP_RIGHT}`;
}

function boxBottom(width: number): string {
  return `${BOX_BOTTOM_LEFT}${BOX_HORIZONTAL.repeat(width - 2)}${BOX_BOTTOM_RIGHT}`;
}

export const HooksManager = memo(function HooksManager({
  onClose,
  agentId,
}: HooksManagerProps) {
  const terminalWidth = useTerminalWidth();
  const boxWidth = Math.min(terminalWidth - 4, 70);

  const [screen, setScreen] = useState<Screen>("events");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<HookEvent | null>(null);
  // For tool events: HookMatcherWithSource[], for simple events: HookCommandWithSource[]
  const [hooks, setHooks] = useState<HookWithSource[]>([]);
  const [totalHooks, setTotalHooks] = useState(0);

  // Dynamic tool names from agent
  const [toolNames, setToolNames] = useState<string[]>(FALLBACK_TOOL_NAMES);

  // Fetch agent tools on mount
  useEffect(() => {
    if (!agentId) return;

    const fetchAgentTools = async () => {
      try {
        const { getClient } = await import("../../agent/client");
        const client = await getClient();
        // Use dedicated tools endpoint instead of fetching whole agent
        // Pass limit to avoid pagination issues
        const toolsPage = await client.agents.tools.list(agentId, {
          limit: 50,
        });
        const names = toolsPage.items
          ?.map((t) => t.name)
          .filter((n): n is string => !!n);
        if (names && names.length > 0) {
          // Sort alphabetically for easier scanning
          setToolNames(names.sort());
        }
      } catch {
        // Keep fallback tool names on error
      }
    };

    fetchAgentTools();
  }, [agentId]);

  // New hook state
  const [newMatcher, setNewMatcher] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [selectedLocation, setSelectedLocation] = useState(0);

  // Delete confirmation
  const [deleteHookIndex, setDeleteHookIndex] = useState(-1);
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(1); // Default to No

  // Helper to check if current event is a tool event
  const isCurrentToolEvent = selectedEvent ? isToolEvent(selectedEvent) : false;

  // Refresh counts - called when hooks change
  const refreshCounts = useCallback(() => {
    setTotalHooks(countTotalHooks());
  }, []);

  // Load total hooks count on mount and when returning to events screen
  useEffect(() => {
    if (screen === "events") {
      refreshCounts();
    }
  }, [screen, refreshCounts]);

  // Load hooks when event is selected (matchers for both tool and simple events)
  const loadHooks = useCallback((event: HookEvent) => {
    if (isToolEvent(event)) {
      setHooks(loadMatchersWithSource(event as ToolHookEvent));
    } else {
      setHooks(loadSimpleMatchersWithSource(event as SimpleHookEvent));
    }
  }, []);

  // Handle adding a hook
  const handleAddHook = useCallback(async () => {
    if (!selectedEvent || !newCommand.trim()) return;

    const location = SAVE_LOCATIONS[selectedLocation]?.location;
    if (!location) return;

    if (isToolEvent(selectedEvent)) {
      // Tool events use HookMatcher with matcher pattern
      const matcher: HookMatcher = {
        matcher: newMatcher.trim() || "*",
        hooks: [{ type: "command", command: newCommand.trim() }],
      };
      await addHookMatcher(selectedEvent as ToolHookEvent, matcher, location);
    } else {
      // Simple events use SimpleHookMatcher (same structure, just no matcher field)
      const matcher: SimpleHookMatcher = {
        hooks: [{ type: "command", command: newCommand.trim() }],
      };
      await addSimpleHookMatcher(
        selectedEvent as SimpleHookEvent,
        matcher,
        location,
      );
    }

    loadHooks(selectedEvent);
    refreshCounts();

    // Reset and go back to hooks list
    setNewMatcher("");
    setNewCommand("");
    setSelectedLocation(0);
    setScreen("hooks-list");
    setSelectedIndex(0);
  }, [
    selectedEvent,
    newMatcher,
    newCommand,
    selectedLocation,
    loadHooks,
    refreshCounts,
  ]);

  // Handle deleting a hook
  const handleDeleteHook = useCallback(async () => {
    if (deleteHookIndex < 0 || !selectedEvent) return;

    const hook = hooks[deleteHookIndex];
    if (!hook) return;

    await removeHook(selectedEvent, hook.sourceIndex, hook.source);
    loadHooks(selectedEvent);
    refreshCounts();

    // Reset and go back to hooks list
    setDeleteHookIndex(-1);
    setScreen("hooks-list");
    setSelectedIndex(0);
  }, [deleteHookIndex, selectedEvent, hooks, loadHooks, refreshCounts]);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    // Handle each screen
    if (screen === "events") {
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(HOOK_EVENTS.length - 1, prev + 1));
      } else if (key.return) {
        const selected = HOOK_EVENTS[selectedIndex];
        if (selected) {
          setSelectedEvent(selected.event);
          loadHooks(selected.event);
          setScreen("hooks-list");
          setSelectedIndex(0);
        }
      } else if (key.escape) {
        onClose();
      }
    } else if (screen === "hooks-list") {
      // Items: [+ Add new hook] + existing hooks
      const itemCount = hooks.length + 1;

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(itemCount - 1, prev + 1));
      } else if (key.return) {
        if (selectedIndex === 0) {
          // Add new hook - for tool events, go to matcher screen; for simple, go to command
          if (isCurrentToolEvent) {
            setScreen("add-matcher");
            setNewMatcher("");
          } else {
            setScreen("add-command");
            setNewCommand("");
          }
        } else {
          // Delete selected hook
          setDeleteHookIndex(selectedIndex - 1);
          setDeleteConfirmIndex(1); // Default to No
          setScreen("delete-confirm");
        }
      } else if (key.escape) {
        setScreen("events");
        setSelectedIndex(0);
        setSelectedEvent(null);
      }
    } else if (screen === "add-matcher") {
      // Text input handles most keys (tool events only)
      if (key.return && !key.shift) {
        setScreen("add-command");
        setNewCommand("");
      } else if (key.escape) {
        setScreen("hooks-list");
        setSelectedIndex(0);
        setNewMatcher("");
      }
    } else if (screen === "add-command") {
      if (key.return && !key.shift) {
        setScreen("save-location");
        setSelectedLocation(0);
      } else if (key.escape) {
        // Go back to matcher screen for tool events, or hooks list for simple
        if (isCurrentToolEvent) {
          setScreen("add-matcher");
        } else {
          setScreen("hooks-list");
          setSelectedIndex(0);
        }
      }
    } else if (screen === "save-location") {
      if (key.upArrow) {
        setSelectedLocation((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedLocation((prev) =>
          Math.min(SAVE_LOCATIONS.length - 1, prev + 1),
        );
      } else if (key.return) {
        handleAddHook();
      } else if (key.escape) {
        setScreen("add-command");
      }
    } else if (screen === "delete-confirm") {
      if (key.upArrow || key.downArrow) {
        setDeleteConfirmIndex((prev) => (prev === 0 ? 1 : 0));
      } else if (key.return) {
        if (deleteConfirmIndex === 0) {
          handleDeleteHook();
        } else {
          setScreen("hooks-list");
        }
      } else if (key.escape) {
        setScreen("hooks-list");
      }
    }
  });

  // Render Events List
  if (screen === "events") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{boxTop(boxWidth)}</Text>
        <Text>
          {boxLine(
            ` Hooks${" ".repeat(boxWidth - 20)}${totalHooks} hooks `,
            boxWidth,
          )}
        </Text>
        <Text>{boxBottom(boxWidth)}</Text>
        <Text> </Text>

        {HOOK_EVENTS.map((item, index) => {
          const isSelected = index === selectedIndex;
          const hookCount = countHooksForEvent(item.event);
          const prefix = isSelected ? "❯" : " ";
          const countStr = hookCount > 0 ? ` (${hookCount})` : "";

          return (
            <Text key={item.event}>
              <Text color={isSelected ? colors.input.prompt : undefined}>
                {prefix} {index + 1}. {item.event}
              </Text>
              <Text dimColor> - {item.description}</Text>
              <Text color="yellow">{countStr}</Text>
            </Text>
          );
        })}

        <Text> </Text>
        <Text dimColor>Enter to select · esc to cancel</Text>
      </Box>
    );
  }

  // Render Hooks List (matchers for tool events, commands for simple events)
  if (screen === "hooks-list" && selectedEvent) {
    const title = isCurrentToolEvent
      ? ` ${selectedEvent} - Tool Matchers `
      : ` ${selectedEvent} - Hooks `;
    const addLabel = isCurrentToolEvent
      ? "+ Add new matcher..."
      : "+ Add new hook...";

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{boxTop(boxWidth)}</Text>
        <Text>{boxLine(title, boxWidth)}</Text>
        <Text>{boxBottom(boxWidth)}</Text>

        {isCurrentToolEvent ? (
          <>
            <Text dimColor>
              Input to command is JSON of tool call arguments.
            </Text>
            <Text dimColor>Exit code 0 - stdout/stderr not shown</Text>
            <Text dimColor>
              Exit code 2 - show stderr to model and block tool call
            </Text>
            <Text dimColor>
              Other exit codes - show stderr to user only but continue
            </Text>
          </>
        ) : (
          <>
            <Text dimColor>Exit code 0 - success, continue</Text>
            <Text dimColor>Exit code 2 - show stderr to model and block</Text>
            <Text dimColor>Other exit codes - show stderr to user only</Text>
          </>
        )}
        <Text> </Text>

        {/* Add new hook option */}
        <Text>
          <Text color={selectedIndex === 0 ? colors.input.prompt : undefined}>
            {selectedIndex === 0 ? "❯" : " "} 1.{" "}
          </Text>
          <Text color="green">{addLabel}</Text>
        </Text>

        {/* Existing hooks */}
        {hooks.map((hook, index) => {
          const isSelected = index + 1 === selectedIndex;
          const prefix = isSelected ? "❯" : " ";
          const sourceLabel = `[${getSourceLabel(hook.source)}]`;

          // Handle both tool matchers (with matcher field) and simple matchers (without)
          const isToolMatcher = "matcher" in hook;
          const matcherPattern = isToolMatcher
            ? (hook as HookMatcherWithSource).matcher || "*"
            : null;
          // Both types have hooks array
          const command = "hooks" in hook ? hook.hooks[0]?.command || "" : "";
          const truncatedCommand =
            command.length > 50 ? `${command.slice(0, 47)}...` : command;

          return (
            <Text key={`${hook.source}-${index}`}>
              <Text color={isSelected ? colors.input.prompt : undefined}>
                {prefix} {index + 2}.{" "}
              </Text>
              <Text color="cyan">{sourceLabel}</Text>
              {matcherPattern !== null ? (
                <Text> {matcherPattern.padEnd(12)} </Text>
              ) : (
                <Text> </Text>
              )}
              <Text dimColor>{truncatedCommand}</Text>
            </Text>
          );
        })}

        <Text> </Text>
        <Text dimColor>Enter to select · esc to go back</Text>
      </Box>
    );
  }

  // Render Add Matcher - Tool Pattern Input
  if (screen === "add-matcher" && selectedEvent) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{boxTop(boxWidth)}</Text>
        <Text>
          {boxLine(` Add new matcher for ${selectedEvent} `, boxWidth)}
        </Text>
        <Text>{boxBottom(boxWidth)}</Text>

        <Text dimColor>Input to command is JSON of tool call arguments.</Text>
        <Text dimColor>Exit code 0 - stdout/stderr not shown</Text>
        <Text dimColor>
          Exit code 2 - show stderr to model and block tool call
        </Text>
        <Text> </Text>

        <Text dimColor>Possible matcher values for field tool_name:</Text>
        <Text dimColor>{toolNames.join(", ")}</Text>
        <Text> </Text>

        <Text>Tool matcher:</Text>
        <Text>{boxTop(boxWidth - 2)}</Text>
        <Box>
          <Text>{BOX_VERTICAL} </Text>
          <TextInput
            value={newMatcher}
            onChange={setNewMatcher}
            placeholder="* (matches all tools)"
          />
        </Box>
        <Text>{boxBottom(boxWidth - 2)}</Text>
        <Text> </Text>

        <Text dimColor>Example Matchers:</Text>
        <Text dimColor>• Write (single tool)</Text>
        <Text dimColor>• Write|Edit (multiple tools)</Text>
        <Text dimColor>• * (all tools)</Text>
        <Text> </Text>
        <Text dimColor>Enter to continue · esc to cancel</Text>
      </Box>
    );
  }

  // Render Add Command Input
  if (screen === "add-command" && selectedEvent) {
    const title = isCurrentToolEvent
      ? ` Add new matcher for ${selectedEvent} `
      : ` Add new hook for ${selectedEvent} `;

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{boxTop(boxWidth)}</Text>
        <Text>{boxLine(title, boxWidth)}</Text>
        <Text>{boxBottom(boxWidth)}</Text>

        {isCurrentToolEvent && <Text>Matcher: {newMatcher || "*"}</Text>}
        {isCurrentToolEvent && <Text> </Text>}

        <Text>Command:</Text>
        <Text>{boxTop(boxWidth - 2)}</Text>
        <Box>
          <Text>{BOX_VERTICAL} </Text>
          <TextInput
            value={newCommand}
            onChange={setNewCommand}
            placeholder="/path/to/script.sh"
          />
        </Box>
        <Text>{boxBottom(boxWidth - 2)}</Text>

        <Text> </Text>
        <Text dimColor>Enter to continue · esc to go back</Text>
      </Box>
    );
  }

  // Render Save Location Picker
  if (screen === "save-location" && selectedEvent) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{boxTop(boxWidth)}</Text>
        <Text>{boxLine(" Save hook configuration ", boxWidth)}</Text>
        <Text>{boxBottom(boxWidth)}</Text>
        <Text> </Text>

        <Text>Event: {selectedEvent}</Text>
        {isCurrentToolEvent && <Text>Matcher: {newMatcher || "*"}</Text>}
        <Text>Command: {newCommand}</Text>
        <Text> </Text>

        <Text>Where should this hook be saved?</Text>
        <Text> </Text>

        {SAVE_LOCATIONS.map((loc, index) => {
          const isSelected = index === selectedLocation;
          const prefix = isSelected ? "❯" : " ";

          return (
            <Text key={loc.location}>
              <Text color={isSelected ? colors.input.prompt : undefined}>
                {prefix} {index + 1}. {loc.label}
              </Text>
              <Text dimColor> {loc.path}</Text>
            </Text>
          );
        })}

        <Text> </Text>
        <Text dimColor>Enter to confirm · esc to go back</Text>
      </Box>
    );
  }

  // Render Delete Confirmation
  if (screen === "delete-confirm" && deleteHookIndex >= 0) {
    const hook = hooks[deleteHookIndex];
    const isToolMatcher = hook && "matcher" in hook;
    const matcherPattern = isToolMatcher
      ? (hook as HookMatcherWithSource).matcher || "*"
      : null;
    // Both types have hooks array
    const command = hook && "hooks" in hook ? hook.hooks[0]?.command : "";

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>{boxTop(boxWidth)}</Text>
        <Text>{boxLine(" Delete hook? ", boxWidth)}</Text>
        <Text>{boxBottom(boxWidth)}</Text>
        <Text> </Text>

        {matcherPattern !== null && <Text>Matcher: {matcherPattern}</Text>}
        <Text>Command: {command}</Text>
        <Text>Source: {hook ? getSourceLabel(hook.source) : ""}</Text>
        <Text> </Text>

        <Text>
          <Text
            color={deleteConfirmIndex === 0 ? colors.input.prompt : undefined}
          >
            {deleteConfirmIndex === 0 ? "❯" : " "} Yes, delete
          </Text>
        </Text>
        <Text>
          <Text
            color={deleteConfirmIndex === 1 ? colors.input.prompt : undefined}
          >
            {deleteConfirmIndex === 1 ? "❯" : " "} No, cancel
          </Text>
        </Text>

        <Text> </Text>
        <Text dimColor>Enter to confirm · esc to cancel</Text>
      </Box>
    );
  }

  return null;
});
