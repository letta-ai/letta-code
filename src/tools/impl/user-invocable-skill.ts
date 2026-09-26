import { readFile } from "node:fs/promises";
import {
  type DiscoverClientSideSkillsOptions,
  discoverClientSideSkills,
} from "@/agent/client-skills";
import { isUserInvocableSkill, type Skill } from "@/agent/skills";
import { renderSkillContent, wrapSkillPrompt } from "./skill";

export interface UserInvocableSkillInvocation {
  skill: Skill;
  userRequest: string;
}

/** Resolve an explicit /skill invocation using the same skill scope as the turn. */
export async function findUserInvocableSkillInvocation(
  input: string,
  options: DiscoverClientSideSkillsOptions,
): Promise<UserInvocableSkillInvocation | null> {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/)[0] ?? "";
  if (!command.startsWith("/") || command.length < 2) return null;

  const skillId = command.slice(1);
  const discovery = await discoverClientSideSkills(options);
  const skill = discovery.skills.find(
    (candidate) => candidate.id === skillId && isUserInvocableSkill(candidate),
  );
  if (!skill) return null;

  return {
    skill,
    userRequest: trimmed.slice(command.length).trim(),
  };
}

/** Read the discovered path, not a second lookup with different source precedence. */
export async function renderUserInvocableSkillInvocation(
  invocation: UserInvocableSkillInvocation,
): Promise<string> {
  const content = await readFile(invocation.skill.path, "utf8");
  return wrapSkillPrompt(
    invocation.skill.id,
    renderSkillContent(invocation.skill.id, content, invocation.skill.path, {
      allowDisabledModelInvocation: true,
    }),
    invocation.userRequest,
  );
}
