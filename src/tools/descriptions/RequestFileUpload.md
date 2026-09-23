# RequestFileUpload

Use this tool when you need the user to provide one or more files during execution. The user will be shown a file upload prompt, and the completed tool result will contain the paths where the files are available to you.

Usage notes:
- Explain which file or files you need in `message`
- Use `accept` to suggest allowed MIME types or extensions, such as `.pdf,image/png`
- Set `multiple` to true only when more than one file is useful
- Do not call this tool unless the task genuinely requires file contents that the user has not already provided
