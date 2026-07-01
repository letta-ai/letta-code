import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { commands } from "@/cli/commands/registry";
import { truncateText } from "@/cli/helpers/truncate-text";
import { useAutocompleteNavigation } from "@/cli/hooks/use-autocomplete-navigation";
import {
  useTerminalRows,
  useTerminalWidth,
} from "@/cli/hooks/use-terminal-width";
import { settingsManager } from "@/settings-manager";
import { AutocompleteBox, AutocompleteItem } from "./Autocomplete";
import { Text } from "./Text";
import type { AutocompleteProps, CommandMatch } from "./types/autocomplete";

// Match Codex's slash-command popup behavior: a small hard cap that can shrink
// on short terminals, but never expands just because the terminal is tall.
const MAX_POPUP_ROWS = 8;
const CMD_COL_WIDTH = 14;

const BUILTIN_SKILL_ALIASES = new Set([
  "acquiring-skills",
  "context-doctor",
  "converting-mcps-to-skills",
  "creating-skills",
  "customizing-statusline",
  "initializing-memory",
  "migrating-memory",
  "syncing-memory-filesystem",
]);

// Compute filtered command list (excluding hidden commands), sorted by order
const _allCommands: CommandMatch[] = Object.entries(commands)
  .filter(([, { hidden }]) => !hidden)
  .map(([cmd, { desc, order }]) => ({
    cmd,
    desc,
    order: order ?? 100, // Default order for commands without explicit order
  }))
  .sort((a, b) => a.order - b.order);

// Extract the text after the "/" symbol where the cursor is positioned
function extractSearchQuery(
  input: string,
  cursor: number,
): { query: string; hasSpaceAfter: boolean } | null {
  if (!input.startsWith("/")) return null;

  const afterSlash = input.slice(1);
  const spaceIndex = afterSlash.indexOf(" ");
  const endPos = spaceIndex === -1 ? input.length : 1 + spaceIndex;

  // Check if cursor is within this /command
  if (cursor < 0 || cursor > endPos) {
    return null;
  }

  const query =
    spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);
  const hasSpaceAfter = spaceIndex !== -1;

  return { query, hasSpaceAfter };
}

