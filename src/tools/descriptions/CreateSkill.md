Creates or imports a Skill into the local `.skills` directory.

Use this to materialize a new Skill for a given task by either copying an existing curated `SKILL.md` from a local repository of skills (via `source_repo_path`), or by preparing a destination skeleton when a curated file isn’t available. Prefer reusing high‑quality, existing skill specs when available.

Arguments:
- task (string, required): The task slug (e.g., "play-zork-easy"). Used as the skill directory name under `.skills/`.
- source_repo_path (string, optional): Absolute or relative path to a local repository containing curated skills. When provided, this tool looks for `<source_repo_path>/skills/**/<task>/SKILL.md`.
- dest_skills_path (string, optional): Destination skills directory. Defaults to `./.skills`.
- overwrite (boolean, optional): Overwrite existing `SKILL.MD` if it already exists. Default: false.

Behavior:
1. If a curated `SKILL.md` is found at `<source_repo_path>/skills/**/<task>/SKILL.md`, copy it to `<dest_skills_path>/<task>/SKILL.MD`.
2. Otherwise, initialize a minimal `SKILL.MD` skeleton at the destination with frontmatter and a TODO to refine.

Returns:
- Human‑readable message and the destination path created/updated.
