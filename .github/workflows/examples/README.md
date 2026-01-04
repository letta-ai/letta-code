# Letta Code GitHub Action Examples

This directory contains example workflows demonstrating various use cases for the Letta Code GitHub Action.

## Examples

### [code-review.yml](./code-review.yml)
Automatically reviews pull requests and provides AI-generated feedback on code quality, bugs, security, and performance.

**Key Features:**
- Read-only analysis (`--permission-mode plan`)
- Uses `Read` and `Grep` tools
- Posts review as PR comment

**Trigger:** Pull requests

### [test-fixer.yml](./test-fixer.yml)
Automatically fixes failing tests by analyzing failures, fixing code, and creating a PR.

**Key Features:**
- Full tool access for fixing
- Restricted Bash commands (`--allowedTools`)
- Auto-creates PR with fixes

**Trigger:** Manual dispatch, scheduled daily

### [security-audit.yml](./security-audit.yml)
Performs comprehensive security audits checking for vulnerabilities, hardcoded secrets, and security issues.

**Key Features:**
- Read-only mode (`--permission-mode plan`)
- Generates audit report
- Uploads artifacts
- Fails on critical issues

**Trigger:** Push to main, PRs, weekly schedule

### [doc-generator.yml](./doc-generator.yml)
Automatically generates and updates API documentation from source code.

**Key Features:**
- Auto-allows edits (`--permission-mode acceptEdits`)
- Uses `Read,Write,Grep,Glob` tools
- Auto-commits changes

**Trigger:** Push to main (when src/ changes), manual dispatch

### [issue-handler-enhanced.yml](./issue-handler-enhanced.yml)
Handles issue comments with `/letta` commands, extracts mentions, and tags users appropriately.

**Key Features:**
- @mention extraction
- User tagging in responses
- Creates PRs with fixes
- Intelligent notifications

**Trigger:** Issue comments with `/letta`, issues labeled `letta`

### [pr-review-with-mcp.yml](./pr-review-with-mcp.yml)
Enhanced PR review using GitHub MCP server for richer context and API access.

**Key Features:**
- GitHub MCP integration
- Full GitHub API access
- Tags PR author and reviewers
- Cross-references related issues/PRs

**Trigger:** Pull requests

## Usage

To use these examples in your repository:

1. **Copy** the workflow file to `.github/workflows/`
2. **Add** `LETTA_API_KEY` to repository secrets
3. **Customize** the prompts and CLI args as needed
4. **Remove** the `examples/` prefix from the path

## Configuration Patterns

### CLI Arguments

All configuration is done via CLI arguments for maximum flexibility:

```yaml
cli-args: >-
  --model claude-sonnet-4.5
  --tools Bash,Read,Write,Edit
  --allowedTools "Bash(npm test)"
  --permission-mode acceptEdits
  --output-format json
```

### Permission Modes

```yaml
# Read-only analysis
cli-args: --permission-mode plan --tools Read,Grep

# Auto-allow file edits
cli-args: --permission-mode acceptEdits --tools Read,Write,Edit

# Full automation (use carefully!)
cli-args: --permission-mode bypassPermissions --yolo
```

### Tool Restrictions

```yaml
# Only allow specific commands
cli-args: --allowedTools "Bash(npm test),Bash(npm run build)"

# Block dangerous commands
cli-args: --disallowedTools "Bash(rm -rf:*),Read(.env)"

# Limit to specific tools
cli-args: --tools "Read,Grep,Glob"
```

### MCP Integration

Configure MCP via `.letta/mcp_config.json`:

```yaml
- name: Setup GitHub MCP
  run: |
    mkdir -p .letta
    cat > .letta/mcp_config.json << 'EOF'
    {
      "mcpServers": {
        "github": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": {
            "GITHUB_PERSONAL_ACCESS_TOKEN": "${{ secrets.GITHUB_TOKEN }}"
          }
        }
      }
    }
    EOF
```

### User Mentions

Extract and tag users in responses:

```yaml
- name: Extract mentions
  uses: actions/github-script@v7
  with:
    script: |
      const body = context.payload.comment.body;
      const mentions = [...body.matchAll(/@([a-zA-Z0-9-]+)/g)].map(m => m[1]);
      core.setOutput('mentions', mentions.join(','));

- name: Tag users in comment
  run: |
    gh issue comment ${{ github.event.issue.number }} \
      --body "@${{ steps.extract.outputs.mentions }} Your response here"
```

## Security Considerations

1. **API Keys**: Always use GitHub Secrets
2. **Permission Modes**: Use `plan` for untrusted input
3. **Tool Restrictions**: Limit Bash with patterns
4. **Review PRs**: Always review AI-generated code
5. **MCP Tokens**: Limit scope of MCP server tokens

## Common Use Cases

### Read-only Analysis
```yaml
cli-args: >-
  --tools Read,Grep,Glob
  --permission-mode plan
```

### Code Modifications
```yaml
cli-args: >-
  --tools Read,Write,Edit
  --permission-mode acceptEdits
```

### Test Execution
```yaml
cli-args: >-
  --tools Bash,Read,Write,Edit
  --allowedTools "Bash(npm test),Bash(bun test)"
  --permission-mode acceptEdits
```

### GitHub MCP Integration
```yaml
# Setup MCP first
- run: |
    mkdir -p .letta
    echo '{"mcpServers": {"github": {...}}}' > .letta/mcp_config.json

# Then run Letta
- uses: letta-ai/letta-code@v1
  with:
    prompt: 'Use GitHub MCP to analyze this PR'
```

## Additional Resources

- [Action README](../../../ACTION_README.md) - Full documentation
- [Letta Code Docs](https://github.com/letta-ai/letta-code)
- [MCP Documentation](https://docs.letta.com/guides/mcp)
- [Letta API Docs](https://docs.letta.com)

## Contributing

Have a cool workflow example? Submit a PR!
