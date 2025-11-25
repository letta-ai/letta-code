Creates or imports a Skill into the local `.skills` directory.

Use this to materialize a new Skill for a given task by copying an existing `SKILL.md` from a terminal-bench-skills repo, or by preparing a destination skeleton when one is not found. Prefer using trajectories-derived skills when available.

Arguments:
- task (string, required): The task slug (e.g., "play-zork-easy"). Used as the skill directory name under `.skills/`.
- source_repo_path (string, optional): Absolute or relative path to the `terminal-bench-skills` repository. Defaults to `./terminal-bench-skills` if present.
- dest_skills_path (string, optional): Destination skills directory. Defaults to `./.skills`.
- overwrite (boolean, optional): Overwrite existing `SKILL.MD` if it already exists. Default: false.

Behavior:
1. Searches `<source_repo_path>/skills/**/<task>/SKILL.md` (case-insensitive) and, if found, copies it to `<dest_skills_path>/<task>/SKILL.MD`.
2. If not found, creates a minimal `SKILL.MD` skeleton at the destination with frontmatter and a TODO, so you can refine it.

Returns:
- Human-readable message and the destination path created/updated.
