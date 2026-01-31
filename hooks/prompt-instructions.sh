#!/bin/bash
# UserPromptSubmit hook - adds instructions to every prompt
# Reads JSON from stdin, outputs instructions to stdout, exits 0

# Consume stdin (required for hook protocol)
cat > /dev/null

# Output instructions that will be injected into agent context
echo "Be specific. Double check your work. Ask clarifying questions."

exit 0
