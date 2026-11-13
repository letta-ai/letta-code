/**
 * Splits a skill-delta reminder into the skill names listed under each
 * section, so tests can assert the diff rather than the wording.
 */
export type SkillDeltaSections = {
  added: string[];
  updated: string[];
  removed: string[];
  current: string[];
};

export function parseSkillDeltaReminder(
  reminder: string | null,
): SkillDeltaSections | null {
  if (reminder === null) return null;
  const sections: SkillDeltaSections = {
    added: [],
    updated: [],
    removed: [],
    current: [],
  };
  let section: keyof SkillDeltaSections | null = null;
  for (const line of reminder.split("\n")) {
    if (line.startsWith("Added skills")) section = "added";
    else if (line.startsWith("Updated skills")) section = "updated";
    else if (line.startsWith("Removed skills")) section = "removed";
    else if (line.startsWith("Current skills")) section = "current";
    else if (section) {
      const name =
        line.match(/^ {4}<name>(.*)<\/name>$/)?.[1] ??
        line.match(/^- (.*)$/)?.[1];
      if (name !== undefined) sections[section].push(name);
    }
  }
  return sections;
}
