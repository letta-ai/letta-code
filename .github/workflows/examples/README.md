# Letta Code GitHub Action Examples

This directory contains example workflows demonstrating various use cases for the Letta Code GitHub Action.

## Examples

### [code-review.yml](./code-review.yml)
Automatically reviews pull requests and provides AI-generated feedback on:
- Code quality and best practices
- Potential bugs or issues
- Security concerns
- Performance considerations

**Triggers:** Pull requests (opened, synchronized)

### [test-fixer.yml](./test-fixer.yml)
Automatically fixes failing tests by:
- Identifying test failures
- Analyzing root causes
- Fixing the code
- Creating a PR with the fixes

**Triggers:** Manual dispatch, scheduled (daily at 2am)

### [security-audit.yml](./security-audit.yml)
Performs comprehensive security audits checking for:
- Hardcoded secrets
- SQL injection vulnerabilities
- XSS vulnerabilities
- Authentication/authorization issues
- Insecure dependencies

**Triggers:** Push to main, pull requests, weekly schedule

### [doc-generator.yml](./doc-generator.yml)
Automatically generates and updates API documentation:
- Creates/updates API.md
- Includes function signatures and parameters
- Adds usage examples
- Documents error cases

**Triggers:** Push to main (when src/ changes), manual dispatch

### [issue-handler.yml](./issue-handler.yml)
Handles issue comments with `/letta` commands:
- Extracts command from issue comment
- Executes the requested task
- Creates PR with changes
- Comments back on the issue with results

**Triggers:** Issue comments containing `/letta`

## Usage

To use these examples in your repository:

1. Copy the workflow file to your `.github/workflows/` directory
2. Add your `LETTA_API_KEY` to repository secrets
3. Customize the prompts and settings as needed
4. Remove the `examples/` prefix from the path

## Common Patterns

### Read-only Analysis
```yaml
permission-mode: 'plan'
tools: 'Read,Grep,Glob'
```

### Code Modifications
```yaml
permission-mode: 'acceptEdits'
tools: 'Read,Write,Edit'
```

### Test Execution
```yaml
permission-mode: 'acceptEdits'
tools: 'Bash,Read,Write,Edit'
allowed-tools: 'Bash(npm test),Bash(npm run build)'
```

### Maximum Automation
```yaml
permission-mode: 'bypassPermissions'
tools: 'Bash,Read,Write,Edit,Grep,Glob'
```

## Security Considerations

- Always use GitHub Secrets for API keys
- Use `permission-mode: 'plan'` for read-only operations
- Restrict Bash commands with patterns when possible
- Review AI-generated PRs before merging
- Consider requiring approval for AI-generated PRs

## Additional Resources

- [Letta Code Documentation](https://github.com/letta-ai/letta-code)
- [Action README](../../../ACTION_README.md)
- [Letta API Documentation](https://docs.letta.com)

## Contributing

Have a cool workflow example? Submit a PR!
