# Skill

Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with only the skill name
- Examples:
  - `skill: "pdf"` - invoke the pdf skill
  - `skill: "commit"` - invoke the commit skill
  - `skill: "review-pr"` - invoke the review-pr skill
  - `skill: "ms-office-suite:pdf"` - invoke using fully qualified name

Important:
- Available skills are included in your current prompt context in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
