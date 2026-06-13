import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { commands } from "@/cli/commands/registry";
import { INPUT_NEWLINE_MODIFIER_LABEL } from "@/constants";
import { getVersion } from "@/version";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

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
    import("@/cli/commands/custom.js").then(({ getCustomCommands }) => {
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
      { keys: "Shift+Enter", description: "Insert newline (multi-line input)" },
      {
        keys: INPUT_NEWLINE_MODIFIER_LABEL,
        description: "Insert newline (alternative)",
      },
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
        // CTRL-C: immediately close
        if (key.ctrl && input === "c") {
          onClose();
          return;
        }

        if (key.escape) {
          onClose();
        } else if (key.tab) {
          cycleTab();
        } else if (key.upArrow) {
          setSelectedIndex((prev) => {
            if (prev > 0) return prev - 1;
            if (currentPage > 0) {
              const previousPageStart = (currentPage - 1) * PAGE_SIZE;
              const previousPageLength = Math.min(
                PAGE_SIZE,
                visibleItems.length - previousPageStart,
              );
              setCurrentPage((page) => page - 1);
              return Math.max(0, previousPageLength - 1);
            }
            return prev;
          });
        } else if (key.downArrow) {
          setSelectedIndex((prev) => {
            if (prev < visiblePageItems.length - 1) return prev + 1;
            if (currentPage < totalPages - 1) {
              setCurrentPage((page) => page + 1);
              return 0;
            }
            return prev;
          });
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
      [
        currentPage,
        totalPages,
        visibleItems.length,
        visiblePageItems.length,
        onClose,
        cycleTab,
      ],
    ),
    { isActive: true },
  );

  const version = getVersion();

  const getTabLabel = (tab: HelpTab) => {
    if (tab === "commands") return `Commands (${allCommands.length})`;
    return `Shortcuts (${shortcuts.length})`;
  };

  return (
    <OverlayShell
      command="/help"
      title={`Letta Code v${version}`}
      footer={`↑↓ scroll · ←→ page · Tab switch · Esc cancel`}
    >
      <Box flexDirection="column" paddingLeft={1}>
        <TabBar tabs={HELP_TABS} activeTab={activeTab} getLabel={getTabLabel} />
        <Text dimColor>
          {" "}
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
                    <Box marginLeft={1}>
                      <Text dimColor>{command.description}</Text>
                    </Box>
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
                    <Box marginLeft={1}>
                      <Text dimColor>{shortcut.description}</Text>
                    </Box>
                  </Box>
                </Box>
              </Box>
            );
          })}
      </Box>
    </OverlayShell>
  );
}
