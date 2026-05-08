import { Box, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { commands } from "../commands/registry";
import { colors } from "./colors";
import { Text } from "./Text";

const VISIBLE_ITEMS = 8;
const CMD_COL_WIDTH = 18;

interface PaletteCommand {
  name: string;
  description: string;
  order: number;
}

interface CommandPaletteProps {
  onSelect: (command: string) => void;
  onClose: () => void;
}

/**
 * Score how well a command matches a query.
 * Returns a number where higher = better match. Returns -1 for no match.
 *
 * Scoring (in order of preference):
 *   - Exact match
 *   - Prefix match on the command name
 *   - Substring match on the command name
 *   - Subsequence (fuzzy) match on the command name
 *   - Substring match on the description
 */
function scoreMatch(query: string, name: string, description: string): number {
  if (!query) return 0;

  const q = query.toLowerCase();
  const n = name.toLowerCase().replace(/^\//, "");
  const d = description.toLowerCase();

  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  const nameIdx = n.indexOf(q);
  if (nameIdx !== -1) return 600 - nameIdx;

  // Subsequence match on name
  let qi = 0;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 400 - n.length;

  if (d.includes(q)) return 200;

  return -1;
}

export function CommandPalette({ onSelect, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customCommands, setCustomCommands] = useState<PaletteCommand[]>([]);

  // Load custom (user-defined) commands so the palette is comprehensive
  useEffect(() => {
    let cancelled = false;
    import("../commands/custom.js").then(({ getCustomCommands }) => {
      getCustomCommands().then((customs) => {
        if (cancelled) return;
        setCustomCommands(
          customs.map((cmd) => ({
            name: `/${cmd.id}`,
            description: `${cmd.description} (${cmd.source}${
              cmd.namespace ? `:${cmd.namespace}` : ""
            })`,
            order: 200 + (cmd.source === "project" ? 0 : 100),
          })),
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const allCommands = useMemo<PaletteCommand[]>(() => {
    const builtins = Object.entries(commands)
      .filter(([_, cmd]) => !cmd.hidden)
      .map(([name, cmd]) => ({
        name,
        description: cmd.desc,
        order: cmd.order ?? 100,
      }));
    return [...builtins, ...customCommands].sort((a, b) => a.order - b.order);
  }, [customCommands]);

  const matches = useMemo<PaletteCommand[]>(() => {
    if (!query) return allCommands;
    const scored = allCommands
      .map((cmd) => ({
        cmd,
        score: scoreMatch(query, cmd.name, cmd.description),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.cmd);
  }, [query, allCommands]);

  // Clamp selection whenever the filtered list changes
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (matches.length === 0) return 0;
      return Math.min(prev, matches.length - 1);
    });
  }, [matches.length]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    if (key.return) {
      const selected = matches[selectedIndex];
      if (selected) {
        onSelect(selected.name);
      }
      return;
    }

    if (key.upArrow || (key.ctrl && input === "p")) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow || (key.ctrl && input === "n")) {
      setSelectedIndex((prev) => Math.min(matches.length - 1, prev + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((prev) => prev.slice(0, -1));
      return;
    }

    // Plain printable character - append to query.
    // Ignore control characters and meta keys.
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      input.length === 1 &&
      input.charCodeAt(0) >= 32
    ) {
      setQuery((prev) => prev + input);
    }
  });

  // Compute the visible window so the selected item stays in view
  const total = matches.length;
  let startIndex = 0;
  if (total > VISIBLE_ITEMS) {
    const half = Math.floor(VISIBLE_ITEMS / 2);
    startIndex = Math.max(0, selectedIndex - half);
    startIndex = Math.min(startIndex, total - VISIBLE_ITEMS);
  }
  const visible = matches.slice(startIndex, startIndex + VISIBLE_ITEMS);
  const hiddenAbove = startIndex;
  const hiddenBelow = Math.max(0, total - startIndex - VISIBLE_ITEMS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.selector.border}
      paddingX={1}
    >
      <Box>
        <Text bold color={colors.selector.title}>
          Command Palette
        </Text>
        <Text dimColor> (↑↓ navigate · Enter select · Esc close)</Text>
      </Box>

      <Box>
        <Text color={colors.selector.itemHighlighted}>{"› "}</Text>
        <Text>{query}</Text>
        <Text dimColor>{query ? "" : "Type to filter commands..."}</Text>
        <Text color={colors.selector.itemHighlighted}>█</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {hiddenAbove > 0 && (
          <Text dimColor>
            {"  "}↑ {hiddenAbove} more above
          </Text>
        )}

        {total === 0 && <Text dimColor>{"  "}No matching commands</Text>}

        {visible.map((cmd, idx) => {
          const actualIndex = startIndex + idx;
          const isSelected = actualIndex === selectedIndex;
          const padded = cmd.name.padEnd(CMD_COL_WIDTH).slice(0, CMD_COL_WIDTH);
          return (
            <Box key={cmd.name} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "› " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {padded}
              </Text>
              <Text dimColor={!isSelected}> {cmd.description}</Text>
            </Box>
          );
        })}

        {hiddenBelow > 0 && (
          <Text dimColor>
            {"  "}↓ {hiddenBelow} more below
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {total} command{total === 1 ? "" : "s"}
          {query ? ` matching "${query}"` : ""}
        </Text>
      </Box>
    </Box>
  );
}
