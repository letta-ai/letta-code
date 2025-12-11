# Letta Code GitHub Action

Run [Letta Code](https://github.com/letta-ai/letta-code) AI agent in your GitHub workflows for automated code analysis, generation, testing, and modifications.

## Features

- 🤖 **Stateful AI Agent**: Maintains context across conversations
- 🔧 **Multiple Models**: Support for Claude, GPT, Gemini, and more
- 🛠️ **Powerful Tools**: Bash, Read, Write, Edit, Grep, and more
- 🔒 **Permission Control**: Fine-grained control over tool permissions
- 📊 **Structured Output**: JSON output with token usage and metadata

## Usage

### Basic Example

```yaml
name: AI Code Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run Letta Code
        uses: letta-ai/letta-code@v1
        with:
          api-key: ${{ secrets.LETTA_API_KEY }}
          prompt: 'Review the changes in this PR and suggest improvements'
          model: 'claude-sonnet-4.5'
          permission-mode: 'plan'
```

### Code Analysis

```yaml
- name: Analyze codebase
  uses: letta-ai/letta-code@v1
  with:
    api-key: ${{ secrets.LETTA_API_KEY }}
    prompt: 'Analyze the codebase for security vulnerabilities'
    tools: 'Read,Grep'
    permission-mode: 'plan'
```

### Automated Testing

```yaml
- name: Run tests with AI assistance
  uses: letta-ai/letta-code@v1
  with:
    api-key: ${{ secrets.LETTA_API_KEY }}
    prompt: 'Run the test suite and fix any failing tests'
    tools: 'Bash,Read,Write,Edit'
    allowed-tools: 'Bash(npm run test:*),Bash(bun test),Read,Write,Edit'
    permission-mode: 'acceptEdits'
```

### Code Generation

```yaml
- name: Generate API documentation
  uses: letta-ai/letta-code@v1
  with:
    api-key: ${{ secrets.LETTA_API_KEY }}
    prompt: 'Generate API documentation from the source code'
    tools: 'Read,Write'
    permission-mode: 'acceptEdits'
    working-directory: './docs'
```

### Using Output

```yaml
- name: Run analysis
  id: analysis
  uses: letta-ai/letta-code@v1
  with:
    api-key: ${{ secrets.LETTA_API_KEY }}
    prompt: 'Count the number of TypeScript files'
    output-format: 'json'

- name: Use output
  run: |
    echo "Result: ${{ steps.analysis.outputs.result }}"
    echo "Agent ID: ${{ steps.analysis.outputs.agent-id }}"
    echo "Duration: ${{ steps.analysis.outputs.duration-ms }}ms"
    echo "Token usage: ${{ steps.analysis.outputs.usage }}"
```

### Advanced: Multi-step workflow

```yaml
name: AI-Assisted Development

on:
  issue_comment:
    types: [created]

jobs:
  handle-command:
    if: contains(github.event.comment.body, '/letta')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Extract command
        id: extract
        run: |
          COMMAND=$(echo "${{ github.event.comment.body }}" | sed 's/\/letta //g')
          echo "command=$COMMAND" >> $GITHUB_OUTPUT
      
      - name: Run Letta Code
        id: letta
        uses: letta-ai/letta-code@v1
        with:
          api-key: ${{ secrets.LETTA_API_KEY }}
          prompt: ${{ steps.extract.outputs.command }}
          model: 'claude-sonnet-4.5'
          tools: 'Read,Write,Edit,Bash,Grep,Glob'
          permission-mode: 'acceptEdits'
          output-format: 'json'
      
      - name: Create PR if changes made
        if: steps.letta.outputs.exit-code == '0'
        run: |
          git config user.name "Letta Code"
          git config user.email "noreply@letta.com"
          git checkout -b letta-changes-${{ github.event.issue.number }}
          git add .
          git commit -m "Changes from Letta Code

          ${{ steps.letta.outputs.result }}

          🦾 Generated with Letta Code"
          git push origin letta-changes-${{ github.event.issue.number }}
          gh pr create --title "Letta Code: ${{ steps.extract.outputs.command }}" \
                       --body "${{ steps.letta.outputs.result }}"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api-key` | Letta API key ([get one here](https://app.letta.com)) | Yes | - |
| `prompt` | The prompt/task to send to Letta Code | Yes | - |
| `model` | Model to use (e.g., `claude-sonnet-4.5`, `gpt-4o`, `gemini-pro`) | No | `claude-sonnet-4.5` |
| `tools` | Comma-separated list of tools to load or empty string for no tools | No | `""` |
| `allowed-tools` | Comma-separated list of allowed tools with optional patterns | No | `""` |
| `disallowed-tools` | Comma-separated list of disallowed tools | No | `""` |
| `permission-mode` | Permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions` | No | `default` |
| `output-format` | Output format: `text`, `json`, `stream-json` | No | `json` |
| `working-directory` | Working directory to run Letta Code in | No | `.` |
| `bun-version` | Version of Bun to use | No | `1.3.0` |
| `letta-code-version` | Version of Letta Code to install | No | `latest` |

## Outputs

| Output | Description |
|--------|-------------|
| `result` | The result/response from Letta Code |
| `agent-id` | The agent ID used in this run |
| `exit-code` | Exit code from Letta Code (0 = success) |
| `duration-ms` | Total duration in milliseconds |
| `usage` | Token usage statistics (JSON) |

## Permission Modes

- **`default`**: Standard behavior, prompts for approval (not suitable for CI)
- **`acceptEdits`**: Auto-allows Write/Edit/NotebookEdit tools
- **`plan`**: Read-only mode, allows analysis but blocks modifications
- **`bypassPermissions`**: Auto-allows all tools (use carefully!)

## Available Tools

- **`Bash`**: Execute shell commands
- **`Read`**: Read files
- **`Write`**: Write/create files
- **`Edit`**: Edit existing files
- **`Grep`**: Search file contents
- **`Glob`**: Find files by pattern
- **`Skill`**: Load custom skills
- And more...

## Tool Patterns

You can specify patterns for allowed/disallowed tools:

```yaml
allowed-tools: 'Bash(npm run test:*),Bash(bun test),Read(src/**)'
disallowed-tools: 'Bash(rm -rf:*),Read(.env)'
```

## Security Best Practices

1. **Use Secrets**: Always store your Letta API key in GitHub Secrets
2. **Limit Permissions**: Use `permission-mode: plan` for read-only operations
3. **Restrict Tools**: Only enable the tools you need
4. **Use Patterns**: Restrict Bash commands with patterns (e.g., `Bash(npm run test:*)`)
5. **Review Changes**: Use `acceptEdits` mode carefully and review generated changes

## Getting a Letta API Key

1. Visit [https://app.letta.com](https://app.letta.com)
2. Sign up or log in
3. Generate an API key
4. Add it to your repository secrets as `LETTA_API_KEY`

## Examples Repository

Check out [letta-code-examples](https://github.com/letta-ai/letta-code-examples) for more workflow examples.

## Support

- **Discord**: [discord.gg/letta](https://discord.gg/letta)
- **Issues**: [github.com/letta-ai/letta-code/issues](https://github.com/letta-ai/letta-code/issues)
- **Docs**: [docs.letta.com](https://docs.letta.com)

## License

Apache-2.0 - see [LICENSE](LICENSE) for details.

---

Made with 💜 in San Francisco
