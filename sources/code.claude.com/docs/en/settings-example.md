> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Example settings files

> Realistic settings.json files for a developer, a team, and an organization: copy one, keep the keys you want, and change the values.

This page holds three example `settings.json` files, one for each place you save a setting:

* A developer's `~/.claude/settings.json`
* A team's `.claude/settings.json`, committed to the repository
* An organization's `managed-settings.json`

Each one is a plausible file for that reader, so you can see the shape and copy the parts you want. None of them is a recommended baseline. Every value comes from the key's entry on the [settings reference](/docs/en/settings-reference), which has its type, default, and where it can be set.

Each example has two tabs. **Copyable settings file** is the file as you'd save it. **What each key does** is the same file with a comment above each key; Claude Code doesn't accept comments in a settings file, so copy from the first tab.

## Your own settings

One developer's personal settings. It picks a model and effort, adjusts the terminal, and pre-approves a read-only command and one file read. Everything not listed keeps its default. A file like this goes in `~/.claude/settings.json`, where it applies to every project you open.

<Tabs>
  <Tab title="Copyable settings file">
    Save this as `~/.claude/settings.json`. It's valid JSON with no comments, so you can paste it as is and delete the keys you don't want.

    ```json ~/.claude/settings.json theme={null}
    {
      "model": "claude-sonnet-5",
      "effortLevel": "xhigh",
      "editorMode": "vim",
      "theme": "light-daltonized",
      "statusLine": {
        "type": "command",
        "command": "jq -r '\"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context\"'",
        "padding": 2
      },
      "spinnerTipsEnabled": false,
      "preferredNotifChannel": "terminal_bell",
      "permissions": {
        "allow": [
          "Bash(git diff *)",
          "Read(~/.zshrc)"
        ]
      },
      "autoUpdatesChannel": "stable",
      "cleanupPeriodDays": 20
    }
    ```
  </Tab>

  <Tab title="What each key does">
    The same file with a comment above each key. Read it here; copy from the other tab, because Claude Code doesn't accept comments in a settings file.

    ```jsonc ~/.claude/settings.json theme={null}
    {
      // Start every session on Sonnet 5
      "model": "claude-sonnet-5",
      // Reason more deeply than the default high level; /effort saves a new level, and --effort overrides it for one session
      "effortLevel": "xhigh",
      // Vim keybindings in the prompt
      "editorMode": "vim",
      // The colorblind-friendly light theme
      "theme": "light-daltonized",
      // A status line below the prompt: model name and context used
      "statusLine": {
        "type": "command",
        "command": "jq -r '\"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context\"'",
        "padding": 2
      },
      // Hide the tips that rotate under the spinner
      "spinnerTipsEnabled": false,
      // Ring the terminal bell for notifications, such as a finished task or a waiting permission prompt
      "preferredNotifChannel": "terminal_bell",
      // Let Claude Code run git diff and read your .zshrc without asking
      "permissions": {
        "allow": [
          "Bash(git diff *)",
          "Read(~/.zshrc)"
        ]
      },
      // Take updates from the stable channel
      "autoUpdatesChannel": "stable",
      // Delete session transcripts and other local session data older than 20 days
      "cleanupPeriodDays": 20
    }
    ```
  </Tab>
</Tabs>

<h2 id="a-teams-shared-settings">
  A team's shared settings
</h2>

One team's shared settings, committed to the repository so everyone who clones it gets the same permissions, hooks, telemetry, and plugin marketplace. Save a file like this at `.claude/settings.json` at the top of the repository. Three things to know before you commit one:

