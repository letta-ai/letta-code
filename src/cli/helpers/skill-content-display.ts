import { SKILL_CONTENT_BLOCK_REGEX } from "@/constants";

export function stripSkillContentBlocks(text: string): string {
  return text.replace(SKILL_CONTENT_BLOCK_REGEX, "").trim();
}
