> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Configure server-managed settings

> Centrally configure Claude Code for your organization through server-delivered settings, without requiring device management infrastructure.

Server-managed settings let organization Owners centrally configure Claude Code from [**Admin Settings > Claude Code > Managed settings**](https://claude.ai/admin-settings/claude-code) in the claude.ai console. Claude Code clients fetch these settings automatically when users authenticate with a Team or Enterprise OAuth login, an OAuth token supplied through `CLAUDE_CODE_OAUTH_TOKEN`, or a directly configured API key, on platforms where server-managed delivery is supported. See [Platform availability](#platform-availability).

<Note>
  Server-managed settings are available for [Claude for Teams](https://claude.com/pricing?utm_source=claude_code\&utm_medium=docs\&utm_content=server_settings_teams#team-&-enterprise) and [Claude for Enterprise](https://anthropic.com/contact-sales?utm_source=claude_code\&utm_medium=docs\&utm_content=server_settings_enterprise) customers.
</Note>

## Requirements

To use server-managed settings, you need:

* Claude for Teams or Claude for Enterprise plan
* The Owner or Primary Owner role in your Claude organization, to view and edit the configuration
* Network access to `api.anthropic.com`

## Choose between server-managed and endpoint-managed settings

Claude Code supports two approaches for centralized configuration. Server-managed settings deliver configuration from Anthropic's servers. [Endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) are deployed directly to devices through native OS policies (macOS managed preferences, Windows registry) or managed settings files.

| Approach                                                                  | Best for                                                 | Security model                                                                                                |
| :------------------------------------------------------------------------ | :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **Server-managed settings**                                               | Organizations without MDM, or users on unmanaged devices | Settings that Claude Code fetches from Anthropic's servers at startup and refreshes hourly during the session |
| **[Endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms)** | Organizations with MDM or endpoint management            | Settings deployed to devices via MDM configuration profiles, registry policies, or managed settings files     |

If your devices are enrolled in an MDM or endpoint management solution, endpoint-managed settings provide stronger security guarantees because the settings file can be protected from user modification at the OS level. Endpoint-managed settings don't reach [cloud sessions](/docs/en/model-config#surface-coverage) in Anthropic-hosted environments, so organizations using Claude Code on the web should configure server-managed settings as well. Sessions in a [self-hosted environment](/docs/en/self-hosted-environments) also read the managed settings file in the runner image. The [settings precedence](#settings-precedence) below says when that file applies.

## Configure server-managed settings

<Steps>
  <Step title="Open the admin console">
    In the claude.ai console, go to [**Admin Settings > Claude Code > Managed settings**](https://claude.ai/admin-settings/claude-code).

    If the link redirects you to a different Admin Settings page instead of the Claude Code page, your account doesn't have the required role. Admin and other non-Owner roles can't view or edit managed settings, so ask an Owner or Primary Owner in your organization to make the change. See [Access control](#access-control).
  </Step>

  <Step title="Define your settings">
    Add your configuration as JSON. All [settings available in `settings.json`](/docs/en/settings-reference#all-settings) are supported except those restricted to OS-level policy delivery; see [Current limitations](#current-limitations) for that short list. This includes [hooks](/docs/en/hooks), [environment variables](/docs/en/env-vars), and [managed-only settings](/docs/en/managed-settings#managed-only-settings) like `allowManagedPermissionRulesOnly`.

    This example enforces a permission deny list, prevents users from bypassing permissions, and restricts permission rules to those defined in managed settings:

    ```json theme={null}
    {
      "permissions": {
        "deny": [
          "Bash(curl *)",
          "Read(./.env)",
          "Read(./.env.*)",
          "Read(./secrets/**)"
        ],
        "disableBypassPermissionsMode": "disable"
      },
      "allowManagedPermissionRulesOnly": true
    }
    ```

    Hooks use the same format as in `settings.json`.

    This example runs an audit script after every file edit across the organization:

    ```json theme={null}
    {
      "hooks": {
        "PostToolUse": [
          {
            "matcher": "Edit|Write",
            "hooks": [
              { "type": "command", "command": "/usr/local/bin/audit-edit.sh" }
            ]
          }
        ]
      }
    }
    ```

    Because hooks execute shell commands, users in interactive sessions see a [security approval dialog](#security-approval-dialogs) before Claude Code applies them.

    To configure the [auto mode](/docs/en/permission-modes#eliminate-prompts-with-auto-mode) classifier so it knows which repos, buckets, and domains your organization trusts, deliver an `autoMode` block the same way; see [Configure auto mode](/docs/en/auto-mode-config) for how the `autoMode` entries affect what the classifier blocks and important warnings about the `environment`, `allow`, `soft_deny`, and `hard_deny` fields.
  </Step>

  <Step title="Save and deploy">
    Save your changes. Claude Code clients receive the updated settings on their next startup or hourly polling cycle.
  </Step>
</Steps>

### Verify settings delivery

To confirm that settings are being applied, ask a user to restart Claude Code. If the configuration includes settings that trigger the [security approval dialog](#security-approval-dialogs), the user sees a prompt describing the managed settings the next time Claude Code fetches them: at the next start, or within an hour in a running interactive session. You can also verify that managed permission rules are active by having a user run `/permissions` to view their effective permission rules.

To check the fetch outcome on a specific machine, have the user run `claude doctor` and read the `Managed settings (remote)` line. Requires Claude Code v2.1.248 or later. The line reports one of four outcomes:

* The delivered settings loaded
* Your organization has no server-managed settings configured
* The fetch failed, with the cause and whether a cached policy still applies
* Claude Code skipped the fetch, with the reason. See [Platform availability](#platform-availability) for the providers and configurations that skip it

While the fetch is still in progress, the line reports that instead.

In a running session, `/status` shows the same line after a failed fetch, and for some skipped-fetch causes, such as a third-party provider variable or a custom `ANTHROPIC_BASE_URL` exported in the user's shell.

### Access control

The following roles can manage server-managed settings:

* **Primary Owner**
* **Owner**

Restrict access to trusted personnel, as settings changes apply to all users in the organization.

### Managed-only settings

Most [settings keys](/docs/en/settings-reference#all-settings) work in any scope. A handful of keys are only read from managed settings and have no effect when placed in user or project settings files. See [managed-only settings](/docs/en/managed-settings#managed-only-settings) for the permission and plugin controls, or read the Scope column of the [All settings](/docs/en/settings-reference#all-settings) index for the full set.

### Current limitations

Server-managed settings have the following limitations:

* Settings apply uniformly to all users in the organization. Per-group configurations are not yet supported.
* A [`managed-mcp.json`](/docs/en/managed-mcp) file can't be distributed through server-managed settings. Deliver the `allowedMcpServers` and `deniedMcpServers` policy keys there instead. Claude Code reads a `managed-mcp.json` deployed at its [system path](/docs/en/managed-mcp#exclusive-control-with-managed-mcp-json) separately from the managed settings tier, so the file still applies when server-managed settings are in effect.
* Settings restricted to OS-level policy sources, such as `policyHelper` and `wslInheritsWindowsSettings`, aren't honored. Deploy them through MDM or a system `managed-settings.json` file instead. A `policyHelper` deployed that way runs only when its source is the one selected under [precedence within the managed tier](/docs/en/managed-settings#precedence-within-the-managed-tier).

## Settings delivery

### Settings precedence

Server-managed settings and [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) both occupy the highest tier in the Claude Code [settings hierarchy](/docs/en/settings#settings-precedence). No other settings level can override them, including command line arguments, apart from the [exceptions to managed settings precedence](/docs/en/settings#exceptions-to-managed-settings-precedence).

Within the managed tier, Claude Code by default uses the first source that delivers at least one policy key, checking server-managed settings first and then endpoint-managed settings, apart from the [exception keys covered next](#per-key-exceptions-across-managed-sources). [How Claude Code combines managed sources](/docs/en/managed-settings#precedence-within-the-managed-tier) has the full ranking, the carve-out for the control keys, and the opt-in that applies every source.

If the selected source is an MDM policy or managed settings file whose [`policyHelper`](/docs/en/settings-reference#policyhelper) supplies managed settings, the helper's output replaces that source as the only managed configuration for the run. Claude Code doesn't consult a `policyHelper` configured in MDM or file-based settings while server-managed settings deliver a policy key.

If you clear your server-managed configuration in the admin console with the intent of falling back to an endpoint-managed plist or registry policy, be aware that [cached settings](#fetch-and-caching-behavior) persist on client machines until the next successful fetch, and the keys that [apply only at the next launch](#fetch-and-caching-behavior), such as `model`, stay in effect until each client relaunches. Run `/status` to see which managed source is active.

### Per-key exceptions across managed sources

Two kinds of keys are exceptions to the no-merge rule:

* **Cross-source lock keys**: a small set of keys, such as the sandbox allowlist locks, [listed on the managed settings page](/docs/en/managed-settings#precedence-within-the-managed-tier). They are honored when any admin-controlled managed source sets them; the user-writable HKCU registry tier is excluded, and when a [`policyHelper`](/docs/en/settings-reference#policyhelper) supplies managed settings, its output is the only source these checks read. The startup [`forceRemoteSettingsRefresh`](#enforce-fail-closed-startup) check runs before the helper and reads any admin source.
* **The `env` block**: apart from the telemetry unit and routing variables paired with a credential key, both covered below, it merges per key across the admin-controlled sources. For each environment variable, the highest-priority source defining it wins, and lower admin sources fill in variables the higher sources leave unset. An endpoint-managed `env` entry therefore applies whenever the server-managed configuration leaves that variable unset, or while a cached server value for it is [withheld pending server confirmation](#fetch-and-caching-behavior). Requires Claude Code v2.1.223 or later. Before v2.1.223, Claude Code applies the selected source's whole `env` block only.
  * **Telemetry unit**: the `OTEL_EXPORTER_OTLP_*` exporter keys, the `OTEL_LOG_*` content-capture toggles, `OTEL_LOGS_EXPORTER`, and the beta tracing variables `ENABLE_BETA_TRACING_DETAILED` and `BETA_TRACING_ENDPOINT` follow the highest source that sets any of them as a unit. A source that delivers the `otelHeadersHelper` credential key claims the unit too, but lands these variables only when it is the selected source: a source that isn't selected but delivers the key contributes none of them and still blocks lower sources from filling them in. Either way, an exporter endpoint from one source can never pair with credentials from another.
  * **Credential-paired routing**: a source that pairs routing variables with a selected-source-only credential key, such as `apiKeyHelper` or `otelHeadersHelper`, contributes those routing variables only when it wins the slot.

### Fetch and caching behavior

Claude Code fetches settings from Anthropic's servers at startup and polls for updates hourly during active sessions.

A client signed in through a [Claude apps gateway](#platform-availability) fetches its settings from the gateway and waits for that fetch before the session starts, so the fetch in the lists below doesn't apply to it. [Enforce fail-closed startup](#enforce-fail-closed-startup) covers what happens when that fetch fails.

**First launch without cached settings:**

* When a developer signs in at startup, such as on a first run or after `/logout`, Claude Code waits up to five seconds for the fetch before it opens the session. When the policy arrives in time, Claude Code enforces it from the first screen and shows your [`companyAnnouncements`](/docs/en/settings-reference#companyannouncements) on it. When the payload needs [security approval](#security-approval-dialogs), Claude Code ends the wait and applies the payload once the developer approves
* In any other startup, and when that five-second wait runs out, Claude Code opens the session while the fetch continues, so a brief window passes before the settings load and the restrictions take effect
* If the fetch fails, Claude Code continues without server-managed settings and warns in interactive sessions that no remote policy applies; endpoint-managed settings still apply. If a managed source sets [`forceRemoteSettingsRefresh`](#enforce-fail-closed-startup), Claude Code exits instead

**Subsequent launches with cached settings:**

* Cached settings apply immediately at startup, except for the withheld environment variables described below
* A cached [`modelPricing`](/docs/en/settings-reference#modelpricing) doesn't apply until the session's fetch confirms the payload. Until then, the cost figures developers see in `/usage` and the status line are at list price
* Claude Code fetches fresh settings in the background
* Cached settings persist through network failures. If the startup fetch fails, Claude Code warns in interactive sessions that the cached policy is in effect
* Until a fetch succeeds, the withheld environment variables remain withheld and cost figures stay at list price

Claude Code withholds several categories of variables in the cached `env` block until the server confirms the payload for the session. This keeps a cached proxy, certificate authority, endpoint, or credential value from redirecting, intercepting, or re-authenticating the settings fetch that confirms the payload. The hardening applies only to the server-fetched settings cache: [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) deployed through MDM or `managed-settings.json` are unaffected. The withholding requires Claude Code v2.1.198 or later; before v2.1.198, the whole cached `env` block applies at startup. The withheld categories include:

* Proxy and TLS configuration, such as `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and the mTLS client certificate variables `CLAUDE_CODE_CLIENT_CERT` and `CLAUDE_CODE_CLIENT_KEY`
* API routing and provider selection, including `ANTHROPIC_BASE_URL`, the provider selection variables such as `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`, and the provider endpoint URLs such as `ANTHROPIC_BEDROCK_BASE_URL`
* Authentication credentials, such as `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`
* The configuration-directory selector `CLAUDE_CONFIG_DIR`
* Credential-source and configuration-directory selectors, in Claude Code v2.1.223 or later: the Workload Identity Federation variables such as `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_IDENTITY_TOKEN`, the profile and configuration-directory selectors `ANTHROPIC_PROFILE` and `ANTHROPIC_CONFIG_DIR`, and the operating-system directory variables `HOME`, `XDG_CONFIG_HOME`, `APPDATA`, and `USERPROFILE`

Claude Code reads the Workload Identity Federation variables and the `ANTHROPIC_PROFILE` and `ANTHROPIC_CONFIG_DIR` selectors only at startup, so a server-delivered value for them doesn't switch the session's credential source even after the fetch succeeds. To deliver those selectors on Claude Code v2.1.223 or later, use [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) such as MDM or `managed-settings.json`. For `CLAUDE_CONFIG_DIR` and the operating-system directory variables, the withholding itself is the protection: the cached value stays out of the environment until the server confirms the payload.

Every other key in the cached `env` block, such as telemetry and OpenTelemetry configuration, applies at startup as before. Once the server confirms the payload, and you approve it if it needs [security approval](#security-approval-dialogs), the withheld variables apply for the rest of the session; the startup-only selectors covered above reach the environment but don't switch the running session's credential source.

If your organization needs a proxy to reach `api.anthropic.com`, the withholding only affects the server-delivered `env` block itself: a proxy set in an [endpoint-managed](/docs/en/managed-settings#delivery-mechanisms) `env` block through MDM or `managed-settings.json`, in the shell environment, or in [user settings](/docs/en/settings#where-settings-live) reaches the settings fetch. The endpoint-managed source requires Claude Code v2.1.223 or later: the cached server-managed proxy value is withheld until the fetch confirms it, so the endpoint-managed value fills in per key and reaches the fetch itself. Before v2.1.223, use the shell environment or user settings so the proxy applies alongside a cached server payload. The first launch has no cache, so an endpoint-managed source, the shell environment, or user settings is still required for the initial fetch.

Claude Code applies most settings updates to running sessions without a restart. Some updates apply only at the next launch, including OpenTelemetry exporter configuration, the `model` key, and the removal of a variable from the `env` block.

### Invalid entries in delivered settings

When part of a payload fails schema validation, Claude Code surfaces a validation error and applies every remaining valid setting; [Invalid entries in managed settings](/docs/en/managed-settings#invalid-entries-in-managed-settings) says what it drops and which keys fall back to a stricter value. Requires Claude Code v2.1.169 or later.

Server-managed delivery adds these behaviors:

* The cache at `~/.claude/remote-settings.json` stores the salvaged payload with invalid entries removed, apart from invalid `cleanupPeriodDays` and `desktopSessionCleanupPeriodDays` values, which stay in the cached copy and are never applied.
* When no field in the payload can be salvaged and the payload isn't only those retention keys, Claude Code rejects the payload, keeps the last-accepted cached settings, and writes `Remote settings: Settings validation failed - no fields could be salvaged` to the debug log. With `forceRemoteSettingsRefresh` set, the CLI exits instead.
* The [security approval dialog](#security-approval-dialogs) evaluates the salvaged payload, so a stripped invalid entry is never presented for approval and never executes.

To debug delivery issues, run `claude --debug-file <path>` and search the log for `Remote settings`. Validate a payload change with `claude doctor` on a test machine before rolling it out to the organization.

### Enforce fail-closed startup

By default, if the remote settings fetch fails at startup, the CLI continues with the settings cached from the last successful fetch, except for the [withheld environment variables](#fetch-and-caching-behavior), or without server-managed settings on a machine that has never fetched them. With no cache, Claude Code still applies any [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) on the device. For environments where either window is unacceptable, set `forceRemoteSettingsRefresh: true` in your managed settings. Clients signed in through a [Claude apps gateway](#platform-availability) exit when the startup fetch fails, without this setting.

When this setting is active in a session that fetches server-managed settings, the CLI blocks at startup until remote settings are freshly fetched. If the fetch fails, the CLI exits rather than proceeding without the policy. This setting self-perpetuates: once delivered from the server, it is also cached locally so that subsequent startups enforce the same behavior even before the first successful fetch of a new session. A session that [doesn't fetch server-managed settings](#platform-availability) starts without waiting.

To enable this, add the key to your managed settings configuration:

```json theme={null}
{
  "forceRemoteSettingsRefresh": true
}
```

You can also set this key in an [endpoint-managed](/docs/en/managed-settings#delivery-mechanisms) MDM profile or system `managed-settings.json` file to enforce fail-closed behavior on first launch, before any server payload has been delivered. In Claude Code v2.1.191 or later, this flag is an exception to the [precedence rule](#settings-precedence) above: it is honored when set in any admin-controlled managed source even if a cached server-managed payload is also present, so an MDM-delivered value is not ignored when server-managed settings exist. When a [`policyHelper`](/docs/en/settings-reference#policyhelper) supplies managed settings, its output replaces every other managed source for the keys Claude Code reads after startup; the startup fail-closed check itself reads this key from any admin-controlled source before the helper runs. The entry says which sources Claude Code reads the helper from and when it runs.

The settings fetch also sends a `Cache-Control: no-cache` header so intermediate HTTP proxies don't serve a stale response.

Before enabling this setting, ensure your network policies allow connectivity to `api.anthropic.com`. If that endpoint is unreachable, the CLI exits at startup and users cannot start Claude Code.

The `claude auth` subcommands such as `claude auth login` are exempt from this check and from the gateway startup exit, so users can re-authenticate when expired credentials are the reason the settings fetch fails.

### Security approval dialogs

Certain settings that could pose security risks require explicit user approval before Claude Code applies them in an interactive session:

* **Shell command settings**: settings that execute shell commands, such as `apiKeyHelper`, `statusLine`, and `otelHeadersHelper`
* **Sandbox binary settings**: `sandbox.bwrapPath`, `sandbox.socatPath`, and `sandbox.ripgrep`. Each of these settings points at an executable, and Claude Code runs that executable
* **Sandbox network and isolation settings**: [sandbox](/docs/en/sandboxing) settings that let the sandbox proxy read, reroute, or authenticate traffic, or that weaken the sandbox's isolation: `sandbox.network.tlsTerminate`, `sandbox.network.httpProxyPort`, `sandbox.network.socksProxyPort`, `sandbox.credentials`, `sandbox.allowAppleEvents`, `sandbox.enableWeakerNestedSandbox`, `sandbox.enableWeakerNetworkIsolation`, `sandbox.filesystem.disabled`, `sandbox.network.allowAllUnixSockets`, `sandbox.network.allowUnixSockets`, and `sandbox.network.allowMachLookup`. A `sandbox.credentials` block that contains only `deny` rules doesn't need approval, since it restricts the sandbox without giving the proxy a credential. Before v2.1.251, Claude Code applied these settings without approval
* **Custom environment variables**: delivered `env` variables that require the user's approval, such as proxy and base-URL variables; see [Environment variables and the approval dialog](#environment-variables-and-the-approval-dialog)
* **Hook configurations**: any hook definition
* **Managed CLAUDE.md content**: a `claudeMd` value delivered through managed settings

When these settings are present, users see a security dialog explaining what is being configured. Users must approve to proceed. If a user rejects the settings, Claude Code exits.

#### Approval memory

Claude Code records your approval in your configuration directory, `~/.claude` unless you set [`CLAUDE_CONFIG_DIR`](/docs/en/env-vars). What it records depends on the credential the settings fetch uses:

* **A claude.ai login saved by `/login` or `claude auth login`**: one approval per organization, held by the account that approved most recently.
* **A [Claude apps gateway](/docs/en/claude-apps-gateway) sign-in**: one approval per gateway.

  If you sign out and back in to the same gateway, Claude Code doesn't show the dialog again while the settings that require approval are unchanged. Claude Code shows it again when those settings change, when you sign in to a different gateway, and when you accept a new certificate for the same gateway.

  Claude Code saves no approval for a loopback development gateway reached over plain HTTP, so the dialog appears again after each sign-in.
* **Any other credential**, such as an API key or `CLAUDE_CODE_OAUTH_TOKEN`: one approval for the delivered settings, kept with the cached copy of the settings in that configuration directory. Claude Code shows the dialog again when the settings that require approval change, and after you run `/logout` or `claude auth logout`, either of which deletes the cached copy.

With a saved claude.ai login:

* If you sign out and back in, or switch to another organization and later return, Claude Code doesn't show the dialog again while those settings are unchanged, unless another account approved them for that organization in the same configuration directory in between.
* If you sign in to the same organization with a different account, Claude Code shows the dialog again even when the settings are unchanged. That account's approval replaces the previous one, so when you switch back, Claude Code shows the dialog once more.

Claude Code can't always show the dialog. Each case below says which settings apply when it can't and when you next see the dialog:

* **An interactive session that can't show the dialog**: Claude Code doesn't apply the delivered settings and keeps the last-approved settings. The dialog appears in the next session that can show it. Requires Claude Code v2.1.211 or later.
* **`claude install` or `claude update`**: Claude Code doesn't show the dialog during either command. The command runs with the last-approved settings, and the dialog appears in your next interactive session. If Claude Code waits for the settings fetch at startup, such as with [`forceRemoteSettingsRefresh`](#enforce-fail-closed-startup) set or on a [Claude apps gateway](/docs/en/claude-apps-gateway) deployment, it shows the dialog during the command instead, and an install run from a pipe fails; see [`Raw mode is not supported` during install](/docs/en/troubleshoot-install#raw-mode-is-not-supported-during-install). Before v2.1.246, Claude Code tried to show the dialog during these commands too.
* **An error closes the dialog before you answer**: Claude Code doesn't apply the delivered settings and keeps the last-approved settings. It shows the dialog again in the next session that can show it.
* **A non-interactive run**, such as `claude -p` or an Agent SDK session: Claude Code can't show the dialog, so when the delivered settings would require approval, it applies them for that run only. It doesn't record them as approved or write them to the [local cache](#fetch-and-caching-behavior), and the next interactive session shows the dialog. Until a user approves in an interactive session, each non-interactive run fetches the settings again at startup. Before v2.1.207, a non-interactive run saved the settings as approved, so later interactive sessions never showed the dialog for them.

#### Environment variables and the approval dialog

Claude Code applies some delivered `env` variables without showing the user the approval dialog, including:

* Feature and command toggles
* Model selection and behavior settings, such as `ANTHROPIC_MODEL`, `DISABLE_PROMPT_CACHING`, and `CLAUDE_CODE_EFFORT_LEVEL`
* Context window and compaction settings, such as `DISABLE_AUTO_COMPACT`
* Terminal UI and accessibility options
* Numeric limits, budgets, and timeouts

Other delivered variables can require the user's approval before they take effect; a non-empty proxy, base-URL, or `OTEL_EXPORTER_OTLP_ENDPOINT` value always does. When a delivered variable needs approval, the dialog names it, so the user sees exactly what the policy is asking to set. Before v2.1.218, Claude Code applied fewer variables without asking the user, so settings such as `DISABLE_AUTO_COMPACT` triggered the dialog at any non-empty value.

Claude Code decides whether four privacy toggles need approval by the delivered value rather than by the variable name: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_ERROR_REPORTING`, `DISABLE_TELEMETRY`, and `DO_NOT_TRACK`. A truthy value such as `1` or `true` only turns tracking, reporting, or other nonessential traffic off, so Claude Code applies it without asking the user. For any other non-empty value, Claude Code shows the dialog. Before v2.1.218, all of them except `DO_NOT_TRACK` applied without approval at any value, and `DO_NOT_TRACK` triggered the dialog at any non-empty value.

Claude Code also decides whether [`API_FORCE_IDLE_TIMEOUT`](/docs/en/env-vars) needs approval by the delivered value: a truthy value only turns the [body idle timeout](/docs/en/network-config#streaming-idle-watchdogs) on, so Claude Code applies it without asking the user. For any other non-empty value, Claude Code shows the dialog. Before v2.1.248, any non-empty value triggered the dialog.

Whether [`ANTHROPIC_CUSTOM_HEADERS`](/docs/en/env-vars#variables) needs approval also depends on the delivered value. Headers that only tag requests, such as `Accept-Language`, apply without the dialog. A line that names a credential, an org or tenant selector, a routing or host override, or an API-behavior header, such as `Authorization`, `X-Api-Key`, `Host`, `anthropic-beta`, or the `X-Amzn-Bedrock-*` headers, requires approval. So does a line whose name isn't a valid HTTP header token, or whose value contains a character an HTTP header can't carry. The check matches words inside the header name, so `X-Client-Version`, which contains `client` and `version`, requires approval too. Before v2.1.251, any `ANTHROPIC_CUSTOM_HEADERS` value applied without it.

## Platform availability

Server-managed settings require a direct connection to `api.anthropic.com`, and delivery requires the session to authenticate with a Team or Enterprise OAuth login, an OAuth token supplied through `CLAUDE_CODE_OAUTH_TOKEN`, or a directly configured API key. Keys returned by an [`apiKeyHelper`](/docs/en/settings-reference#apikeyhelper) script don't trigger the settings fetch.

In a [Cowork](https://claude.com/docs/cowork/overview) session in the Claude Desktop app, Claude Code doesn't fetch server-managed settings from the claude.ai admin console, even when the user signs in with a Team or Enterprise account. [Where and when a policy applies](/docs/en/managed-settings#where-and-when-a-policy-applies) covers which policy reaches Cowork sessions on the user's machine and remote Cowork sessions.

If you export a `CLAUDE_CODE_USE_*` provider variable or a non-default `ANTHROPIC_BASE_URL` in your shell, Claude Code skips the settings fetch for your sessions. [`claude doctor` and `/status` report the skipped fetch and its cause](#verify-settings-delivery).

You can't clear the export with a server-managed `env` block, because the block arrives through the fetch that the export prevents. An [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) `env` block doesn't restore the fetch either: Claude Code checks eligibility before it applies managed `env` blocks, so the endpoint-managed value changes the session's provider selection but the fetch stays skipped.

To restore server-managed delivery, remove the export from your shell, or set the variable to `""` in your user settings `env` block, which applies before the eligibility check. To enforce policy without relying on users to change their shells, deliver the settings through the endpoint-managed channel instead.

For Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and [Claude Platform on AWS](/docs/en/claude-platform-on-aws) deployments, a self-hosted [Claude apps gateway](/docs/en/claude-apps-gateway) provides the equivalent remote managed-settings delivery: gateway-signed-in clients fetch managed settings from the gateway instead of `api.anthropic.com`. The failure semantics differ at startup: a gateway client that can't reach the gateway exits with an error instead of falling back to cached settings, while the hourly background refresh is fail-open on both channels.

## Audit logging

Audit log events for settings changes are available through the compliance API or audit log export. Contact your Anthropic account team for access.

Audit events include the type of action performed, the account and device that performed the action, and references to the previous and new values.

## Security considerations

Server-managed settings provide centralized policy enforcement, but they operate as a client-side control, not a security boundary. On unmanaged devices, a user doesn't need admin or sudo access to bypass them.

| Scenario                                                               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User edits the cached settings file                                    | Tampered file applies at startup, and the next server fetch restores the correct settings, except for the [keys that apply only at the next launch](#fetch-and-caching-behavior), such as `model` or a variable added to the `env` block, which stay in effect until relaunch. In Claude Code v2.1.198 or later, the [withheld environment variables](#fetch-and-caching-behavior) in the `env` block don't apply until the server confirms the payload. In Claude Code v2.1.242 or later, a cached [`modelPricing`](/docs/en/settings-reference#modelpricing) doesn't apply until the server confirms the payload either, so cost figures are at list price until then                                                                                                                                                                                                                                                                                            |
| User deletes the cached settings file                                  | [First-launch behavior](#fetch-and-caching-behavior) occurs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| User runs a modified Claude Code binary                                | A user who can run a modified client can bypass any client-side control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| User runs an older Claude Code version                                 | Versions that predate server-managed settings don't fetch or apply them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| API is unavailable                                                     | Cached settings apply if available. Without a cache, Claude Code enforces no server-managed settings until the next successful fetch and still applies any [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) on the device. In Claude Code v2.1.198 or later, the [withheld environment variables](#fetch-and-caching-behavior) in the cached `env` block don't apply on fetch failure. In Claude Code v2.1.242 or later, a cached [`modelPricing`](/docs/en/settings-reference#modelpricing) doesn't apply on fetch failure either, so cost figures stay at list price until a fetch succeeds. The rest of the cache still applies. With `forceRemoteSettingsRefresh: true`, the CLI exits instead of continuing, except for [`claude auth` subcommands](#enforce-fail-closed-startup). Clients signed in through a [Claude apps gateway](#platform-availability) exit at startup without that setting, with the same `claude auth` exemption |
| User authenticates with a different organization                       | Settings are not delivered for accounts outside the managed organization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| User configures a [third-party model provider](#platform-availability) | Server-managed settings are bypassed. This includes setting `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, or a non-default `ANTHROPIC_BASE_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Network traffic is intercepted or redirected                           | Disabled TLS validation or intercepted traffic can alter the settings the client receives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

To log edits to local settings files, including `managed-settings.json`, use [`ConfigChange` hooks](/docs/en/hooks#configchange). Claude Code doesn't run them when server-managed settings arrive or refresh, or when an MDM profile or registry policy changes, and a hook can't block a `policy_settings` change.

To restrict which organizations your users can access with credentials the client supplies, see [Enforce network-level access control with Tenant Restrictions](https://support.claude.com/en/articles/13198485-enforce-network-level-access-control-with-tenant-restrictions) in the Claude Help Center. For stronger enforcement guarantees, use [endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms) on devices enrolled in an MDM solution.

## See also

Related pages for managing Claude Code configuration:

* [Settings reference](/docs/en/settings-reference): every settings key
* [Endpoint-managed settings](/docs/en/managed-settings#delivery-mechanisms): managed settings deployed to devices by IT
* [Authentication](/docs/en/authentication): set up user access to Claude Code
* [Security](/docs/en/security): security safeguards and best practices