* **Cloud sessions read it too.** A [cloud session](/docs/en/settings#settings-in-cloud-sessions) on Claude Code on the web starts from a clone of the repository, so the committed file applies there as well.
* **Allow rules wait for trust.** Allow rules and `extraKnownMarketplaces` entries take effect after each person [trusts this folder itself](/docs/en/permissions#project-allow-rules-and-workspace-trust), not only a parent folder; deny and ask rules apply in every session, trusted or not.
* **The hook is a script in the repo.** This file's hook runs `.claude/hooks/block-rm.sh`; [How a hook resolves](/docs/en/hooks#how-a-hook-resolves) walks through writing it.

<Tabs>
  <Tab title="Copyable settings file">
    Save this as `.claude/settings.json` at the top of the repository and commit it. It's valid JSON with no comments, so you can paste it as is and delete the keys you don't want.

    ```json .claude/settings.json theme={null}
    {
      "permissions": {
        "allow": [
          "Bash(npm run *)"
        ],
        "ask": [
          "Bash(git push *)"
        ],
        "deny": [
          "Read(./.env)",
          "Read(./.env.*)",
          "Read(./secrets/**)"
        ]
      },
      "env": {
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "OTEL_METRICS_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.example.com:4317"
      },
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {
                "type": "command",
                "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh"
              }
            ]
          }
        ]
      },
      "extraKnownMarketplaces": {
        "acme-tools": {
          "source": {
            "source": "github",
            "repo": "acme-corp/claude-plugins"
          }
        }
      },
      "enabledPlugins": {
        "code-formatter@acme-tools": true
      },
      "sandbox": {
        "enabled": true,
        "filesystem": {
          "allowWrite": [
            "/tmp/build"
          ]
        },
        "network": {
          "allowedDomains": [
            "registry.npmjs.org",
            "*.example.com"
          ]
        }
      },
      "plansDirectory": "./plans"
    }
    ```
  </Tab>

  <Tab title="What each key does">
    The same file with a comment above each key. Read it here; copy from the other tab, because Claude Code doesn't accept comments in a settings file.

    ```jsonc .claude/settings.json theme={null}
    {
      "permissions": {
        // Run npm scripts without asking
        "allow": [
          "Bash(npm run *)"
        ],
        // Always confirm before pushing
        "ask": [
          "Bash(git push *)"
        ],
        // Never read env files or the secrets folder
        "deny": [
          "Read(./.env)",
          "Read(./.env.*)",
          "Read(./secrets/**)"
        ]
      },
      // Send OpenTelemetry metrics to the team's collector over gRPC; replace the endpoint with your collector's URL
      "env": {
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "OTEL_METRICS_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.example.com:4317"
      },
      // Before every Bash command, run a script in the repo that can block it
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {
                "type": "command",
                "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh"
              }
            ]
          }
        ]
      },
      // Register the team's plugin marketplace on every clone
      "extraKnownMarketplaces": {
        "acme-tools": {
          "source": {
            "source": "github",
            "repo": "acme-corp/claude-plugins"
          }
        }
      },
      // Enable one plugin from that marketplace; a plugin from an external source such as a GitHub repository still needs each person to install it once
      "enabledPlugins": {
        "code-formatter@acme-tools": true
      },
      // Sandbox commands: writable build dir; npm and example.com pre-allowed, other hosts still prompt
      "sandbox": {
        "enabled": true,
        "filesystem": {
          "allowWrite": [
            "/tmp/build"
          ]
        },
        "network": {
          "allowedDomains": [
            "registry.npmjs.org",
            "*.example.com"
          ]
        }
      },
      // Keep plan files inside the repo
      "plansDirectory": "./plans"
    }
    ```
  </Tab>
</Tabs>

<h2 id="an-organizations-managed-settings">
  An organization's managed settings
</h2>

A `managed-settings.json` file that shows the shape of the managed keys, with one plausible value for each. It isn't a recommended policy: pick the keys that match your own requirements and set your own values. The example sets these keys:

* `forceLoginMethod` and `forceLoginOrgUUID` pin the login method and organization
* `availableModels` and `enforceAvailableModels` restrict which models sessions can use
* `permissions.deny` blocks two file reads and `curl`, and `disableBypassPermissionsMode` removes the bypass permission mode
* `allowManagedPermissionRulesOnly` and `allowManagedMcpServersOnly` make the managed permission and MCP allowlists the only ones that apply
* `allowedMcpServers` pins the MCP server by URL
* `strictKnownMarketplaces` allows one plugin marketplace
* `sandbox` sandboxes commands with a fixed network allowlist and no unsandboxed retry
* `requiredMinimumVersion` sets a minimum Claude Code version
* `cleanupPeriodDays` shortens retention of session transcripts and other local data to seven days
* `companyAnnouncements` shows a message at startup

Administrators deploy a file like this as `managed-settings.json`, or the same JSON through MDM or [server-managed settings](/docs/en/server-managed-settings). One deployed file applies to every machine or account it reaches. To give a group different values, deploy a different file or profile to that group, since [server-managed settings don't support per-group policy yet](/docs/en/server-managed-settings#current-limitations).

<Tabs>
  <Tab title="Copyable settings file">
    Deploy this as `managed-settings.json`, or the same JSON through MDM or the claude.ai console. It's valid JSON with no comments; replace the example organization UUID, server URL, and marketplace with your own and delete the keys you don't want.

    ```json managed-settings.json theme={null}
    {
      "forceLoginMethod": "claudeai",
      "forceLoginOrgUUID": [
        "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      ],
      "availableModels": [
        "opus",
        "sonnet"
      ],
      "enforceAvailableModels": true,
      "permissions": {
        "deny": [
          "Bash(curl *)",
          "Read(./.env)",
          "Read(./secrets/**)"
        ],
        "disableBypassPermissionsMode": "disable"
      },
      "allowManagedPermissionRulesOnly": true,
      "allowedMcpServers": [
        {
          "serverUrl": "https://api.githubcopilot.com/*"
        }
      ],
      "allowManagedMcpServersOnly": true,
      "strictKnownMarketplaces": [
        {
          "source": "github",
          "repo": "acme-corp/approved-plugins"
        }
      ],
      "sandbox": {
        "enabled": true,
        "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "network": {
          "allowedDomains": [
            "registry.npmjs.org",
            "github.com"
          ],
          "allowManagedDomainsOnly": true
        }
      },
      "requiredMinimumVersion": "2.1.150",
      "cleanupPeriodDays": 7,
      "companyAnnouncements": [
        "Welcome to Acme Corp! Review our code guidelines at docs.example.com"
      ]
    }
    ```
  </Tab>

  <Tab title="What each key does">
    The same file with a comment above each key. Read it here; copy from the other tab, because Claude Code doesn't accept comments in a settings file.

    ```jsonc managed-settings.json theme={null}
    {
      // Only claude.ai logins, and only in this organization
      "forceLoginMethod": "claudeai",
      "forceLoginOrgUUID": [
        "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      ],
      // Only Opus and Sonnet models; with enforceAvailableModels, the Default option obeys the list too
      "availableModels": [
        "opus",
        "sonnet"
      ],
      "enforceAvailableModels": true,
      "permissions": {
        // Block curl, the project's .env file, and its secrets folder on every machine
        "deny": [
          "Bash(curl *)",
          "Read(./.env)",
          "Read(./secrets/**)"
        ],
        // Remove the bypass-permissions mode from every session
        "disableBypassPermissionsMode": "disable"
      },
      // Only managed permission rules apply
      "allowManagedPermissionRulesOnly": true,
      // Only the GitHub MCP server, matched by URL rather than by name, since a user can
      // name any server "github". Servers that don't match don't load, which includes every
      // stdio server when the list has only URL entries; the lock below makes this managed
      // list the only allowlist that counts
      "allowedMcpServers": [
        {
          "serverUrl": "https://api.githubcopilot.com/*"
        }
      ],
      "allowManagedMcpServersOnly": true,
      // Plugins can come only from this marketplace
      "strictKnownMarketplaces": [
        {
          "source": "github",
          "repo": "acme-corp/approved-plugins"
        }
      ],
      // Sandbox every command, refuse to start if the sandbox can't be set up, and
      // never let a blocked command retry outside the sandbox; network limited to
      // npm and GitHub, and users can't add domains
      "sandbox": {
        "enabled": true,
        "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "network": {
          "allowedDomains": [
            "registry.npmjs.org",
            "github.com"
          ],
          "allowManagedDomainsOnly": true
        }
      },
      // Refuse to start on versions older than 2.1.150
      "requiredMinimumVersion": "2.1.150",
      // Delete session transcripts and other local session data after 7 days
      "cleanupPeriodDays": 7,
      // A message every user sees at startup
      "companyAnnouncements": [
        "Welcome to Acme Corp! Review our code guidelines at docs.example.com"
      ]
    }
    ```
  </Tab>
</Tabs>
