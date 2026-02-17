import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Skill, SkillSource } from "../../agent/skills";
import { charsToTokens } from "../helpers/format";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

const SOLID_LINE = "─";
const VISIBLE_ITEMS = 5;

type SkillTab = SkillSource;

const TAB_ORDER: SkillTab[] = ["project", "agent", "global", "bundled"];

const TAB_LABELS: Record<SkillTab, string> = {
  project: "Project",
  agent: "Agent",
  global: "Global",
  bundled: "Bundled",
};

function getTabDescription(tab: SkillTab, agentId: string): string {
  const shortId = agentId.length > 20 ? `${agentId.slice(0, 20)}...` : agentId;
  switch (tab) {
    case "project":
      return ".skills/";
    case "agent":
      return `~/.letta/agents/${shortId}/skills/`;
    case "global":
      return "~/.letta/skills/";
    case "bundled":
      return "Built-in skills shipped with Letta Code";
  }
}

interface SkillsDialogProps {
  onClose: () => void;
  agentId: string;
}

export function SkillsDialog({ onClose, agentId }: SkillsDialogProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const { discoverSkills, SKILLS_DIR } = await import(
          "../../agent/skills"
        );
        const { getSkillsDirectory, getSkillSources } = await import(
          "../../agent/context"
        );
        const { join } = await import("node:path");
        const skillsDir =
          getSkillsDirectory() || join(process.cwd(), SKILLS_DIR);
        const result = await discoverSkills(skillsDir, agentId, {
          sources: getSkillSources(),
        });
        setSkills(result.skills);
      } catch {
        setSkills([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [agentId]);

  // Group skills by source
  const skillsBySource = useMemo(() => {
    const grouped = new Map<SkillSource, Skill[]>();
    for (const skill of skills) {
      const list = grouped.get(skill.source) ?? [];
      list.push(skill);
      grouped.set(skill.source, list);
    }
    return grouped;
  }, [skills]);

  // Only show tabs that have skills
  const availableTabs = useMemo(
    () => TAB_ORDER.filter((tab) => (skillsBySource.get(tab)?.length ?? 0) > 0),
    [skillsBySource],
  );

  const [activeTab, setActiveTab] = useState<SkillTab | null>(null);

  // Set initial tab once skills load
  useEffect(() => {
    if (!loading && availableTabs.length > 0 && activeTab === null) {
      setActiveTab(availableTabs[0] ?? null);
    }
  }, [loading, availableTabs, activeTab]);

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (availableTabs.length === 0) return;
      setActiveTab((current) => {
        const idx = current ? availableTabs.indexOf(current) : 0;
        const next =
          (idx + direction + availableTabs.length) % availableTabs.length;
        return availableTabs[next] ?? current;
      });
      setScrollOffset(0);
    },
    [availableTabs],
  );

  const currentSkills = useMemo(
    () => (activeTab ? (skillsBySource.get(activeTab) ?? []) : []),
    [activeTab, skillsBySource],
  );

  const visibleSkills = useMemo(
    () => currentSkills.slice(scrollOffset, scrollOffset + VISIBLE_ITEMS),
    [currentSkills, scrollOffset],
  );

  const showScrollDown = scrollOffset + VISIBLE_ITEMS < currentSkills.length;
  const itemsBelow = currentSkills.length - scrollOffset - VISIBLE_ITEMS;

  useInput(
    useCallback(
      (input, key) => {
        if (key.ctrl && input === "c") {
          onClose();
          return;
        }
        if (key.escape) {
          onClose();
        } else if (key.tab || key.rightArrow) {
          cycleTab(1);
        } else if (key.leftArrow) {
          cycleTab(-1);
        } else if (key.downArrow) {
          setScrollOffset((prev) =>
            Math.min(
              prev + 1,
              Math.max(0, currentSkills.length - VISIBLE_ITEMS),
            ),
          );
        } else if (key.upArrow) {
          setScrollOffset((prev) => Math.max(0, prev - 1));
        }
      },
      [onClose, cycleTab, currentSkills.length],
    ),
    { isActive: true },
  );

  const getTabLabel = (tab: SkillTab) => {
    const count = skillsBySource.get(tab)?.length ?? 0;
    return `${TAB_LABELS[tab]} [${count}]`;
  };

  const renderTabBar = () => (
    <Box flexDirection="row" gap={2}>
      {availableTabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <Text
            key={tab}
            backgroundColor={
              isActive ? colors.selector.itemHighlighted : undefined
            }
            color={isActive ? "black" : undefined}
            bold={isActive}
          >
            {` ${getTabLabel(tab)} `}
          </Text>
        );
      })}
    </Box>
  );

  // Count currently loaded skills (skills in the loaded_skills memory block)
  // For now, use total count since we don't track loaded state here
  const loadedCount = skills.length;

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /skills"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title and tabs */}
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Skills ({loadedCount} currently available)
        </Text>

        {loading && (
          <Box paddingLeft={2}>
            <Text dimColor>Loading skills...</Text>
          </Box>
        )}

        {!loading && skills.length === 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor>No skills found</Text>
            <Text dimColor>Create skills in .skills/ or ~/.letta/skills/</Text>
          </Box>
        )}

        {!loading && skills.length > 0 && (
          <Box flexDirection="column" paddingLeft={1}>
            {renderTabBar()}
            {activeTab && (
              <Text dimColor> {getTabDescription(activeTab, agentId)}</Text>
            )}
          </Box>
        )}
      </Box>

      {/* Skill list for active tab */}
      {!loading && currentSkills.length > 0 && (
        <Box flexDirection="column">
          {visibleSkills.map((skill) => {
            const tokens = charsToTokens(skill.description.length);
            return (
              <Text key={skill.id}>
                {"  "}
                {skill.id}
                <Text dimColor> · ~{tokens} description tokens</Text>
              </Text>
            );
          })}
          {showScrollDown ? (
            <Text dimColor>
              {"  "}↓ {itemsBelow} more below
            </Text>
          ) : currentSkills.length > VISIBLE_ITEMS ? (
            <Text> </Text>
          ) : null}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {"  "}
          {availableTabs.length > 1
            ? "↑↓ scroll · ←→/Tab switch · Esc to close"
            : "Esc to close"}
        </Text>
      </Box>
    </Box>
  );
}
