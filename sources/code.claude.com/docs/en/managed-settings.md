> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Deploy managed settings

> Deploy managed settings to every developer's machine: delivery mechanisms per OS, how Claude Code combines managed sources, and how to verify enforcement.

Managed settings are the settings your organization deploys to every developer's machine. Claude Code applies them above every other level, so no user, project, local, or `--settings` value overrides them, apart from a few [security-sensitive exceptions](/docs/en/settings#exceptions-to-managed-settings-precedence) where a stricter value from a lower level still counts.

This page is for the administrator who deploys managed settings or debugs why one isn't applying. To decide what to enforce, start with the [Decide what to enforce](/docs/en/admin-setup#decide-what-to-enforce) table. For the claude.ai console path, see [Server-managed settings](/docs/en/server-managed-settings). For which file a developer's own values go in, see [Settings](/docs/en/settings).

## Deploy a managed settings file

This is the quickest way to put a policy on each machine: a `managed-settings.json` file. If you haven't picked how to deliver managed settings yet, or your devices are under MDM or developers run cloud sessions, read [Choose a delivery mechanism](#choose-a-delivery-mechanism) first.

<Steps>
  <Step title="Write managed-settings.json">
    Write a `managed-settings.json` that holds the keys you've decided to enforce, in the same JSON shape as `settings.json`. The [Decide what to enforce](/docs/en/admin-setup#decide-what-to-enforce) table lists the keys behind each control, and each entry in the [settings reference](/docs/en/settings-reference) says whether a managed source can set it. This file blocks two file reads, turns off bypass mode, and makes Claude Code ignore permission rules from user, project, and local files and from `--allowedTools`:

    ```json managed-settings.json theme={null}
    {
      "permissions": {
        "deny": [
          "Read(./.env)",
          "Read(./secrets/**)"
        ],
        "disableBypassPermissionsMode": "disable"
      },
      "allowManagedPermissionRulesOnly": true
    }
    ```

    For a fuller example that shows the shape of more managed keys, including the login method, models, MCP servers, and marketplaces, see [An organization's managed settings](/docs/en/settings-example#an-organizations-managed-settings).
  </Step>

  <Step title="Place the file on each machine">
    Save the file as `managed-settings.json` in the system directory for the operating system, using whatever tooling already places files on your fleet:

    * **macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json`
    * **Linux and WSL**: `/etc/claude-code/managed-settings.json`
    * **Windows**: `C:\Program Files\ClaudeCode\managed-settings.json`
  </Step>

  <Step title="Confirm the policy applied">
    On one machine, run `/status` inside Claude Code. The `Setting sources` line shows `Enterprise managed settings (file)`. Roll out to the rest of the fleet after that; [Check that a policy is in force](#check-that-a-policy-is-in-force) covers what to look at when the line is missing.
  </Step>
</Steps>

<span id="managed-settings-delivery" />

<span id="delivery-mechanisms" />

## Choose a delivery mechanism

The file in the steps above is one of four ways to get managed settings onto a machine. Every mechanism carries the same policy keys as a `settings.json` file, so the [settings reference](/docs/en/settings-reference) applies to all of them. A few keys are tied to particular sources, and each entry's Scope line says which:

* **Delivery controls**: [`policyHelper`](/docs/en/settings-reference#policyhelper), [`wslInheritsWindowsSettings`](/docs/en/settings-reference#wslinheritswindowssettings), and [`managedSourcesBehavior`](/docs/en/settings-reference#managedsourcesbehavior)
* **Gateway login keys**: [`forceLoginGatewayUrl`](/docs/en/settings-reference#forcelogingatewayurl) and the `"gateway"` value of [`forceLoginMethod`](/docs/en/settings-reference#forceloginmethod)

A managed settings file, an MDM profile, or the claude.ai console applies one policy to everyone it reaches. To give one group of developers a different policy, deploy a different file or profile to that group; the claude.ai console [can't target a group yet](/docs/en/server-managed-settings#current-limitations), while a self-hosted [Claude apps gateway](/docs/en/claude-apps-gateway) delivers managed settings per IdP group.

When more than one mechanism delivers a policy to the same machine, Claude Code by default uses one and ignores the others. [How Claude Code combines managed sources](#how-claude-code-combines-managed-sources) gives the order and the opt-in that applies every source.

The MDM and file rows are together called endpoint-managed settings, because the policy is stored on the developer's device, as opposed to the server-managed row, where Claude Code fetches it.

Pick a mechanism by how you already manage devices, using the table below.

| Mechanism                                              | How you deliver it                                                                                                                                                                                                | When Claude Code reads it                                                                                                                                                                                                                | Use it when                                                                                    |
| :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| [Server-managed settings](/docs/en/server-managed-settings) | In the claude.ai admin console, or on a self-hosted [Claude apps gateway](/docs/en/claude-apps-gateway)                                                                                                                | Fetched at startup and polled hourly; see [changes that need approval](#where-and-when-a-policy-applies)                                                                                                                                 | You want one place to change policy for a claude.ai organization without touching each machine |
| MDM or OS-level policy                                 | As a macOS configuration profile or a Windows `HKLM` registry value, through Jamf, Intune, Group Policy, or a similar tool; see [where each mechanism stores the policy](#where-each-mechanism-stores-the-policy) | Read at startup and checked for changes every 30 minutes                                                                                                                                                                                 | You already manage devices with MDM or Group Policy                                            |
| File-based                                             | As `managed-settings.json` in a system directory on each machine; see [where each mechanism stores the policy](#where-each-mechanism-stores-the-policy)                                                           | Read at startup and reloaded when a file changes                                                                                                                                                                                         | Machines without MDM, Linux hosts, or images you build yourself                                |
| HKCU registry, Windows and WSL                         | As a Windows `HKCU` registry value; see [where each mechanism stores the policy](#where-each-mechanism-stores-the-policy)                                                                                         | Read at startup and checked for changes every 30 minutes; Claude Code uses it only when no other managed source delivers a policy key and no [host-supplied parent settings](#let-an-embedding-host-add-policy) supply a restrictive key | You can't write the machine-level `HKLM` key                                                   |

Starter templates for Jamf, Iru, Intune, and Group Policy are in the [MDM examples repository](https://github.com/anthropics/claude-code/tree/main/examples/mdm).

For managed MCP servers, which you deploy alongside any of these through `managed-mcp.json`, see [Managed MCP configuration](/docs/en/managed-mcp).

### Where and when a policy applies

A deployed policy reaches the developer's sessions as follows:

* **Surfaces**: on the developer's machine, the terminal, the VS Code and JetBrains extensions, the desktop app's Code tab, and [Agent SDK](/docs/en/agent-sdk/typescript) sessions read all of these sources. Agent SDK sessions load managed settings even when `settingSources` excludes the user, project, and local files.
* **Cloud sessions**: a session in an Anthropic-hosted environment doesn't read a device's MDM profile or file, so policy for it has to come from server-managed settings. A session in a [self-hosted environment](/docs/en/self-hosted-environments) also reads the managed settings file in its runner image, by default only when server-managed settings deliver no policy key, apart from the [keys Claude Code reads from every admin source](#keys-read-from-every-admin-source). [How Claude Code combines managed sources](#how-claude-code-combines-managed-sources) covers the opt-in that applies both.
* **Cowork sessions**: [Cowork](https://claude.com/docs/cowork/overview) in the Claude Desktop app runs its sessions on Claude Code. In a Cowork session, Claude Code never fetches server-managed settings from the claude.ai admin console, even when the user signs in with a Team or Enterprise account, so which policy applies depends on where the session runs:

  * **On the user's machine**: by default, Claude Code in a Cowork session reads the MDM or OS-level policy and the managed settings file on that device, so deploy policy there.
  * **In a full VM sandbox**: when your Claude Desktop managed configuration sets [`requireCoworkFullVmSandbox`](https://claude.com/docs/third-party/claude-desktop/configuration#requirecoworkfullvmsandbox), Claude Code runs inside a virtual machine where the device's MDM policy and managed settings file aren't present.
  * **Remote Cowork sessions**: these run on Anthropic-managed VMs, where Claude Code has no device policy to read.

  The [surface coverage](/docs/en/model-config#surface-coverage) table compares Cowork with the other surfaces.
* **Running sessions**: a session picks up most changes on the schedule in the table without a restart. Claude Code reads [`forceRemoteSettingsRefresh`](/docs/en/settings-reference#forceremotesettingsrefresh) and [`requiredMinimumVersion`](/docs/en/settings-reference#requiredminimumversion) only at session start, arms a new or changed [`policyHelper`](/docs/en/settings-reference#policyhelper) entry at the next launch, and reads [some user-editable keys once at session start](/docs/en/settings#when-edits-take-effect).
* **Changes that need approval**: apart from the [updates that wait for the next launch](/docs/en/server-managed-settings#fetch-and-caching-behavior), a server-managed change to a setting that [needs approval](/docs/en/server-managed-settings#security-approval-dialogs), such as a hook or an `env` variable, waits for the developer to accept the dialog in an interactive session, and applies for the current run in a session an IDE extension or the Agent SDK hosts. Other server-managed changes apply on the next poll.
* **Long-lived sessions**: a session left open for weeks can still lag a rollout. [`requiredMinimumVersion`](/docs/en/settings-reference#requiredminimumversion) blocks an outdated binary from starting and doesn't end a session that's already running.

<span id="format-the-policy-for-each-platform" />

### Where each mechanism stores the policy

The keys are the same everywhere, but each mechanism stores them in a different place and shape:

* **Server-managed**: Anthropic's servers, or your gateway, hold the policy. Claude Code keeps a local cache that it applies at startup and [replaces on each successful fetch](/docs/en/server-managed-settings#security-considerations).
* **macOS configuration profile**: the `com.anthropic.claudecode` managed preferences domain. Use the same top-level keys as `managed-settings.json`, with nested settings as dictionaries and lists as plist arrays.
* **Windows HKLM registry**: the JSON as a `REG_SZ` or `REG_EXPAND_SZ` value named `Settings` under `HKLM\SOFTWARE\Policies\ClaudeCode`.
* **File-based**: `managed-settings.json`, an optional `managed-settings.d/` directory, and `managed-mcp.json` in the system directory: `/Library/Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux and WSL, and `C:\Program Files\ClaudeCode\` on Windows. Claude Code doesn't read the legacy Windows path `C:\ProgramData\ClaudeCode\managed-settings.json`.
* **Windows HKCU registry**: the same `Settings` value under `HKCU\SOFTWARE\Policies\ClaudeCode`.

### Split a file-based policy across teams

If several teams own parts of one policy, put each part in its own file in `managed-settings.d/`, next to `managed-settings.json` in the same system directory, instead of editing one shared file.

Claude Code merges `managed-settings.json` first, then every `*.json` file in the directory in alphabetical order. Name the files with numeric prefixes to control the order, such as `10-telemetry.json` and `20-security.json`. Claude Code ignores hidden files and files that don't end in `.json`.

When two files set the same key, Claude Code combines them by these rules:

* **Single values**, such as `"model": "opus"` or `"cleanupPeriodDays": 7`: the later file's value replaces the earlier one
* **Lists**, such as `permissions.deny` or `sandbox.network.allowedDomains`: the two lists combine, with duplicates removed
* **Nested blocks**, such as `env` or `sandbox`: the two blocks merge key by key, and each key inside follows these same rules
* **`fallbackModel`**: the later chain replaces the earlier one whole
* **[`extraKnownMarketplaces`](/docs/en/settings-reference#extraknownmarketplaces)**: a later entry with the same name replaces the earlier one whole
* **[`modelPicker`](/docs/en/settings-reference#modelpicker)**: the later lineup replaces the earlier one whole

<span id="precedence-within-the-managed-tier" />

<span id="which-managed-source-claude-code-uses" />

## How Claude Code combines managed sources

When your organization delivers more than one managed source to the same machine, the [`managedSourcesBehavior`](/docs/en/settings-reference#managedsourcesbehavior) key decides what Claude Code does with the others:

* **`"first-wins"`, the default**: Claude Code uses the highest-ranked source that delivers at least one policy key and ignores the rest rather than merging them, apart from the few keys in [Keys read from every admin source](#keys-read-from-every-admin-source). Claude Code shows no warning for the sources it skips; `/status` [names the source it used and the ones it skipped](#read-the-source-in-/status).
* **`"merge"`**: Claude Code applies every admin source that delivers a policy key and combines them by kind of key: on most keys the higher-ranked source's value applies, lists union, and locks take the strictest value. [Compose every managed source](#compose-every-managed-source) says where to set the key and how each kind of key combines. Requires Claude Code v2.1.242 or later.

Both settings rank the sources the same way. Two terms recur in this section:

* **Policy key**: any settings key other than the two control keys, [`wslInheritsWindowsSettings`](/docs/en/settings-reference#wslinheritswindowssettings) and [`managedSourcesBehavior`](/docs/en/settings-reference#managedsourcesbehavior). A managed settings file or MDM policy that contains only those doesn't count, and Claude Code moves on to the next source.
* **Admin source**: one of the first three sources below. The HKCU registry is user-writable and isn't one.

Claude Code checks the sources in this order, highest priority first:

1. Remote settings, delivered from claude.ai as [server-managed settings](/docs/en/server-managed-settings) or by a [Claude apps gateway](/docs/en/claude-apps-gateway). Claude Code fetches this source only when the session authenticates to Anthropic's API directly with an [eligible login or key](/docs/en/server-managed-settings#platform-availability), or signs in to a gateway with `/login`. On other providers, or when `ANTHROPIC_BASE_URL` points somewhere other than Anthropic's API, it starts at the next source
2. MDM or OS-level policies: the macOS plist or the HKLM registry key
3. Managed settings files, `managed-settings.d/*.json` and `managed-settings.json` merged together
4. The HKCU registry, on Windows, and on WSL once the HKLM registry or the Windows managed settings file turns [`wslInheritsWindowsSettings`](/docs/en/settings-reference#wslinheritswindowssettings) on and the HKCU value also sets it. Claude Code reads it only when no source above it delivers a policy key and no [host-supplied parent settings](#let-an-embedding-host-add-policy) supply a restrictive key

This diagram shows the ranking, with examples of the cross-source keys Claude Code reads from the first three sources under either setting:

<img src="https://mintcdn.com/claude-code/zuWID2B-Rxm8DEC8/images/managed-source-precedence.svg?fit=max&auto=format&n=zuWID2B-Rxm8DEC8&q=85&s=53f6be49f06eff48e01422c8ae1bc2e6" className="dark:hidden" alt="Diagram showing the four managed settings sources ranked from remote settings at the top through MDM, managed settings files, and the HKCU registry at the bottom. By default the first source with a policy key supplies the policy and the rest are skipped; with managedSourcesBehavior set to merge, every admin source with a policy key contributes, combined by kind of key, and the HKCU registry stays out. A side panel shows that cross-source keys such as the sandbox locks, forceRemoteSettingsRefresh, and the per-variable env merge are read from every admin source, which excludes the HKCU registry." width="680" height="330" data-path="images/managed-source-precedence.svg" />

<img src="https://mintcdn.com/claude-code/zuWID2B-Rxm8DEC8/images/managed-source-precedence-dark.svg?fit=max&auto=format&n=zuWID2B-Rxm8DEC8&q=85&s=ae407a9a08a3d680e80cf1a2af845d71" className="hidden dark:block" alt="Diagram showing the four managed settings sources ranked from remote settings at the top through MDM, managed settings files, and the HKCU registry at the bottom. By default the first source with a policy key supplies the policy and the rest are skipped; with managedSourcesBehavior set to merge, every admin source with a policy key contributes, combined by kind of key, and the HKCU registry stays out. A side panel shows that cross-source keys such as the sandbox locks, forceRemoteSettingsRefresh, and the per-variable env merge are read from every admin source, which excludes the HKCU registry." width="680" height="330" data-path="images/managed-source-precedence-dark.svg" />

### Keys read from every admin source

Under the default `"first-wins"` setting, Claude Code reads most keys only from the [source it selected](#how-claude-code-combines-managed-sources), and ignores a value in a lower-ranked source even when the selected source leaves that key unset.

A few keys work differently. Claude Code reads them from every admin source, so a lower-ranked MDM policy or managed settings file can still set them when the selected source doesn't. Claude Code leaves the user-writable HKCU registry out of that scan; when HKCU is the only source and no host supplies parent settings, HKCU applies like any selected source.

The cross-source keys include:

* `sandbox.network.allowManagedDomainsOnly` and `sandbox.filesystem.allowManagedReadPathsOnly`: a `true` in any admin source turns the lock on. While a lock is on, Claude Code unions the allowlist it locks, `sandbox.network.allowedDomains` together with `WebFetch(domain:...)` allow rules, or `sandbox.filesystem.allowRead`, across every admin source. Without the lock, Claude Code treats the allowlist like any other key, so under `"first-wins"` an unselected admin source's allowlist is ignored
* `allowAllClaudeAiMcps`
* The sandbox binary paths `sandbox.bwrapPath` and `sandbox.socatPath`
* The sandbox `ripgrep` binary, [`sandbox.ripgrep`](/docs/en/settings-reference#sandbox-ripgrep)
* `sandbox.filesystem.disabled` and `sandbox.network.strictAllowlist`
* [`useAutoModeDuringPlan`](/docs/en/settings-reference#useautomodeduringplan) and [`syncClaudeAiSkills`](/docs/en/settings-reference#syncclaudeaiskills), where a `false` from any admin source turns the behavior off. A `false` in the developer's user or local settings turns it off too; each key can only deny
* [`enableArtifact`](/docs/en/settings-reference#enableartifact), where a `false` from any admin source turns the [Artifact tool](/docs/en/artifacts) off. A `false` in the developer's user, project, or local settings turns it off too, and no source turns it back on; see [which lower-level values still count](/docs/en/settings#exceptions-to-managed-settings-precedence). Requires Claude Code v2.1.242 or later
* A commit-trailer opt-out in `attribution`, or in the deprecated `includeCoAuthoredBy`, from any tier
* [`forceRemoteSettingsRefresh`](/docs/en/server-managed-settings)
* `env`, merged per variable across the admin sources: each variable comes from the highest-priority source that defines it, so lower sources fill in variables the higher ones leave unset. A few variables follow their own rules; [Per-key exceptions across managed sources](/docs/en/server-managed-settings#per-key-exceptions-across-managed-sources) names each one. Requires Claude Code v2.1.223 or later. Before v2.1.223, Claude Code applied the selected source's whole `env` block only

### Compose every managed source

To have Claude Code apply every admin source your organization delivers, set [`managedSourcesBehavior`](/docs/en/settings-reference#managedsourcesbehavior) to `"merge"` in the highest-ranked source you deploy. Claude Code reads the key only from the highest-ranked source that carries either the key or a policy key, so a lower source can't opt itself into merging with the source above it, and a machine that never receives server-managed settings needs the key in its MDM profile too. The user-writable HKCU registry never merges with another source. Requires Claude Code v2.1.242 or later.

Under `"merge"`, Claude Code adds a lower source's list entries, such as `permissions.allow` rules and hooks, to the policy, so turn it on only when every source ranked below your highest one is under an administrator's control.

This table shows how Claude Code combines each kind of key under `"merge"`; the [`managedSourcesBehavior` entry](/docs/en/settings-reference#managedsourcesbehavior) names every key in the restriction allowlist and highest-source-only rows.

| Kind of key                                   | How Claude Code combines it                                                                                                                         | Examples                                                                                                                    |
| :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| Lists                                         | Combines the entries from every source                                                                                                              | `permissions.allow`, `hooks`, `sandbox.network.allowedDomains`, `deniedMcpServers`                                          |
| Locks                                         | Applies the strictest value any source sets; a looser value applies only from the highest-ranked source                                             | `allowManagedHooksOnly`, `permissions.disableBypassPermissionsMode`, `crossSessionInbound`                                  |
| Restriction allowlists                        | Takes the list whole from the highest-ranked source that sets it, without adding entries from lower sources                                         | `availableModels`, `allowedMcpServers`, `strictKnownMarketplaces`, `allowedChannelPlugins`, and the `fallbackModel` chain   |
| Keys read from the highest-ranked source only | Ignores the key in every lower source, even when the highest-ranked source leaves it unset                                                          | Credential helpers such as `apiKeyHelper`, login pins such as `forceLoginOrgUUID`, `modelPicker`, `permissions.defaultMode` |
| `env`                                         | Merges per variable across admin sources under either setting, as [Keys read from every admin source](#keys-read-from-every-admin-source) describes |                                                                                                                             |
| Every other key                               | Takes the value from the highest-ranked source that sets it                                                                                         | `model`, `cleanupPeriodDays`                                                                                                |

To confirm which sources combined on a machine, [read the `Setting sources` line in `/status`](#read-the-source-in-/status); that section says what each label means.

### Compute the policy with a helper program

A [`policyHelper`](/docs/en/settings-reference#policyhelper) is an executable your MDM policy or managed settings file names, and Claude Code runs it to compute managed settings at startup. When the selected source configures one and the helper emits a `managedSettings` object, that output changes what Claude Code reads:

* **The emitted `managedSettings` object is the only managed settings for the session**, including for the [keys it otherwise reads from every admin source](#keys-read-from-every-admin-source), apart from `forceRemoteSettingsRefresh`, which Claude Code checks in every admin source at startup before the helper runs. A helper that exits 0 without emitting one contributes nothing, and the sources apply as usual; a helper that fails stops Claude Code from starting, as the [`policyHelper`](/docs/en/settings-reference#policyhelper) entry describes

Claude Code selects the source at startup, and that selection decides whether a helper runs. The [`policyHelper`](/docs/en/settings-reference#policyhelper) entry says which sources can configure a helper.

<span id="parent-settings-from-embedding-hosts" />

<span id="control-policy-from-an-embedding-host" />

<span id="merge-policy-from-an-embedding-host" />

### Let an embedding host add policy

When another application launches Claude Code, such as Claude Desktop, an IDE extension, or an Agent SDK app, that host can pass its own managed settings through the SDK `managedSettings` option. Claude Code calls these parent settings.

By default, Claude Code ignores parent settings whenever an admin source is present: server-managed settings, an MDM or OS-level policy, or a managed settings file.

To have Claude Code merge parent settings alongside an admin source, set [`parentSettingsBehavior`](/docs/en/settings-reference#parentsettingsbehavior) to `"merge"` in the highest-priority managed source; Claude Code reads the key from that source only.

Claude Code then keeps only the host's values that restrict what Claude can do, with one gap to know about: unless you also set the `allowManaged*Only` locks, the host's permission allow rules and sandbox allowlists still apply. See [Restrict parent settings](/docs/en/claude-apps-gateway#restrict-parent-settings) for the locks.

A [`policyHelper`](/docs/en/settings-reference#policyhelper) can turn parent merging off regardless of this key; its entry says when.

Claude Code also applies these checks to parent-supplied values on their own:

* When any admin source sets `allowManagedPermissionRulesOnly`, Claude Code drops [parent-supplied](/docs/en/claude-apps-gateway#restrict-parent-settings) permission allow rules and `additionalDirectories` as it reads them, even when a higher-priority source leaves the key unset. The key's effect on your own permission rules comes from the managed settings Claude Code applies, or from parent settings you've chosen to merge
* Claude Code enforces the `forceLoginOrgUUID` or `allowedMcpServers` value in the managed settings it applies and blocks a parent-supplied one. A value in a lower admin source that Claude Code doesn't apply neither applies nor blocks the parent's. The [`managedSourcesBehavior`](/docs/en/settings-reference#managedsourcesbehavior) entry says which source supplies each key under `"merge"`. Before v2.1.223, a value in any admin source blocked the parent's
* An `availableModels` value follows the same rule as `allowedMcpServers`

#### Keep Cowork folder access when only managed rules apply

[Cowork](https://claude.com/docs/cowork/overview) in the Claude Desktop app runs its sessions on Claude Code and grants each session access to its working folders, such as the folder the user connects, through allow rules it supplies when it launches the session. When your managed policy sets [`allowManagedPermissionRulesOnly`](/docs/en/settings-reference#allowmanagedpermissionrulesonly), Claude Code keeps only the allow rules in the managed policy: it drops allow rules a host supplies as parent settings, as `--allowedTools`, or in a settings file, so writes to those folders lose their pre-approval. In a Cowork session that asks before edits, Cowork can't show the prompt, and Claude reports each write as blocked because the path resolves to a protected location or a path outside the connected folder.

To restore the writes, add allow rules for those folders to the managed source Claude Code [selects](#precedence-within-the-managed-tier) on those machines: on an MDM-managed fleet, that's the MDM policy rather than a separate managed settings file. This example uses the file form, and an MDM policy takes the same keys. It keeps `allowManagedPermissionRulesOnly` set and allows edits under a `CoworkProjects` folder in each user's home directory; replace the path with the folders your users connect:

```json managed-settings.json theme={null}
{
  "allowManagedPermissionRulesOnly": true,
  "permissions": {
    "allow": [
      "Edit(~/CoworkProjects/**)"
    ]
  }
}
```

After you deploy the policy, Claude can save files under that folder in a new Cowork session. [Read and Edit rules](/docs/en/permissions#read-and-edit) cover the path syntax, including the `//` form for absolute paths.

### What a developer can change

A developer's own settings files, `--settings` values, and project files never override a managed value; the [exceptions](/docs/en/settings#exceptions-to-managed-settings-precedence) only let a stricter lower-level value count. Four things sit outside that rule:

* **The model for a session**: a managed `model` is a default, not a lock. `--model` and `ANTHROPIC_MODEL` still pick the model for that session, so deploy [`availableModels`](/docs/en/settings-reference#availablemodels) to restrict the choice.
* **Local admin rights**: a developer who is an administrator on the machine can edit the managed source itself, which is why MDM tooling can redeploy the profile or file on a schedule and why the HKLM registry and the macOS managed preferences domain exist.
* **The server-managed cache**: server-managed settings come from Anthropic's servers, and an edit to the local cache [lasts only until the next successful fetch](/docs/en/server-managed-settings#security-considerations).
* **Other tools**: managed settings bind Claude Code only. A developer who calls the API from another tool isn't under them.

<span id="verify-enforcement" />

<span id="verify-that-a-policy-is-in-force" />

## Check that a policy is in force

A developer reports that a policy isn't applying, or you want to confirm a rollout landed before pushing it to the fleet. Two commands on that machine answer it: `/status` shows which managed source Claude Code selected, and `claude doctor` lists what it dropped.

### Read the source in /status

On the developer's machine, run `/status` inside Claude Code and read the `Setting sources` line. When a managed source is in effect, the line lists `Enterprise managed settings` with the source Claude Code selected in parentheses:

* `(remote)`: server-managed settings from claude.ai or a gateway
* `(plist)` or `(HKLM)`: an MDM or OS policy
* `(file)`, `(drop-ins)`, or `(file + drop-ins)`: `managed-settings.json`, the drop-in directory, or both
* `(remote + file, merged)`, or another list ending in `, merged`: your organization [composes every managed source](#compose-every-managed-source), and Claude Code merged the listed sources into the policy. A lower source can still supply `env` variables without appearing in the list. Requires Claude Code v2.1.242 or later
* `(HKCU)`: the user-writable registry fallback
* `(parent process)`: an [embedding host](#let-an-embedding-host-add-policy) supplied restrictive settings
* `(helper)`: a [`policyHelper`](/docs/en/settings-reference#policyhelper) configured by the selected MDM or file source

When Claude Code found a managed source on the machine and didn't select it, a second line, `Skipped sources`, names each such source. Read it to distinguish a policy that never reached the machine from one that reached it and that a higher-priority source overrode. Requires Claude Code v2.1.242 or later.

When the policy isn't applying, the `Setting sources` line tells you which of two problems you have:

* **The line is missing**: Claude Code found no managed source that delivers a policy key. If you deployed a managed settings file, check that it sits at the path for the OS, that it's valid JSON, and that it contains a [policy key](#how-claude-code-combines-managed-sources) rather than only the control keys.

  When you deployed through server-managed settings instead, run `claude doctor`, which reports the [fetch outcome](/docs/en/server-managed-settings#verify-settings-delivery).
* **The line names a source other than the one you deployed**: a higher-priority source is present and Claude Code ignored yours, and `Skipped sources` lists it. [How Claude Code combines managed sources](#how-claude-code-combines-managed-sources) gives the order.

<span id="invalid-entries-in-managed-settings" />

### Find entries Claude Code dropped

When a managed settings file, MDM profile, registry value, or server-managed payload fails schema validation, Claude Code first skips the individual entries it can repair, such as one invalid permission rule, with a warning for each, then drops any top-level key whose value still fails and keeps enforcing every remaining valid key. Claude Code is stricter with the `managedSettings` a [`policyHelper`](/docs/en/settings-reference#policyhelper) emits: it makes the same entry repairs, but any schema violation that survives fails the whole helper run, and at startup Claude Code refuses to start, the same as for a helper that exits non-zero. A managed settings file or drop-in file that isn't valid JSON contributes no settings at all; Claude Code reports it with the other validation errors and reads the remaining sources as usual.

To find a dropped entry, look in one of three places:

* Interactive sessions show a dialog at startup listing the invalid entries.
* Non-interactive runs with `-p` print a summary to stderr.
* [`claude doctor`](/docs/en/debug-your-config) lists each invalid entry with its source and field.

#### Keys that fail closed

A few enforcement keys aren't dropped when invalid. Claude Code enforces a stricter fallback until the value is fixed; the table shows what it enforces for each key:

| Field                         | Behavior when present but invalid                                                                                                                                                                                                                                                  |
| :---------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedMcpServers`           | Enforced as an empty allowlist, so no MCP servers are admitted until the value is fixed. An individual invalid entry is stripped and the valid subset is enforced.                                                                                                                 |
| `allowManagedHooksOnly`       | Treated as `true` until fixed: the [hook restrictions](/docs/en/settings-reference#allowmanagedhooksonly) apply and, unless `disableCommandPluginSources` is explicitly `false`, command-sourced plugins are disabled.                                                                  |
| `allowManagedMcpServersOnly`  | Treated as `true`.                                                                                                                                                                                                                                                                 |
| `disableCommandPluginSources` | Treated as `true`, so command-sourced plugins stay disabled until the value is fixed.                                                                                                                                                                                              |
| `availableModels`             | Enforced as an empty allowlist until fixed, so only the Default model is available; a non-string entry is stripped and the valid subset enforced.                                                                                                                                  |
| `enforceAvailableModels`      | Treated as `true`.                                                                                                                                                                                                                                                                 |
| `forceLoginOrgUUID`           | No organization is permitted to log in until the value is fixed.                                                                                                                                                                                                                   |
| `crossSessionInbound`         | Treated as `refuse`, the most restrictive value, so inbound [cross-session messages](/docs/en/cross-session-messaging#control-inbound-messages) are refused until the value is fixed. The developer sees [a warning](/docs/en/errors#crosssessioninbound-must-be-one-of-accept-hold-refuse). |
| `deniedMcpServers`            | An individual invalid entry is stripped and the valid subset is enforced. A wholly invalid value is dropped with a warning, since denying every server would block servers the policy never named.                                                                                 |
| `sandbox.credentials`         | A recoverable invalid entry is degraded to `mode: "deny"` with a warning; an unrecoverable one is stripped; valid entries stay enforced. See [invalid credential entries](/docs/en/settings-reference#invalid-credential-entries-in-managed-settings)                                   |

`requiredMinimumVersion` and `requiredMaximumVersion` fail open by design: an invalid value is dropped rather than enforced, so a bad policy push can't prevent Claude Code from starting.

This tolerance applies only to managed settings. User, project, and local settings files remain strict: a file whose JSON or top-level shape fails validation is rejected as a whole and reported, and an individual entry that fails, such as a malformed permission rule, is skipped with a warning while the rest of the file applies.

<span id="managed-only-settings" />

## Keys only a managed source can set

Claude Code reads the following keys only from a managed source; placing them in user or project settings files has no effect.

Most of them are locks: the value a lock governs, such as permission rules or `sandbox.network.allowedDomains`, is an ordinary key that any level can set, and the lock tells Claude Code to honor only the managed value.

The table covers the permission, plugin, and delivery controls. For any key not listed here, the Scope column of the [settings reference](/docs/en/settings-reference#all-settings) index says whether it's managed-only; the remaining managed-only keys there include the gateway login URL, version, browser, mobile-simulator, SSH host, Desktop local-session, sandbox binary path, model pricing, and CLAUDE.md controls.

| Setting                                                                                                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| :-------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`allowAllClaudeAiMcps`](/docs/en/settings-reference#allowallclaudeaimcps)                                                 | Load the claude.ai connectors Claude Code fetches itself alongside a deployed `managed-mcp.json` instead of suppressing them                                                                                                                                                                                                                                                                                                                                                   |
| [`allowedChannelPlugins`](/docs/en/settings-reference#allowedchannelplugins)                                               | Allowlist of channel plugins that may push messages. Replaces the default Anthropic allowlist when set. Requires `channelsEnabled: true`. See [Restrict which channel plugins can run](/docs/en/channels#restrict-which-channel-plugins-can-run)                                                                                                                                                                                                                                    |
| [`allowManagedHooksOnly`](/docs/en/settings-reference#allowmanagedhooksonly)                                               | When `true`, restricts which hooks run; see [what runs under `allowManagedHooksOnly`](/docs/en/settings-reference#what-runs-under-allowmanagedhooksonly) for the full effect list                                                                                                                                                                                                                                                                                                   |
| [`allowManagedMcpServersOnly`](/docs/en/settings-reference#allowmanagedmcpserversonly)                                     | When `true`, only `allowedMcpServers` from managed settings are respected. `deniedMcpServers` still merges from all sources. See [Managed MCP configuration](/docs/en/managed-mcp)                                                                                                                                                                                                                                                                                                  |
| [`allowManagedPermissionRulesOnly`](/docs/en/settings-reference#allowmanagedpermissionrulesonly)                           | Only managed permission rules apply; the entry lists every source it ignores                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`blockedMarketplaces`](/docs/en/settings-reference#blockedmarketplaces)                                                   | Blocklist of marketplace sources. Blocked sources are checked before downloading, so they never touch the filesystem. See [managed marketplace restrictions](/docs/en/plugin-marketplaces#managed-marketplace-restrictions)                                                                                                                                                                                                                                                         |
| [`channelsEnabled`](/docs/en/settings-reference#channelsenabled)                                                           | Allow [channels](/docs/en/channels) for the organization. See [enterprise controls](/docs/en/channels#enterprise-controls) for the default on each plan                                                                                                                                                                                                                                                                                                                                  |
| [`disableCommandPluginSources`](/docs/en/settings-reference#disablecommandpluginsources)                                   | When `true`, blocks [`command` plugin sources](/docs/en/plugin-marketplaces#command-sources) entirely, so the marketplace-declared command never runs. Also blocks marketplace [`headersHelper` commands](/docs/en/plugin-marketplaces#authenticate-archive-downloads), except for a marketplace that managed settings themselves declare. When unset, follows `allowManagedHooksOnly`. Requires Claude Code v2.1.229 or later, and the `headersHelper` block requires v2.1.238 or later |
| [`disableSideloadFlags`](/docs/en/settings-reference#disablesideloadflags)                                                 | Reject the `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` flags at startup. In cloud sessions, Claude Code drops the MCP servers the server delivered through `--mcp-config`, other than in-process `type: "sdk"` entries, and starts the session. Requires Claude Code v2.1.193 or later                                                                                                                                                                      |
| [`forceRemoteSettingsRefresh`](/docs/en/settings-reference#forceremotesettingsrefresh)                                     | When `true`, blocks CLI startup until remote managed settings are freshly fetched and exits if the fetch fails. See [fail-closed enforcement](/docs/en/server-managed-settings#enforce-fail-closed-startup)                                                                                                                                                                                                                                                                         |
| [`managedSourcesBehavior`](/docs/en/settings-reference#managedsourcesbehavior)                                             | Whether Claude Code applies only the highest-priority managed source or [composes every one of them](#compose-every-managed-source)                                                                                                                                                                                                                                                                                                                                            |
| [`parentSettingsBehavior`](/docs/en/settings-reference#parentsettingsbehavior)                                             | Whether host-supplied parent settings merge under the managed policy                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`pluginSuggestionMarketplaces`](/docs/en/settings-reference#pluginsuggestionmarketplaces)                                 | Marketplaces whose plugins Claude Code may suggest to users                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [`pluginTrustMessage`](/docs/en/settings-reference#plugintrustmessage)                                                     | Custom message appended to the plugin trust warning shown before installation                                                                                                                                                                                                                                                                                                                                                                                                  |
| [`policyHelper`](/docs/en/settings-reference#policyhelper)                                                                 | Executable that computes managed settings at startup; see [Compute managed settings with a policy helper](/docs/en/settings-reference#policyhelper)                                                                                                                                                                                                                                                                                                                                 |
| [`sandbox.filesystem.allowManagedReadPathsOnly`](/docs/en/settings-reference#sandbox-filesystem-allowmanagedreadpathsonly) | When `true`, only `filesystem.allowRead` paths from managed settings are respected. `denyRead` still merges from all sources                                                                                                                                                                                                                                                                                                                                                   |
| [`sandbox.network.allowManagedDomainsOnly`](/docs/en/settings-reference#sandbox-network-allowmanageddomainsonly)           | Honor only managed `allowedDomains` and `WebFetch(domain:...)` allow rules; block other domains without prompting                                                                                                                                                                                                                                                                                                                                                              |
| [`strictKnownMarketplaces`](/docs/en/settings-reference#strictknownmarketplaces)                                           | Controls which plugin marketplace sources users can add and install plugins from. See [managed marketplace restrictions](/docs/en/plugin-marketplaces#managed-marketplace-restrictions)                                                                                                                                                                                                                                                                                             |
| [`strictPluginOnlyCustomization`](/docs/en/settings-reference#strictpluginonlycustomization)                               | Block skills, agents, hooks, and MCP servers from user and project sources; `true` locks all four, an array names which                                                                                                                                                                                                                                                                                                                                                        |
| [`wslInheritsWindowsSettings`](/docs/en/settings-reference#wslinheritswindowssettings)                                     | When set in the HKLM registry or a file under `C:\Program Files\ClaudeCode`, have WSL read the Windows policy chain, and read `/etc/claude-code` only when no managed settings file or drop-in under that directory delivers a [policy key](#how-claude-code-combines-managed-sources); the entry gives the order                                                                                                                                                              |

<Note>
  On Team and Enterprise plans, an Owner enables or disables [Remote Control](/docs/en/remote-control) and [web sessions](/docs/en/claude-code-on-the-web) organization-wide in [Claude Code admin settings](https://claude.ai/admin-settings/claude-code). Remote Control can additionally be disabled per device with the [`disableRemoteControl`](/docs/en/settings-reference#disableremotecontrol) setting. Web sessions have no per-device managed settings key.
</Note>

## See also

* [Set up Claude Code for your organization](/docs/en/admin-setup): decide what to enforce and how
* [Server-managed settings](/docs/en/server-managed-settings): deliver policy from the claude.ai console or a gateway
* [Managed MCP configuration](/docs/en/managed-mcp): control which MCP servers developers can use
* [Settings reference](/docs/en/settings-reference): every key, with whether a managed source can set it
* [Example settings files](/docs/en/settings-example#an-organizations-managed-settings): a complete `managed-settings.json` showing the shape of the managed keys
