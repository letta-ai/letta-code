Change this conversation's working directory to an existing folder.

Use this when the task moves to a different repository or directory and later relative file operations should use that location. Relative paths resolve from the current working directory. The selected directory persists for later turns in this conversation.

Project instructions and skills are discovered when a turn starts, so instructions and skills from the selected directory become available on the next turn. Later tool calls in the current turn use the new directory.

Use EnterWorktree instead when starting isolated feature or bug-fix work that should live in a managed git worktree.
