import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "../../version";
import { commands } from "../commands/registry";
import { colors } from "./colors";

const PAGE_SIZE = 10;

type HelpTab = "commands" | "shortcuts";
const HELP_TABS: HelpTab[] = ["commands", "shortcuts"];

interface CommandItem {
  name: string;
  description: string;
  order: number;
}

interface ShortcutItem {
  keys: string;
  description: string;
}

interface HelpDialogProps {
  onClose: () => void;
}

export function HelpDialog({ onClose }: HelpDialogProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>("commands");
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customCommands, setCustomCommands] = useState<CommandItem[]>([]);

  // Load custom commands once on mount
  useEffect(() => {
    import("../commands/custom.js").then(({ getCustomCommands }) => {
      getCustomCommands().then((customs) => {
        setCustomCommands(
          customs.map((cmd) => ({
            name: `/${cmd.id}`,
            description: `${cmd.description} (${cmd.source}${cmd.namespace ? `:${cmd.namespace}` : ""})`,
            order: 200 + (cmd.source === "project" ? 0 : 100),
          })),
        );
      });
    });
  }, []);

  // Get all non-hidden commands, sorted by order (includes custom commands)
  const allCommands = useMemo<CommandItem[]>(() => {
    const builtins = Object.entries(commands)
      .filter(([_, cmd]) => !cmd.hidden)
      .map(([name, cmd]) => ({
        name,
        description: cmd.desc,
        order: cmd.order ?? 100,
      }));
    return [...builtins, ...customCommands].sort((a, b) => a.order - b.order);
  }, [customCommands]);

  // Keyboard shortcuts
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    return [
      { keys: "/", description: "Open command autocomplete" },
      { keys: "@", description: "Open file autocomplete" },
      {
        keys: "Esc",
        description: "Cancel dialog / clear input (double press)",
      },
      { keys: "Tab", description: "Autocomplete command or file path" },
      { keys: "↓", description: "Navigate down / next command in history" },
      { keys: "↑", description: "Navigate up / previous command in history" },
      {
        keys: "Ctrl+C",
        description: "Interrupt operation / exit (double press)",
      },
      { keys: "Ctrl+V", description: "Paste content or image" },
    ];
  }, []);

  const cycleTab = useCallback(() => {
    setActiveTab((current) => {
      const idx = HELP_TABS.indexOf(current);
      return HELP_TABS[(idx + 1) % HELP_TABS.length] as HelpTab;
    });
    setCurrentPage(0);
    setSelectedIndex(0);
  }, []);

  const visibleItems = activeTab === "commands" ? allCommands : shortcuts;

  const totalPages = Math.ceil(visibleItems.length / PAGE_SIZE);
  const startIndex = currentPage * PAGE_SIZE;
  const visiblePageItems = visibleItems.slice(
    startIndex,
    startIndex + PAGE_SIZE,
  );

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) {
          onClose();
        } else if (key.tab) {
          cycleTab();
        } else if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
        } else if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(visiblePageItems.length - 1, prev + 1),
          );
        } else if (input === "j" || input === "J") {
          // Previous page
          if (currentPage > 0) {
            setCurrentPage((prev) => prev - 1);
            setSelectedIndex(0);
          }
        } else if (input === "k" || input === "K") {
          // Next page
          if (currentPage < totalPages - 1) {
            setCurrentPage((prev) => prev + 1);
            setSelectedIndex(0);
          }
        } else if (key.leftArrow && currentPage > 0) {
          setCurrentPage((prev) => prev - 1);
          setSelectedIndex(0);
        } else if (key.rightArrow && currentPage < totalPages - 1) {
          setCurrentPage((prev) => prev + 1);
          setSelectedIndex(0);
        }
      },
      [currentPage, totalPages, visiblePageItems.length, onClose, cycleTab],
    ),
    { isActive: true },
  );

  const version = getVersion();

  const getTabLabel = (tab: HelpTab) => {
    if (tab === "commands") return `Commands (${allCommands.length})`;
    return `Shortcuts (${shortcuts.length})`;
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          Letta Code v{version} (↑↓ navigate, ←→/jk page, ESC close)
        </Text>
        <Box>
          <Text dimColor>Tab: </Text>
          {HELP_TABS.map((tab, i) => (
            <Text key={tab}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text
                bold={tab === activeTab}
                color={
                  tab === activeTab
                    ? colors.selector.itemHighlighted
                    : undefined
                }
              >
                {getTabLabel(tab)}
              </Text>
            </Text>
          ))}
          <Text dimColor> (Tab to switch)</Text>
        </Box>
        <Text dimColor>
          Page {currentPage + 1}/{totalPages}
        </Text>
      </Box>

      <Box flexDirection="column">
        {activeTab === "commands" &&
          (visiblePageItems as CommandItem[]).map((command, index) => {
            const isSelected = index === selectedIndex;

            return (
              <Box key={command.name} flexDirection="row" gap={1}>
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "›" : " "}
                </Text>
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {command.name}
                    </Text>
                    <Text dimColor> {command.description}</Text>
                  </Box>
                </Box>
              </Box>
            );
          })}

        {activeTab === "shortcuts" &&
          (visiblePageItems as ShortcutItem[]).map((shortcut, index) => {
            const isSelected = index === selectedIndex;

            return (
              <Box key={shortcut.keys} flexDirection="row" gap={1}>
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {isSelected ? "›" : " "}
                </Text>
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {shortcut.keys}
                    </Text>
                    <Text dimColor> {shortcut.description}</Text>
                  </Box>
                </Box>
              </Box>
            );
          })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Getting started:</Text>
        <Text dimColor>
          • Run <Text bold>/init</Text> to initialize agent memory for this
          project
        </Text>
        <Text dimColor>
          • Press <Text bold>/</Text> at any time to see command autocomplete
        </Text>
        <Text dimColor>
          • Visit <Text bold>https://docs.letta.com/letta-code</Text> for more
          help
        </Text>
      </Box>
    </Box>
  );
}
