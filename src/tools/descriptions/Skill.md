Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills are listed in your prompt context with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (`/<name>`, or "slash command"); that's a request to invoke it.

- `skill`: exact name from the listing, no leading slash.

Only names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (`/help`, `/clear`, …) aren't skills. Do not invoke a skill that is already running. If a `<command-name>` block is already present this turn, the skill is loaded — follow it directly rather than calling again.
