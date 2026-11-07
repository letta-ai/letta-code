Writes characters to an existing unified exec session and returns recent output.

Do not call it with empty `chars` merely to wait for completion; `exec_command` sends a notification when a yielded process completes. If the process needs a completion deadline, create a one-shot Wake instead of blocking or polling.
