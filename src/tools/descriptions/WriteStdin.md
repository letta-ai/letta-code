Writes characters to an existing unified exec session and returns recent output.

Use this tool to send input, interrupt a process, or obtain output that you need before continuing. Do not call it merely to check whether a process has finished; `exec_command` sends a notification when a yielded process completes. If you must wait for the result now, make one blocking call with empty `chars` and a suitable `yield_time_ms` instead of repeated short polls.
