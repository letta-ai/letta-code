#!/bin/bash

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')
working_dir=$(echo "$input" | jq -r '.working_directory')

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
BLUE='\033[34m'
RESET='\033[0m'

echo -e "\n"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}Permission Request: ${BLUE}$tool_name${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n"

show_permissions() {
  local file="$1"
  local label="$2"
  local color="$3"

  echo -e "${color}${BOLD}$label${RESET}"
  echo -e "${DIM}$file${RESET}"

  if [ -f "$file" ]; then
    if ! jq empty "$file" >/dev/null 2>&1; then
      echo -e "  ${RED}(malformed JSON - rules cannot be read)${RESET}"
      echo ""
      return
    fi
    local allow=$(jq -r '.permissions.allow // [] | .[]' "$file" 2>/dev/null)
    local deny=$(jq -r '.permissions.deny // [] | .[]' "$file" 2>/dev/null)
    local ask=$(jq -r '.permissions.ask // [] | .[]' "$file" 2>/dev/null)

    if [ -n "$allow" ] || [ -n "$deny" ] || [ -n "$ask" ]; then
      if [ -n "$allow" ]; then
        echo -e "  ${GREEN}Allow:${RESET}"
        echo "$allow" | while read -r rule; do
          [ -n "$rule" ] && echo -e "    ${GREEN}✓${RESET} $rule"
        done
      fi

      if [ -n "$deny" ]; then
        echo -e "  ${RED}Deny:${RESET}"
        echo "$deny" | while read -r rule; do
          [ -n "$rule" ] && echo -e "    ${RED}✗${RESET} $rule"
        done
      fi

      if [ -n "$ask" ]; then
        echo -e "  ${YELLOW}Ask:${RESET}"
        echo "$ask" | while read -r rule; do
          [ -n "$rule" ] && echo -e "    ${YELLOW}?${RESET} $rule"
        done
      fi
    else
      echo -e "  ${DIM}(none)${RESET}"
    fi
  else
    echo -e "  ${DIM}(file not found)${RESET}"
  fi
  echo ""
}

xdg_config="${XDG_CONFIG_HOME:-$HOME/.config}"
show_permissions "$xdg_config/letta/settings.json" "User Settings (XDG)" "$BLUE"

show_permissions "$HOME/.letta/settings.json" "User Settings (Legacy)" "$BLUE"

show_permissions "$working_dir/.letta/settings.json" "Project Settings" "$YELLOW"

show_permissions "$working_dir/.letta/settings.local.json" "Project Local Settings" "$GREEN"

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n"

exit 1
