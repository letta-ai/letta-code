# Skill

Load or unload skills into the agent's memory.

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Use `command: "load"` with a list of skill IDs to load skills
- Use `command: "unload"` with a list of skill IDs to unload skills
- Use `command: "refresh"` to re-scan the skills directory and update the available skills list
- When you load a skill, the SKILL.md content will be added to the `loaded_skills` memory block
- The skill's prompt will provide detailed instructions on how to complete the task
- Examples:
  - `command: "load", skills: ["data-analysis"]` - load the data-analysis skill
  - `command: "load", skills: ["web-scraper", "pdf"]` - load multiple skills
  - `command: "unload", skills: ["data-analysis"]` - unload the data-analysis skill
  - `command: "refresh"` - re-scan and update available skills list

Important:
- Only load skills that are available in the `skills` memory block
- Unload skills when done to free up context space
- You can check what skills are currently loaded in the `loaded_skills` memory block
- Loading an already-loaded skill will be skipped (no error)
- Unloading a not-loaded skill will be skipped (no error)
- Use `refresh` after creating a new skill to make it available for loading
</skills_instructions>

Usage notes:
- The `command` parameter is required: either "load", "unload", or "refresh"
- The `skills` parameter is required for load/unload: an array of skill IDs to load or unload
- The `skills` parameter is not used for refresh
- Skills are loaded from the skills directory specified in the `skills` memory block
- Skills remain loaded in the `loaded_skills` memory block until explicitly unloaded
- Only use skill IDs that appear in the `skills` memory block
- Each skill provides specialized instructions and capabilities for specific tasks
