# Skill

Load a skill into the system prompt within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke skills using this tool with the skill name only (no arguments)
- When you invoke a skill, the SKILL.md content will be loaded into the `loaded_skills` memory block
- The skill's prompt will provide detailed instructions on how to complete the task
- Examples:
  - `skill: "data-analysis"` - invoke the data-analysis skill
  - `skill: "web-scraper"` - invoke the web-scraper skill

Important:
- Only load skills that are available in the `skills` memory block
- Skills remain loaded until you unload them
- Unload skills when done to free up context space
- Do not invoke a skill that is already loaded
- You can check what skills are currently loaded in the `loaded_skills` memory block
</skills_instructions>

Usage notes:
- The `skill` parameter is required and should be the skill ID (e.g., "data-analysis")
- Skills are loaded from the skills directory specified in the `skills` memory block
- Skills remain loaded in the `loaded_skills` memory block until explicitly unloaded
- Only use skill IDs that appear in the `skills` memory block
- Each skill provides specialized instructions and capabilities for specific tasks
