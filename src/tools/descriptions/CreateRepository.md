Create a hosted repository for the current agent and mount it next to `$MEMORY_DIR`.

The repository is created on the Letta server, linked to the current agent with read/write permissions, cloned locally, and returned as a filesystem path. Repositories are mounted at the same directory level as the memory directory: `$MEMORY_DIR/../<name>`.

Use this when the agent needs a new persistent git-backed repository separate from memory. To list existing repositories, list the parent directory of `$MEMORY_DIR`.