export function SlashCommandAutocomplete({
  currentInput,
  cursorPosition = currentInput.length,
  onSelect,
  onAutocomplete,
  onActiveChange,
  agentId,
  workingDirectory: _workingDirectory = process.cwd(),
  modCommands = {},
}: AutocompleteProps) {
  const columns = useTerminalWidth();
  const terminalRows = useTerminalRows();
  const [customCommands, setCustomCommands] = useState<CommandMatch[]>([]);
  const [skillCommands, setSkillCommands] = useState<CommandMatch[]>([]);

  // Load custom commands once on mount
  useEffect(() => {
    import("@/cli/commands/custom.js").then(({ getCustomCommands }) => {
      getCustomCommands().then((customs) => {
        const matches: CommandMatch[] = customs.map((cmd) => ({
          cmd: `/${cmd.id}`,
          // Include source/namespace in description for disambiguation
          desc: `${cmd.description} (${cmd.source}${cmd.namespace ? `:${cmd.namespace}` : ""})`,
          order: 200 + (cmd.source === "project" ? 0 : 100),
        }));
        setCustomCommands(matches);
      });
    });
  }, []);

  // Load user-invocable skills for slash-command autocomplete.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { discoverClientSideSkills } = await import(
          "@/agent/client-skills"
        );
        const { getSkillSources } = await import("@/agent/context");
        const { isUserInvocableSkill } = await import("@/agent/skills");
        const discovery = await discoverClientSideSkills({
          agentId,
          skillSources: getSkillSources(),
        });
        if (cancelled) return;
        const matches: CommandMatch[] = discovery.skills
          .filter(
            (skill) =>
              isUserInvocableSkill(skill) &&
              !(
                skill.source === "bundled" &&
                BUILTIN_SKILL_ALIASES.has(skill.id)
              ),
          )
          .map((skill) => ({
            cmd: `/${skill.id}`,
            desc: `${skill.description}${skill.argumentHint ? ` ${skill.argumentHint}` : ""} (${skill.source} skill)`,
            order: 300,
          }));
        setSkillCommands(matches);
      } catch {
        if (!cancelled) {
          setSkillCommands([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Check pin status to conditionally show/hide pin/unpin commands
  const allCommands = useMemo(() => {
    let builtins = _allCommands;

    if (agentId) {
      try {
        const isPinned = settingsManager.isAgentPinned(agentId);

        builtins = _allCommands.filter((cmd) => {
          // Hide /pin if agent is already pinned
          if (cmd.cmd === "/pin" && isPinned) {
            return false;
          }
          // Hide /unpin if agent is not pinned
          if (cmd.cmd === "/unpin" && !isPinned) {
            return false;
          }
          return true;
        });
      } catch (_error) {
        // If settings aren't loaded, just use all builtins
        builtins = _allCommands;
      }
    }

    const modCommandMatches: CommandMatch[] = Object.values(modCommands).map(
      (command) => ({
        cmd: `/${command.id}`,
        desc: `${command.description}${command.args ? ` ${command.args}` : ""} (mod)`,
        order: command.order,
      }),
    );

    const customCommandNames = new Set(customCommands.map((cmd) => cmd.cmd));
    const modCommandNames = new Set(modCommandMatches.map((cmd) => cmd.cmd));
    const visibleBuiltins = builtins.filter(
      (cmd) =>
        !customCommandNames.has(cmd.cmd) && !modCommandNames.has(cmd.cmd),
    );
    const visibleModCommands = modCommandMatches.filter(
      (cmd) => !customCommandNames.has(cmd.cmd),
    );

    const reservedCommands = new Set([
      ...visibleBuiltins.map((cmd) => cmd.cmd),
      ...visibleModCommands.map((cmd) => cmd.cmd),
      ...customCommands.map((cmd) => cmd.cmd),
    ]);
    const visibleSkillCommands = skillCommands.filter(
      (cmd) => !reservedCommands.has(cmd.cmd),
    );

    // Merge command sources and sort by order.
    return [
      ...visibleBuiltins,
      ...visibleModCommands,
      ...customCommands,
      ...visibleSkillCommands,
    ].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }, [agentId, modCommands, customCommands, skillCommands]);

  const queryInfo = useMemo(
    () => extractSearchQuery(currentInput, cursorPosition),
    [currentInput, cursorPosition],
  );

  const { matches, showNoMatches, hideAutocomplete } = useMemo(() => {
    if (!queryInfo) {
      return {
        matches: [] as CommandMatch[],
        showNoMatches: false,
        hideAutocomplete: true,
      };
    }

    const { query, hasSpaceAfter } = queryInfo;
    if (hasSpaceAfter) {
      return {
        matches: [] as CommandMatch[],
        showNoMatches: false,
        hideAutocomplete: true,
      };
    }

    if (query.length === 0) {
      return {
        matches: allCommands,
        showNoMatches: false,
        hideAutocomplete: allCommands.length === 0,
      };
    }

    const lowerQuery = query.toLowerCase();
    const filtered = allCommands.filter((item) => {
      const cmdName = item.cmd.slice(1).toLowerCase(); // Remove leading "/"
      return cmdName.includes(lowerQuery);
    });

    return {
      matches: filtered,
      showNoMatches: filtered.length === 0,
      hideAutocomplete: false,
    };
  }, [queryInfo, allCommands]);

  const { selectedIndex } = useAutocompleteNavigation({
    matches,
    onSelect: onSelect ? (item) => onSelect(item.cmd) : undefined,
    onAutocomplete: onAutocomplete
      ? (item) => onAutocomplete(item.cmd)
      : undefined,
    // Disable automatic active state management - we handle it manually below
    manageActiveState: false,
  });

  // Manually manage active state - only active when there are matches to select
  // When there are no matches, we don't block submit so the user can still
  // run commands that aren't in the autocomplete registry (e.g., /help, /reflection)
  useLayoutEffect(() => {
    const isActive = !hideAutocomplete && matches.length > 0;
    onActiveChange?.(isActive);
  }, [hideAutocomplete, matches.length, onActiveChange]);

  // Don't show if input doesn't start with "/"
  if (!currentInput.startsWith("/")) {
    return null;
  }

  // Show "no matching commands" message when query has content but no results
  if (showNoMatches) {
    return (
      <AutocompleteBox>
        <Text dimColor>{"  "}No matching commands</Text>
      </AutocompleteBox>
    );
  }

  // Don't show if no matches and query is empty (shouldn't happen, but safety check)
  if (hideAutocomplete || matches.length === 0) {
    return null;
  }

  // Calculate visible window based on selected index, bounded by viewport.
  const availablePopupRows = Math.max(1, terminalRows - 8);
  const visibleCommandCount = Math.min(MAX_POPUP_ROWS, availablePopupRows);
  const totalMatches = matches.length;
  const needsScrolling = totalMatches > visibleCommandCount;

  let startIndex = 0;
  if (needsScrolling) {
    // Keep selected item visible, preferring to show it in the middle
    const halfWindow = Math.floor(visibleCommandCount / 2);
    startIndex = Math.max(0, selectedIndex - halfWindow);
    startIndex = Math.min(startIndex, totalMatches - visibleCommandCount);
  }

  const visibleMatches = matches.slice(
    startIndex,
    startIndex + visibleCommandCount,
  );
  const showScrollDown = startIndex + visibleCommandCount < totalMatches;

  return (
    <AutocompleteBox>
      {visibleMatches.map((item, idx) => {
        const actualIndex = startIndex + idx;

        // Keep the footer height stable while navigating by forcing a single-line
        // representation for each row.
        const displayCmd = truncateText(item.cmd, CMD_COL_WIDTH).padEnd(
          CMD_COL_WIDTH,
        );
        // 2-char gutter comes from <AutocompleteItem />.
        const maxDescWidth = Math.max(0, columns - 2 - CMD_COL_WIDTH - 1);
        const displayDesc = truncateText(item.desc, maxDescWidth);

        return (
          <AutocompleteItem
            key={item.cmd}
            selected={actualIndex === selectedIndex}
          >
            {displayCmd}{" "}
            <Text dimColor={actualIndex !== selectedIndex}>{displayDesc}</Text>
          </AutocompleteItem>
        );
      })}
      {showScrollDown ? (
        <Text dimColor>
          {"  "}↓ {totalMatches - startIndex - visibleCommandCount} more below
        </Text>
      ) : needsScrolling ? (
        <Text> </Text>
      ) : null}
    </AutocompleteBox>
  );
}
