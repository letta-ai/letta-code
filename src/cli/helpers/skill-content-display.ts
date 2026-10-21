const SKILL_CONTENT_BLOCK_REGEX =
  /<skill_content\b[^>]*>[\s\S]*?<\/skill_content>/g;

export function stripSkillContentBlocks(text: string): string {
  return text.replace(SKILL_CONTENT_BLOCK_REGEX, "").trim();
}
