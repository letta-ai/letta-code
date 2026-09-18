# Remember

The user wants you to retain information from this conversation. Identify the fact, preference, correction, or rule they want remembered, using any text supplied after `/remember`.

Delegate the update to the Agent tool with `subagent_type: "memory"`. Include the intended change and relevant evidence; the memory subagent has a fork of this conversation and will choose the files, reconcile existing information, and commit the changes.

Continue immediately. Do not edit memory yourself, wait for the task, or poll its output. Briefly acknowledge that you delegated the update without claiming it has already been saved.
