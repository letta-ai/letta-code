Writes characters to an existing unified exec session and returns recent output.

Use this tool to send input, interrupt a process, or inspect new output from a long-lived interactive process such as a dev server or REPL. Do not call it with empty `chars` merely to wait for completion; `exec_command` sends a notification when a yielded process completes. If the process needs a completion deadline, create a one-shot scheduled check instead of blocking or polling.
