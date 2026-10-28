> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Plugin commands reference

> Reference for the claude plugin shell commands, /plugin and /reload-plugins in a session, and the flags that load a plugin for one session.

You run plugin commands either as `claude plugin` from your shell or a script, or as `/plugin` and `/reload-plugins` inside a Claude Code session. This reference gives each command's flags, defaults, output, and exit codes, along with the two flags that load a plugin for one session.

The tables below list each subcommand's commonly used options, not every option. Run `claude plugin --help` in your shell to see which subcommands your version has, and `claude plugin <subcommand> --help` for a subcommand's full option list.

> [!NOTE]
>
> These cases are covered on other pages:
>
> * **Install and manage steps, and where `/plugin` runs**: see [Install and manage plugins](https://code.claude.com/docs/en/plugins/install.md)
> * **What a command changes on disk and which scope takes precedence**: see [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading.md)
> * **What an error message means**: see [Troubleshoot plugins](https://code.claude.com/docs/en/plugins/troubleshooting.md)

## claude plugin commands

Run `claude plugin <subcommand>` from your shell or a script, outside a Claude Code session. These subcommands install and manage plugins without opening the [`/plugin`](#plugin-in-a-session) panel.

`claude plugins` is an alias for `claude plugin`.

Every subcommand shares these exit codes, plugin arguments, and scope values:

* **Exit codes**: `0` on success and `1` on failure. `validate` adds exit `2` for an unexpected error, and `eval` adds the codes listed in [its section](#plugin-eval).
* **Plugin arguments**: a `<plugin>` argument is a plugin `name` or `name@marketplace`. When two marketplaces offer the same name, use the qualified form. `configure` takes only the qualified form.
* **Scopes**: `--scope` takes `user`, `project`, or `local`, and names the settings file the command writes to. `update` also takes `managed`.

### plugin init

Scaffold a new plugin at `~/.claude/skills/<name>/`. Unless your administrator has [blocked skills-directory plugins](https://code.claude.com/docs/en/plugins/loading.md#skills-directory-plugins-blocked-by-managed-settings), it loads in your next session as `<name>@skills-dir` with no install step.

`new` is an alias for `init`.

For the create, test, and edit workflow that begins with this command, see [Create a plugin](https://code.claude.com/docs/en/plugins/create.md).

```bash theme={null}
claude plugin init <name> [options]
```

`<name>` becomes the directory name under `~/.claude/skills/` and the plugin's `name` in its manifest.

The command has no flag for another location. To scaffold inside a project instead, see [Create a plugin](https://code.claude.com/docs/en/plugins/create.md).

| Flag | Description |
| :- | :- |
| `--description <text>` | Manifest description |
| `--author <name>` | Author name. Defaults to `git config user.name` |
| `--author-email <email>` | Author email. Defaults to `git config user.email` |
| `--with <components...>` | Also scaffold starter files for `skills`, `agents`, `hooks`, `mcp`, `lsp`, `output-style`, or `channel` |
| `-f, --force` | Overwrite an existing `.claude-plugin/` at the target |

Scaffold a plugin with starter skill and hook files:

```bash theme={null}
claude plugin init my-helper --with skills hooks
```

Claude Code validates what it wrote and prints `Created plugin "my-helper" at ~/.claude/skills/my-helper`, followed by the id it loads as and the `claude plugin disable` command that turns it off.

Claude Code exits `1` without writing when it can't scaffold safely, and the message names the reason. These are common reasons:

* An unknown `--with` value
* An existing scaffold at the target without `--force`
* A managed marketplace allowlist without the `skills-dir` source, or a blocklist that names it. The message is [`Plugins from ~/.claude/skills/ are blocked by your organization's managed settings`](https://code.claude.com/docs/en/plugins/troubleshooting#plugins-from-claude-skills-are-blocked-by-your-organizations-managed-s).

### plugin install

Install a plugin from one of your marketplaces. `i` is an alias for `install`.

```bash theme={null}
claude plugin install <plugin> [options]
```

Most plugins install without a prompt. For a plugin whose marketplace entry [runs a command to install it](https://code.claude.com/docs/en/plugins/host-marketplace.md) or [sets a `headersHelper` for its download](https://code.claude.com/docs/en/plugins/host-marketplace#how-users-accept-a-headershelper-command), Claude Code first prints the command and asks `Run this command now? [y/N]`.

| Flag | Description |
| :- | :- |
| `-s, --scope <scope>` | Installation scope: `user`, `project`, or `local`. Defaults to `user` |
| `--config <key=value>` | Set a [`userConfig`](https://code.claude.com/docs/en/plugins/manifest-reference) option the plugin's manifest declares. Repeat the flag for each option. A key written `<server>.<key>` sets a setting that a [bundled MCP server](https://code.claude.com/docs/en/plugins/components.md#include-a-packaged-mcpb-server) declares in its own `user_config` instead, for a bundle file shipped inside the plugin. The `<server>.<key>` form requires Claude Code v2.1.285 or later |
| `-y, --yes` | Accept the displayed install command without the `Run this command now?` prompt. Ignored when the command runs inside a Claude Code session, such as from the Bash tool or a hook. Requires Claude Code v2.1.229 or later |
| `--accept-command <sha256>` | Accept the displayed install command whose `sha256` a previous [`--json` run](#plugin-json-result) reported in `shownCommand`, in place of `-y`. Can't be combined with `-y`. See [Accept a displayed install command](#accept-a-displayed-install-command). Requires Claude Code v2.1.271 or later |
| `--json` | Print the result as one JSON object on the last line of stdout instead of the human-readable message, for use in scripts. See [JSON result format](#plugin-json-result). Requires Claude Code v2.1.268 or later |
| `--marketplace <source>` | Install `<plugin>`, given by its bare name, from the marketplace at `<source>`, adding the marketplace first if you haven't added it yet. See [Add a marketplace and install in one command](https://code.claude.com/docs/en/plugins/install.md#add-a-marketplace-and-install-in-one-command). Requires Claude Code v2.1.292 or later |

Run `claude plugin install --help` in your shell to see every option your version supports.

Pass `-y` from your own terminal to accept the displayed command without the prompt. Here's what happens without a TTY and when Claude runs the command:

* **stdin or stdout isn't a TTY, and you pass neither `-y` nor `--accept-command`**: the install is refused. The output says the command was only displayed, and the exit code is `1`
* **Claude runs the command through its Bash tool**: `-y` is ignored. Run the command from your own terminal instead

Install a plugin for everyone who clones the project:

```bash theme={null}
claude plugin install formatter@my-marketplace --scope project
```

Claude Code prints `Successfully installed plugin: formatter@my-marketplace (scope: project)`. When nothing new is installed, the output says why:

* **Already installed at that scope**: the output is `Plugin "formatter@my-marketplace" is already installed (scope: project)` and the exit code is `0`
* **You decline a command-source prompt**: the output is `Aborted.` and the exit code is `1`
* **You decline a `headersHelper` prompt, or it can't be confirmed without a TTY**: the output is `Aborted — the command was not run.` and the exit code is `1`

#### JSON result format

When you pass `--json` to `plugin install`, the last line of stdout is one JSON object. Parse only that line, because Claude Code prints any command the marketplace declares ahead of it.

Three fields are always present:

* `command`: the subcommand that ran, such as `install`
* `outcome`: `ok` or `failed`
* `message`: a human-readable description of the result

Other fields, such as `pluginId`, `scope`, and `failureCode`, appear only when they apply.

The `--json` option on `plugin uninstall`, `plugin update`, `plugin enable`, and `plugin disable` prints the same object with that subcommand's own fields.

A usage error, such as an invalid `--scope`, prints no result line and exits `1` with the reason on stderr.

#### JSON result for marketplace commands

On `plugin marketplace add`, `plugin marketplace remove`, and `plugin marketplace update`, `--json` prints one JSON object on the last line of stdout with `command`, `outcome`, and `message` fields. The following is the result of `claude plugin marketplace remove your-marketplace --json`:

```json theme={null}
{"command":"marketplace-remove","outcome":"ok","marketplace":"your-marketplace","message":"Successfully removed marketplace: your-marketplace"}
```

The `command` value is `marketplace-add`, `marketplace-remove`, or `marketplace-update`. The fields below appear only when they apply:

* `marketplace`: the name of the marketplace the command acted on
* `failureCode`: a code for why the command failed, such as `invalid_source`

`plugin marketplace add` and `plugin marketplace remove` can print no result line when the argument is the [reserved name](https://code.claude.com/docs/en/plugins/marketplace-reference.md#reserved-names) `anthropic-plugin-directory`, so check the exit code for that name.

#### Accept a displayed install command

When a `--json` run displays a marketplace-declared command and doesn't run it, the `failed` result also carries a `shownCommand` object. Its fields include the command as displayed, the plugin it belongs to, and the command's `sha256`.

To accept exactly that command, re-run with that `sha256` as `--accept-command` from your own terminal, because the flag has no effect inside a Claude Code session. Requires Claude Code v2.1.271 or later.

The `sha256` counts as acceptance for exactly that command, plugin, and marketplace catalog. If any of them changed since the command was displayed, Claude Code doesn't accept the `sha256` and shows the command again. A change that the run's own marketplace refresh fetches also counts as such a change.

If `shownCommand.acceptCommandMatched` is `false`, the `sha256` you passed doesn't match the command now displayed. Review that command before re-running with its `sha256`.

### plugin uninstall

Remove an installed plugin from one scope. `remove` and `rm` are aliases for `uninstall`.

```bash theme={null}
claude plugin uninstall <plugin> [options]
```

| Flag | Description |
| :- | :- |
| `-s, --scope <scope>` | Uninstall from scope: `user`, `project`, or `local`. Defaults to `user` |
| `--keep-data` | Preserve the plugin's persistent data directory, `~/.claude/plugins/data/<id>/` |
| `--prune` | Also remove auto-installed [dependencies](https://code.claude.com/docs/en/plugins/dependencies.md) that no remaining plugin needs |
| `-y, --yes` | Skip the `--prune` confirmation prompt. Required with `--prune` when stdin or stdout isn't a TTY |
| `--json` | Print the result as one JSON object on the last line of stdout, in the [same format as `plugin install --json`](#plugin-json-result). Can't be combined with `--prune`. Requires Claude Code v2.1.268 or later |

Uninstall a plugin from project scope:

```bash theme={null}
claude plugin uninstall formatter@my-marketplace --scope project
```

Claude Code prints `Successfully uninstalled plugin: formatter (scope: project)`. When the plugin isn't installed at that scope, the command prints a line that starts `Failed to uninstall plugin "formatter@my-marketplace":` and exits `1`.

If the failure line continues with `"formatter" was not uninstalled:` and names a settings file, Claude Code couldn't confirm that the scope's settings no longer switch the plugin on, so the plugin stays installed with everything it saved. With `--json`, the result carries `failureCode: "settings_still_on"`. This settings check requires Claude Code v2.1.282 or later.

#### What an uninstall deletes and keeps

When you uninstall a plugin from the last scope it's installed at, Claude Code also deletes the plugin's stored [options and secrets](https://code.claude.com/docs/en/plugins/manifest-reference.md#user-configuration) and its data directory, `~/.claude/plugins/data/<id>/`. There are three exceptions:

* With `--keep-data`, the data directory stays
* When another installed plugin uses the same folder, such as one whose ID differs from this one only in letter case, the data directory stays
* When Claude Code can't read the list of installed plugins back after it removes the plugin from that scope, the options, secrets, and data directory all stay, because the plugin may still be installed at another scope. The uninstall still succeeds. The message lists what stayed and how to delete it, and with `--json` the result carries `savedKept: "install_records_unreadable"`

With `--json`, `keptData` reports whether the directory stayed, and `/plugin` shows `· data preserved` when it did. For a directory that stays without `--keep-data`, this reporting requires Claude Code v2.1.281 or later. The `savedKept` field requires Claude Code v2.1.282 or later.

### plugin enable

Enable a disabled plugin. For a [plugin synced from claude.ai](https://code.claude.com/docs/en/plugins/loading.md#synced-plugins), pass `<name>@synced` as the plugin.

```bash theme={null}
claude plugin enable <plugin> [options]
```

| Flag | Description |
| :- | :- |
| `-s, --scope <scope>` | Scope to enable at: `user`, `project`, or `local`. Auto-detected when omitted |
| `--json` | Print the result as one JSON object on the last line of stdout, in the [same format as `plugin install --json`](#plugin-json-result). Requires Claude Code v2.1.268 or later |

Without `--scope`, the command checks your settings files in the order local, project, user, and uses the first scope that mentions the plugin.

If you pass a `--scope` where the plugin isn't declared, the command either writes an override or fails:

* **A scope that [takes precedence](https://code.claude.com/docs/en/plugins/loading.md) over the declaring one**: Claude Code writes an override at the scope you passed. For example, `claude plugin disable formatter --scope local` turns off a project-enabled plugin for you alone
* **Any other scope**: the command fails with `Plugin "formatter" is installed at project scope, not user. Use --scope project or omit --scope to auto-detect.`

If the plugin is already enabled at the resolved scope, the command prints `Plugin "formatter" is already enabled` and exits `1`. With `--json`, the result has `"failureCode": "already_in_goal_state"` and `"alreadyInGoalState": true`, so a script can treat that case as success.

When the plugin declares [dependencies](https://code.claude.com/docs/en/plugins/dependencies.md), Claude Code enables them too. The command fails in these cases:

* **A dependency is not installed**: enable fails and prints the `claude plugin install` command for each missing dependency
* **A dependency is blocked by your organization's plugin policy**: enable fails and names the blocked dependency
* **A dependency is set to `false` at a scope with higher precedence than the target scope**: enable fails. Enable the dependency at that scope, or pass `--scope` to write there

Re-enable a plugin wherever it's declared:

```bash theme={null}
claude plugin enable formatter
```

Claude Code prints `Successfully enabled plugin: formatter (scope: project)`, naming the scope it detected.

### plugin disable

Disable a plugin without uninstalling it. For a [plugin synced from claude.ai](https://code.claude.com/docs/en/plugins/loading.md#synced-plugins), pass `<name>@synced` as the plugin.

```bash theme={null}
claude plugin disable [plugin] [options]
```

| Flag | Description |
| :- | :- |
| `-a, --all` | Disable every enabled plugin. Can't be combined with a plugin name or `--scope` |
| `-s, --scope <scope>` | Scope to disable at: `user`, `project`, or `local`. Auto-detected when omitted |
| `--json` | Print the result as one JSON object on the last line of stdout, in the [same format as `plugin install --json`](#plugin-json-result). Requires Claude Code v2.1.268 or later |

Without `--scope`, the scope is auto-detected in the same local, project, user order as [`plugin enable`](#plugin-enable).

If you pass neither a plugin name nor `--all`, Claude Code prints `Please specify a plugin name or use --all to disable all plugins` and exits `1`. Disabling a plugin that is already disabled prints `Plugin "formatter" is already disabled` and exits `1`, as [`plugin enable`](#plugin-enable) does for an already-enabled plugin.

The command fails for a plugin that is still required:

* **Another enabled plugin [depends on](https://code.claude.com/docs/en/plugins/dependencies.md) it**: the command fails and names the dependents to disable first
* **Your organization requires it as a synced plugin**: the command fails and saves nothing

Disable one plugin:

```bash theme={null}
claude plugin disable formatter
```

Claude Code prints `Successfully disabled plugin: formatter (scope: project)`.

### plugin update

Update a plugin to the latest version its marketplace offers. The new version loads in your next session, or after you run `/reload-plugins` in a running one.

```bash theme={null}
claude plugin update <plugin> [options]
```

| Flag | Description |
| :- | :- |
| `-s, --scope <scope>` | Scope to update: `user`, `project`, `local`, or `managed`. Auto-detected when omitted |
| `-y, --yes` | Accept a changed install command from a [command-source](https://code.claude.com/docs/en/plugins/host-marketplace.md) plugin, without the prompt. Required when stdin or stdout isn't a TTY, unless you pass `--accept-command`. Requires Claude Code v2.1.229 or later |
| `--accept-command <sha256>` | Accept the marketplace-declared command whose `sha256` a previous [`--json` run](#plugin-json-result) reported in `shownCommand`, in place of `-y`. Can't be combined with `-y`. Requires Claude Code v2.1.271 or later |
| `--json` | Print the result as one JSON object on the last line of stdout, in the [same format as `plugin install --json`](#plugin-json-result). Requires Claude Code v2.1.268 or later |

Update a plugin:

```bash theme={null}
claude plugin update formatter@my-marketplace
```

Claude Code prints `Checking for updates for plugin "formatter@my-marketplace"…`, then the result. When nothing is newer, it prints `formatter is already at the latest version (1.0.0).` and exits `0`, unless it [retries the plugin's dependency install](#retry-an-unfinished-dependency-install) and that install fails.

#### Which scope the command updates

If you omit `--scope`, the command updates the plugin at the most specific scope it's installed at for your current project, checking local, project, user, then managed.

Before v2.1.281, the command used `user` when you omitted `--scope`, so updating a plugin installed only at project or local scope failed with `Plugin "<name>" is not installed at scope user`. On those versions, pass `--scope`.

`managed` is the one scope you can update but not install to. For admin-installed plugins, see [Manage plugins for your organization](https://code.claude.com/docs/en/plugins/org.md).

#### Update by bare name

You can pass a bare plugin name, which the command matches against your installed plugins. When installed plugins from different marketplaces share the name, the command refuses the update and lists the qualified `plugin-name@marketplace-name` commands to run instead. Updating by bare name requires Claude Code v2.1.246 or later.

#### Retry an unfinished dependency install

When the plugin is already at its latest version, the command can also retry an unfinished dependency install in its cached copy. For the cases where that retry runs or is skipped, see [The packages it lists are not installed](https://code.claude.com/docs/en/plugins/troubleshooting.md#the-packages-it-lists-are-not-installed). If the retry fails, the output is `Failed to update plugin "formatter@my-marketplace"` with the reason and the exit code is `1`. Before v2.1.287, the command reported the plugin at its latest version without retrying the install.

### plugin list

List installed plugins with their version, scope, and status.

```bash theme={null}
claude plugin list [options]
```

| Flag | Description |
| :- | :- |
| `--json` | Print the list as JSON |
| `--available` | Also list plugins your marketplaces offer that you haven't installed. Has no effect without `--json` |
| `--data-size [plugin]` | Measure each installed plugin's [saved data directory](#what-an-uninstall-deletes-and-keeps), or only the named plugin's, given as `name@marketplace`. Has no effect without `--json`. If the name has no install record, the command prints `--data-size names a plugin that is not installed` and exits `1` instead of printing the list. Requires Claude Code v2.1.285 or later |

Claude Code groups the human-readable output by how each plugin loads:

* **`Installed plugins:`**: plugins you installed from a marketplace
* **`Session-only plugins (--plugin-dir / --plugin-url):`**: plugins loaded by those flags in the same command, as in `claude --plugin-dir ./my-plugin plugin list`
* **`Skills-directory plugins (.claude/skills/*):`**: plugins Claude Code found in a skills directory
* **`Synced from claude.ai`**: [plugins synced from your claude.ai account](https://code.claude.com/docs/en/plugins/loading.md#synced-plugins)

With nothing in any group, Claude Code prints ``No plugins installed. Use `claude plugin install` to install a plugin.``

#### JSON output

With `--json`, Claude Code prints an array with one object per installation. Each object carries the fields below. `id`, `version`, `scope`, `enabled`, and `installPath` are always present, and the others appear only when they apply.

| Field | Type | Description |
| :- | :- | :- |
| `id` | string | `name@marketplace` for installs, `name@inline` for session-only plugins, `name@skills-dir` for skills-directory plugins, `name@synced` for plugins synced from claude.ai |
| `version` | string | For a marketplace install, the [version Claude Code computed](https://code.claude.com/docs/en/plugins/loading.md#versions-and-updates) at install. For a session-only, skills-directory, or synced plugin, the manifest's `version`, or `unknown` when it declares none |
| `scope` | string | `user`, `project`, `local`, or `managed` for installs; `user` or `project` for skills-directory plugins; `session` for session-only plugins; `synced` for plugins synced from claude.ai |
| `enabled` | boolean | Whether the plugin is enabled in your merged settings |
| `installPath` | string | Directory the plugin loads from, except for a plugin that sessions [load in place](https://code.claude.com/docs/en/plugins/loading.md#in-place-and-copied-plugins) from its marketplace's folder |
| `readFromFolder` | string | For a plugin that sessions [load in place](https://code.claude.com/docs/en/plugins/loading.md#in-place-and-copied-plugins) from its marketplace's folder, the plugin's source directory inside that folder. Requires Claude Code v2.1.289 or later |
| `folderVersion` | string | With `readFromFolder`, the plugin's `version` as Claude Code loaded it from that folder, which can differ from the `version` field above. Absent when the plugin didn't load or declares no version. Requires Claude Code v2.1.289 or later |
| `installedAt` | string | ISO timestamp of the install. Marketplace installs only |
| `lastUpdated` | string | ISO timestamp of the last update. Marketplace installs only |
| `projectPath` | string | Project the install belongs to. `project` and `local` scope only |
| `mcpServers` | object | The plugin's MCP server definitions, when a marketplace-installed plugin has any |
| `errors` | array of strings | Load errors, when the plugin failed to load |
| `notes` | array of strings | Warnings that aren't load errors, such as authoring issues or [packages that aren't installed](https://code.claude.com/docs/en/plugins/loading.md#when-the-dependency-install-fails-or-is-skipped) |
| `errorDetails` | array of objects | One object per `errors` entry, giving its diagnostic `type` and the names it refers to, such as the plugin, marketplace, server, or file. Requires Claude Code v2.1.268 or later |
| `noteDetails` | array of objects | The same detail objects for each `notes` entry. Requires Claude Code v2.1.268 or later |
| `hasUserConfig` | boolean | Present and `true` when the plugin loaded and its manifest declares [`userConfig` options](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration). Absent for a plugin that failed to load, whatever its manifest declares. Saved values are never included. Requires Claude Code v2.1.285 or later |
| `projectEnabled` | boolean | Whether the project's shared `.claude/settings.json` turns the plugin on. Marketplace installs only. Requires Claude Code v2.1.285 or later |
| `dataDirSize` | object | With `--data-size`, the size of the plugin's [saved data directory](#what-an-uninstall-deletes-and-keeps) as `bytes` and `human`; absent when the directory is missing or empty. Marketplace installs only. Requires Claude Code v2.1.285 or later |
| `dataDirUnreadable` | boolean | With `--data-size`, `true` when the saved data directory exists but couldn't be measured. Marketplace installs only. Requires Claude Code v2.1.285 or later |

With `--json --available`, Claude Code prints one object instead of an array. Its `installed` field holds the array of installed-plugin objects, and its `available` field holds one object per uninstalled marketplace plugin with the fields below.

| Field | Type | Description |
| :- | :- | :- |
| `pluginId` | string | `name@marketplace` |
| `name` | string | The plugin's name in the marketplace |
| `marketplaceName` | string | The marketplace that offers it |
| `source` | string or object | The marketplace entry's [source](https://code.claude.com/docs/en/plugins/marketplace-reference.md): a string for a relative path, an object otherwise |
| `description` | string | The entry's description, when it has one |
| `version` | string | The entry's version, when it declares one |
| `installCount` | number | Install count, when Claude Code has one for the plugin |

### plugin details

Show a plugin's component inventory and its projected token cost.

The plugin must be loaded: installed, found in a skills directory, or passed with `--plugin-dir` or `--plugin-url` in the same command. The `<name>` is a plugin `name` or `name@marketplace`.

```bash theme={null}
claude plugin details <name>
```

The command takes no flags beyond `--help`.

Show what an installed plugin contributes:

```bash theme={null}
claude plugin details formatter
```

Claude Code prints the plugin's name, version, description, and source, then these sections:

* **`Component inventory`**: the plugin's skills, agents, hooks, MCP servers, and LSP servers
* **`Projected token cost`**: the always-on tokens the plugin adds to every session
* **`Per-component (rounded)`**: always-on and on-invoke estimates for each skill, agent, and command. Omitted when the plugin has none

For what the two cost figures mean, see [Measure plugin cost and usage](https://code.claude.com/docs/en/plugins/measure.md).

For a plugin that isn't loaded, Claude Code prints this message and exits `1`:

```text theme={null}
Plugin "formatter" not found. Run `claude plugin list` to see installed plugins, or pass --plugin-dir <path> to load one from disk.
```

An ID that ends in `@builtin` names one of the [plugins built into Claude Code](https://code.claude.com/docs/en/plugins/mods/overview.md#mods-built-into-claude-code). If you pass such an ID and Claude Code doesn't find that plugin, the message reads instead:

```text theme={null}
Plugin "<name>@builtin" not found. Built-in plugins don't appear in `claude plugin list`. To see the ones available in a session, run /plugin in Claude Code and open the Installed tab.
```

### plugin configure

Show an installed plugin's [`userConfig`](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration) options and which are set, or save values piped in on stdin. Requires Claude Code v2.1.285 or later.

```bash theme={null}
claude plugin configure <plugin>
```

| Flag | Description |
| :- | :- |
| `--values-stdin` | Read option values from stdin as a JSON object of single-line strings and save them. Options you leave out keep their saved values |
| `--json` | Print the result as one JSON object on stdout. Without `--values-stdin`, the object carries the options' `schema` and `choices`, their starting `inputs`, and the `configured` and `unconfigured` option names. With `--values-stdin`, it carries the `saved` option names and, when they could be read back, the `unconfigured` ones |

Without flags, the command lists each option with up to three labels: `required` or `optional`, then `sensitive` for an option the manifest declares sensitive, then `set` or `not set`. It prints no saved values. With `--json`, the output includes the saved values of options that aren't sensitive, and never the text of a sensitive one.

To save values, write them to a file as a JSON object that maps option keys to string values, then pass the file on stdin. Replace `formatter@my-marketplace` with your own plugin's id as `claude plugin list` shows it. This example sets one option named `api_url` from a file `values.json` that contains `{"api_url": "https://example.com"}`:

```bash theme={null}
claude plugin configure formatter@my-marketplace --values-stdin < values.json
```

Claude Code validates each value against the option's declared type and prints `Configuration saved. Restart Claude Code to apply it.` If you pass a key the manifest doesn't declare, or a value that fails validation, the command saves nothing, prints `Failed to save configuration:` with the reason, and exits `1`. With `--json`, a refused value also prints an object on stdout whose `refused` field carries the `message` and, when one option is at fault, its `option` key.

Pass the plugin's full `name@marketplace` id, as `claude plugin list` shows it. `configure` doesn't accept a bare `name`. When no loaded plugin has that id, the command prints `No installed plugin has the id "<plugin>".` and exits `1`.

For the settings of a bundled MCP server, see [`plugin install --config`](#plugin-install) or the **Configure** item in `/plugin`.

### plugin prune

Remove auto-installed [dependencies](https://code.claude.com/docs/en/plugins/dependencies.md) that no installed plugin needs anymore. The command never removes a plugin you installed yourself. `autoremove` is an alias for `prune`.

```bash theme={null}
claude plugin prune [options]
```

| Flag | Description |
| :- | :- |
| `-s, --scope <scope>` | Prune at scope: `user`, `project`, or `local`. Defaults to `user` |
| `--dry-run` | List what would be removed without removing it |
| `-y, --yes` | Skip the confirmation prompt. Required when stdin or stdout isn't a TTY |

Preview what a prune would remove:

```bash theme={null}
claude plugin prune --dry-run
```

Claude Code lists the orphaned dependencies and ends with `(dry run — nothing removed)`. With none to remove, it prints a line that starts `Nothing to prune`.

Without `--dry-run`, the command removes the orphaned dependencies only after you confirm at the prompt or pass `-y`.

The exit code is `0` whatever you answer at the prompt.

What `prune` does depends on whether a terminal is attached and whether you pass `-y`:

| Terminal and flags | What happens |
| :- | :- |
| Interactive terminal, no `-y` | Lists the orphaned dependencies and asks `Remove? [y/N]` |
| Any terminal, `-y` | Removes them and prints `Removed N auto-installed plugins: <names>` |
| Non-TTY stdin or stdout, no `-y` | Prints the list and ``Not a TTY — run `claude plugin prune -y` to remove.``, removing nothing |

### plugin eval

Run a plugin's [eval cases](https://code.claude.com/docs/en/plugin-evals.md) and report scored results. Requires Claude Code v2.1.269 or later.

Each case is a prompt plus graders. Claude Code runs it several times in an isolated session with only the target plugin loaded, and by default also without the plugin so the report shows the difference.

See [Test plugins with evals](https://code.claude.com/docs/en/plugin-evals.md) for the case format, graders, results, and CI usage.

```bash theme={null}
claude plugin eval [target] [options]
```

The optional `target` defaults to the current directory and takes any of these forms:

* A plugin directory
* A single `prompt.md` or `case.yaml` file
* An installed plugin as `name` or `name@marketplace`
* `name@skills-dir`

Put the target before `--tag`, `--allow-tools`, and `--json`. Each of these options takes the words that follow it as its value, so a target written after one of them is read as a tag, a tool name, or the JSON output path instead of as the target.

This table lists the options most runs use. Run `claude plugin eval --help` for the complete set, including `--case`, `--tag`, `--output-dir`, `--report`, `--allow-real-servers`, `--keep-temp`, and `--verbose`.

| Option | Description | Default |
| :- | :- | :- |
| `--runs <n>` | Runs per case in each [arm](https://code.claude.com/docs/en/plugin-evals.md#compare-against-a-no-plugin-baseline) | Each case's `runs`, else 3 |
| `-j, --concurrency <n>` | Agent sessions to run at once, 1 to 8. They share your rate limit | `1` |
| `--model <model>` | Model for the agent under test | Each case's `model`, else `ANTHROPIC_MODEL` if set, else Claude Code's default |
| `--judge-model <model>` | Model for `llm` and `baseline` graders | The model for [background tasks](https://code.claude.com/docs/en/plugin-evals.md#grade-the-result) |
| `--ablation <mode>` | `none` or `with-without`. See [Score against the no-plugin baseline](https://code.claude.com/docs/en/plugin-evals.md#compare-against-a-no-plugin-baseline) | Decided per case, as that section describes |
| `--threshold <0..1>` | Exit 1 if any case scores below this | `1.0` |
| `--max-cost-usd <usd>` | Stop before the next run once spend reaches this, exit 2, and report partial results | No limit |
| `--allow-tools <tools...>` | Grant tools beyond the read-only set, such as `Bash`, `Write`, `Edit`, or `"mcp__plugin_<plugin>_<server>__*"`. See [Grant tools](https://code.claude.com/docs/en/plugin-evals.md#grant-tools) | |
| `--scaffold` | Run each case's [`scaffold_script`](https://code.claude.com/docs/en/plugin-evals#add-setup-or-history-with-case-yaml) | Off |
| `--trust-plugin` | Skip the first-run trust prompt, for CI. See [What a run can access](https://code.claude.com/docs/en/plugin-evals.md#security) | Off |
| `--mocks <mode>` | `record` or `off`. See [Mock MCP servers](https://code.claude.com/docs/en/plugin-evals.md#mock-mcp-servers) | `record` |
| `--eval-dir <dir>` | Directory below the plugin that holds the cases | The manifest's `experimental.evals`, else `evals` |
| `--json [path]` | Print the [result document](https://code.claude.com/docs/en/plugin-evals.md#json-result) to stdout, or write it to a `.json` path | |
| `--no-publish` | Keep the HTML report local | |

The exit code reports how the run ended. To act on it in a pipeline, see [Run evals in CI](https://code.claude.com/docs/en/plugin-evals.md#run-evals-in-ci).

| Exit code | Meaning |
| :- | :- |
| `0` | The suite passed: every case meets the threshold and nothing else failed the run |
| `1` | A failing case, a load error, an untrusted plugin directory, a run that [ended on an API error](https://code.claude.com/docs/en/plugin-evals.md#runs-ended-on-an-api-error), or another cause listed under [Run evals in CI](https://code.claude.com/docs/en/plugin-evals.md#run-evals-in-ci) |
| `2` | A partial run |
| `130` | Interrupted |
| `143` | Terminated |

### plugin eval init

Create an eval suite for the plugin in the current directory. Requires Claude Code v2.1.269 or later. See [Create your first eval suite](https://code.claude.com/docs/en/plugin-evals.md#create-your-first-eval-suite).

```bash theme={null}
claude plugin eval init [name] [options]
```

Run the command from the plugin's root folder, the directory that holds `.claude-plugin/plugin.json` or the skill's `SKILL.md`. To scaffold the suite in another directory on purpose, pass `--eval-dir`.

In a terminal, the command opens an interactive Claude Code session for an authoring interview. In the interview, Claude does the following:

1. Reads the plugin
2. Asks you what it should do well
3. Proposes cases and graders
4. Writes the case files
5. Runs the cases and reviews the grades with you to check that the graders score the way you would

With `--bare`, or without a terminal, the command writes a blank single-case template instead. When Claude runs the command from inside a Claude Code session, the command prints the interview instructions for that session to follow rather than writing a template.

The optional `name` is a case name. It's required with `--bare` or without a terminal, because the command writes the blank template for that case. A case name starts with a letter or digit and contains only letters, digits, `.`, `_`, and `-`. On every platform, the command also refuses names that Windows can't store, such as `con` or a name ending in `.`.

The command accepts these options:

| Option | Description | Default |
| :- | :- | :- |
| `--bare` | Write a blank `prompt.md` and `graders/criteria.md` for `<name>` instead of running the interview | |
| `-i, --interactive` | Require the interview. Fails without a terminal instead of writing a template | |
| `--eval-dir <dir>` | Directory below the current directory to write cases into | The manifest's `experimental.evals`, else `evals` |

### plugin tag

Create an annotated git tag named `<name>--v<version>` for a plugin release. Before tagging, the command checks that the plugin's `plugin.json` and any marketplace entry that lists it agree on the version.

For when to tag a release, see [Publish a plugin](https://code.claude.com/docs/en/plugins/publish.md).

```bash theme={null}
claude plugin tag [path] [options]
```

The `[path]` is the plugin directory, defaulting to the current directory. The command finds the marketplace entry by walking up from that directory to a `.claude-plugin/marketplace.json` that lists the plugin.

| Flag | Description |
| :- | :- |
| `--push` | Push the tag to `--remote` after creating it |
| `--dry-run` | Print what would be tagged without creating the tag |
| `-f, --force` | Skip the dirty-working-tree and tag-already-exists checks |
| `-m, --message <msg>` | Tag annotation message. `%s` stands for the version. Defaults to `<name> <version>` |
| `--remote <name>` | Remote to push to with `--push`. Defaults to `origin` |

Preview the tag for a plugin in a marketplace checkout:

```bash theme={null}
claude plugin tag plugins/formatter --dry-run
```

Claude Code prints the plan:

* The plugin name
* The version and which file it came from
* The matching marketplace entry, when there is one
* The tag name
* The `git tag` and `git push` commands it would run

Without `--dry-run`, Claude Code prints `Created tag formatter--v1.0.0` and either `Pushed to origin` or the push command to run yourself. If the push fails, the tag is still created locally and the command exits with an error.

The command exits `1` and prints the reason when it can't tag safely. Common reasons are:

* No `version` in `plugin.json` or the marketplace entry
* The tag already exists
* The working tree is dirty

### plugin test

Run the tests for a [mod](https://code.claude.com/docs/en/plugins/mods/overview.md), a plugin whose code registers event handlers. The command needs no session, sign-in, or network. For how to write a test, see [Test a mod](https://code.claude.com/docs/en/plugins/mods/test.md).

```bash theme={null}
claude plugin test [directory]
```

The `[directory]` is the mod's directory, defaulting to the current directory. The command runs every file under it whose name ends in `.test.ts` or `.test.tsx`, and exits with status 1 when a test fails.

Run the tests for a mod in `./first-mod`:

```bash theme={null}
claude plugin test ./first-mod
```

### plugin validate

Validate a plugin manifest, a marketplace manifest, or the skills, agents, and commands in a directory, and exit with a code a CI job can act on. For the create, test, and edit workflow, see [Create a plugin](https://code.claude.com/docs/en/plugins/create.md). For what the validator checks in each manifest, see the [plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference.md) and the [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md).

```bash theme={null}
claude plugin validate <path> [options]
```

| Flag | Description |
| :- | :- |
| `--strict` | Treat warnings as errors, so unrecognized fields and missing metadata that the runtime tolerates fail the run |
| `--json` | Output the validation report as one JSON object with the same exit codes. Requires Claude Code v2.1.259 or later |

Validate a plugin before committing it:

```bash theme={null}
claude plugin validate ./my-plugin --strict
```

#### Validate a directory

The `<path>` is a manifest file or a directory. Given a directory, Claude Code picks what to validate by what it finds there:

* `.claude-plugin/marketplace.json`, when it exists
* Otherwise `.claude-plugin/plugin.json`
* Otherwise the component files, chosen by the directory's name. Validating component files without a manifest requires Claude Code v2.1.233 or later:
  * A directory named `skills`, `agents`, or `commands`: the files inside it
  * A directory named `.claude`: the `skills`, `agents`, and `commands` directories inside it
  * Any other directory: those three directories under its `.claude`

When the directory holds both a `.claude-plugin/marketplace.json` and a `.claude-plugin/plugin.json`, Claude Code validates the marketplace and also the plugin's manifest and component files. This requires Claude Code v2.1.289 or later.

Claude Code doesn't follow symlinks inside the directory you name. What it does depends on where the link is:

* **A linked `skills`, `agents`, or `commands` directory under the plugin or `.claude` root**: Claude Code warns that nothing in it was read.
* **A linked entry inside a `skills`, `agents`, or `commands` directory**: Claude Code skips it and warns, per directory, how many entries it skipped that a session would load.
* **The `skills`, `agents`, or `commands` directory you name is itself a symlink, or its parent `.claude` directory is**: Claude Code reports an error and checks nothing in it. Name the real directory instead.

A few files are not read by a validation run:

* **A `SKILL.md` at the plugin root**: when you run `claude plugin validate` against a plugin directory, Claude Code doesn't check a `SKILL.md` at the plugin root
* **A `CLAUDE.md` at the plugin root**: in a plugin run, Claude Code also warns about a `CLAUDE.md` at the plugin root
* **Plugin files in a marketplace run**: from a marketplace directory, Claude Code doesn't open the skill, agent, command, or hook files of plugins the marketplace lists in other directories, or the MCP server files they bundle. To find errors in those files, validate each plugin directory

#### Output and exit codes

Claude Code prints the file it validated, any errors and warnings with their paths, and a verdict line. The exit code follows the verdict:

| Exit code | Verdict line | Meaning |
| :- | :- | :- |
| `0` | `Validation passed` or `Validation passed with warnings` | The manifest loads. With `--strict`, no warnings either |
| `1` | `Validation failed` or `Validation failed (--strict treats warnings as errors)` | An error, or a warning under `--strict`. [Advice](#advice-on-the-readme) doesn't count, with or without `--strict` |
| `2` | `Unexpected error during validation: <reason>` | The validator itself failed, such as on an unreadable path |

With `--json`, Claude Code writes the report to stdout as one JSON object with these top-level fields:

* `success`: the same verdict the exit code gives
* `strict`: whether the run treated warnings as errors
* `target`: the resolved path Claude Code validated
* `manifest`: the manifest's own result, or `null` for a run without a manifest
* `contents`: per-file results, each naming its `file` and carrying `errors`, `warnings`, and `notes` arrays. Files with no error, warning, or note get no entry, so `contents` is empty when there's nothing to report. For a [directory with `marketplace.json` and `plugin.json`](#validate-a-directory), `manifest` is the `marketplace.json` result and `plugin.json` results go in `contents`
  * `gatingHooks`: whether each [mod](https://code.claude.com/docs/en/plugins/mods/overview.md) hook that can refuse an action, such as a `tool.call` hook, has a [`.catch` handler](https://code.claude.com/docs/en/plugins/mods/events#handle-a-hook-that-fails). Each item gives `module`, `pattern`, `hook`, and `hasCatch`. Requires Claude Code v2.1.290 or later
* `advice`: the [advice](#advice-on-the-readme) of the run, each entry naming the README as `file` and carrying a `message` and the `installLine` to paste. Empty when there is none. Requires Claude Code v2.1.295 or later

On exit `2`, the command writes nothing to stdout. The error message goes to stderr.

#### Advice on the README

An `Advice` block in the output of `claude plugin validate` means a plugin's README has no line that installs the plugin from a marketplace, and it gives you a line to add. Advice isn't an error or a warning. It doesn't change the verdict line or the exit code, with or without `--strict`. It requires Claude Code v2.1.295 or later.

For example, validating the `acme-tools` marketplace's directory prints this advice for its `deploy-helper` plugin:

```text theme={null}
Validating marketplace manifest: /path/to/acme-tools/.claude-plugin/marketplace.json

ℹ Advice (does not change the verdict):

  ❯ /path/to/acme-tools/plugins/deploy-helper/README.md: This README has no line that installs "deploy-helper" from a marketplace. Add the install line, which works in one step on Claude Code 2.1.275 or later.
      /plugin install deploy-helper --marketplace acme/tools

✔ Validation passed
```

To clear the advice, paste the suggested line into the README it names, then run `claude plugin validate` again in your shell. The `Advice` block is gone.

If the suggested line holds the placeholder `<owner>/<repo>`, pasting it unchanged doesn't clear the advice. Get the real source first:

* **You validated the plugin's own directory**: when the marketplace lists the plugin from a directory inside its own, validate that directory instead. When it lists the plugin from somewhere else, such as a GitHub repository, fill in `<owner>/<repo>` yourself
* **You validated the marketplace's directory**: Claude Code fills in the source from the `origin` remote of the `.git` directory at the top of that directory. When it can't use that remote, such as when there is none, replace `<owner>/<repo>` with your marketplace's source yourself

An install line you already wrote counts when `plugin install`, or its short form `plugin i`, is followed on the same line by either of these. The `/plugin` and `claude plugin` spellings both count:

* `<plugin>@<marketplace>`, such as `/plugin install deploy-helper@acme-tools`
* The plugin's name and `--marketplace <source>`, such as `/plugin install deploy-helper --marketplace acme/tools`

## claude plugin marketplace commands

Run `claude plugin marketplace <subcommand>` from your shell to add, list, refresh, and remove the marketplaces you install plugins from.

* **Exit codes**: these subcommands follow the [exit-code convention](#claude-plugin-commands) of the plugin commands
* **Scopes**: their `--scope` flag has no `-s` short form

For what a marketplace is and how Claude Code caches it, see [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading.md).

### plugin marketplace add

Add a marketplace from a GitHub repository, a git URL, a hosted `marketplace.json`, or a local path, and declare it in a settings file.

After you add it, Claude Code installs any [dependencies](https://code.claude.com/docs/en/plugins/dependencies.md) that your installed plugins were missing.

```bash theme={null}
claude plugin marketplace add <source> [options]
```

| Flag | Description |
| :- | :- |
| `--scope <scope>` | Settings file to declare the marketplace in: `user`, `project`, or `local`. Defaults to `user` |
| `--sparse <paths...>` | Limit the git checkout to these directories, for monorepos. `github` and `git` sources only |
| `--claudeai` | Read the argument as the name of a [marketplace hosted on claude.ai](https://code.claude.com/docs/en/plugins/install.md#add-from-claude-ai) instead of a source. Requires Claude Code v2.1.273 or later |
| `--json` | Print whether the command succeeded, and its message, as one JSON object on the last line of stdout, in the [JSON result format](#plugin-json-result). Has no effect with `--claudeai`. Requires Claude Code v2.1.287 or later |

`<source>` takes any of the forms in the table below, and its form decides the source type and how Claude Code fetches the marketplace. For the resulting source object, see the [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md).

| You type | Source type | How Claude Code fetches it |
| :- | :- | :- |
| `owner/repo`, `owner/repo#ref`, or `owner/repo@ref` | `github` | Clones the GitHub repository, pinned to `ref` when given. Owner and repo must follow GitHub naming rules |
| `user@host:path[.git][#ref]` | `git` | Clones over SSH |
| An `http://` or `https://` URL that ends in `.git[#ref]` or contains `/_git/`, such as `https://example.com/repo.git` | `git` | Clones the URL, including Azure DevOps URLs |
| `https://github.com/owner/repo` or `https://gitlab.com/namespace/project`, or the same over `http://` | `git` | Clones the URL after appending `.git` |
| Any other `http://` or `https://` URL, including a self-hosted git host without `.git` | `url` | Fetches the URL as a `marketplace.json`. To clone a repository there instead, append `.git` |
| `./path`, `../path`, `/path`, or `~/path` to a directory | `directory` | Reads the directory in place. On Windows, `.\`, `..\`, and `C:\` forms also work |
| The same path forms, to a `.json` file | `file` | Reads the file in place |

For a host whose clone URLs don't carry the `.git` suffix, such as AWS CodeCommit, add the marketplace as a git entry in [`extraKnownMarketplaces`](https://code.claude.com/docs/en/settings-reference#extraknownmarketplaces) instead. Claude Code clones a git entry whether or not its URL ends in `.git`.

Claude Code also clones a `gitlab.com` URL with nested subgroups, such as `https://gitlab.com/group/subgroup/project`.

Add a marketplace and share it with the project:

```bash theme={null}
claude plugin marketplace add your-org/your-marketplace --scope project
```

Claude Code prints `Successfully added marketplace: your-marketplace (declared in project settings)`, using the `name` from the marketplace's own manifest. A repeat add or an invalid source prints one of these results instead:

* **Marketplace already on disk**: the output is `Marketplace 'your-marketplace' already on disk — declared in project settings` and the exit code is `0`
* **Unrecognized source**: the output is `Invalid marketplace source format. Try: owner/repo, https://..., or ./path` and the exit code is `1`
* **Bare host such as `gitlab.example.com/team/plugins`**: the add fails as an invalid `owner/repo` shorthand, and the message tells you to add `https://` or use a local path

Add a [marketplace hosted on claude.ai](https://code.claude.com/docs/en/plugins/install.md#add-from-claude-ai) by the name printed in the `From claude.ai:` section of `claude plugin marketplace list`:

```bash theme={null}
claude plugin marketplace add --claudeai claudeai-organization-library
```

With `--claudeai`, the command refuses `--scope` and `--sparse`. The marketplace is hosted for your account, not declared in a settings file, so you can't share it through a project's `.claude/settings.json`.

### plugin marketplace list

List every marketplace you've added, with its source.

```bash theme={null}
claude plugin marketplace list [options]
```

| Flag | Description |
| :- | :- |
| `--json` | Print the list as JSON |

Claude Code prints `Configured marketplaces:` and one `Source:` line per marketplace, or `No marketplaces configured`.

With `--json`, Claude Code prints an array with one object per marketplace, carrying the fields below. Every field is a string.

| Field | Description |
| :- | :- |
| `name` | The marketplace's name |
| `source` | `github`, `git`, `url`, `directory`, `file`, or `claudeai` |
| `repo` | `owner/repo`. `github` sources only |
| `url` | The clone or fetch URL. `git` and `url` sources only |
| `path` | The local path. `directory` and `file` sources only |
| `ref` | The pinned branch or tag. `github` and `git` sources, only when pinned |
| `installLocation` | Where Claude Code cached the marketplace |

An added [claude.ai marketplace](https://code.claude.com/docs/en/plugins/install.md#add-from-claude-ai) has no local clone, so its entry carries its claude.ai identifiers, `marketplaceId` and `organizationUuid`, in place of `installLocation`. It also carries `scope` when one is recorded, and `status`.

If your terminal sessions [sync plugins from your claude.ai account](https://code.claude.com/docs/en/plugins/loading.md#synced-plugins), the text listing ends with a `From claude.ai:` section. That section names the marketplaces claude.ai lists for your account that you haven't added, both git-based and hosted. It requires Claude Code v2.1.273 or later.

To add a marketplace from that section, see [Add a marketplace from claude.ai](https://code.claude.com/docs/en/plugins/install.md#add-from-claude-ai).

The `--json` output covers configured marketplaces only and leaves the section out.

### plugin marketplace remove

Remove a marketplace's declaration from your settings. `rm` is an alias for `remove`.

> [!WARNING]
>
> When you remove a marketplace from the last scope that declares it, Claude Code also deletes its cache and uninstalls every plugin you installed from it. It also deletes their saved [options and secrets](https://code.claude.com/docs/en/plugins/manifest-reference.md#user-configuration) and [data](https://code.claude.com/docs/en/plugins/components.md#path-variables-and-persistent-data) where it can.
>
> To refresh a marketplace without losing its plugins, run `plugin marketplace update` instead.

```bash theme={null}
claude plugin marketplace remove <name> [options]
```

The `<name>` is the marketplace name that `plugin marketplace list` shows, not the source you passed to `add`.

| Flag | Description |
| :- | :- |
| `--scope <scope>` | Remove the declaration from one settings scope: `user`, `project`, or `local`. Without it, Claude Code removes the declaration from every scope |
| `--json` | Print whether the command succeeded, and its message, as one JSON object on the last line of stdout, in the [JSON result format](#plugin-json-result). Requires Claude Code v2.1.287 or later |

Remove a marketplace from every scope:

```bash theme={null}
claude plugin marketplace remove your-marketplace
```

Claude Code prints `Successfully removed marketplace: your-marketplace`. When the command uninstalls plugins, the output lists them under a line such as `Also uninstalled 2 plugins from this marketplace:`. To use one of them again, add the marketplace back and reinstall the plugin.

If you scope to a settings file that doesn't declare the marketplace, the command fails with `Marketplace 'your-marketplace' is not declared in project settings. Omit --scope to remove it from all scopes.`

### plugin marketplace update

Refresh one marketplace, or every marketplace, from its source to fetch new plugins and versions. A marketplace added with a branch or tag `ref` updates to the latest commit of that ref, not the repository's default branch.

```bash theme={null}
claude plugin marketplace update [name] [options]
```

| Flag | Description |
| :- | :- |
| `--json` | Print whether the command succeeded, and its message, as one JSON object on the last line of stdout, in the [JSON result format](#plugin-json-result). Without a name, the command refuses `--json` and exits `1`. Requires Claude Code v2.1.287 or later |

Refresh one marketplace:

```bash theme={null}
claude plugin marketplace update your-marketplace
```

Claude Code prints `Successfully updated marketplace: your-marketplace`. When you omit the name, it prints a count such as `Successfully updated 2 marketplaces`.

## /plugin in a session

Inside an interactive session, `/plugin` opens the plugin panel. Each subcommand opens the panel on a tab, runs an action there, or prints a result inline. `/plugins` and `/marketplace` are aliases for `/plugin`.

You can run these commands only in an interactive terminal session. In a non-interactive run such as `claude -p`, Claude Code replies that `/plugin` isn't available in this environment.

For which surfaces have `/plugin`, how to install without it, and what each panel tab shows, see [Install and manage plugins](https://code.claude.com/docs/en/plugins/install.md).

A `<plugin>` is a plugin `name` or `name@marketplace`.

The table below lists every session form. The shell subcommands `init`, `update`, `details`, `prune`, `eval`, `eval init`, and `test` have no session form.

| Command | Aliases | What it does |
| :- | :- | :- |
| `/plugin` | | Opens the panel on the **Discover** tab. Any unrecognized first word after `/plugin` does the same |
| `/plugin help` | `/plugin --help`, `/plugin -h` | Shows the usage list of `/plugin` subcommands |
| `/plugin list [--enabled\|--disabled]` | `ls` | Prints your marketplace-installed plugins inline, with version, scope, and status. A filter flag shows only that state. A plugin whose enable state hasn't been applied yet is marked `— run /reload-plugins to apply` |
| `/plugin install` | `i` | Opens the **Discover** tab |
| `/plugin install <plugin>` | `i` | Opens the plugin's details in the **Discover** tab. With `name@marketplace`, opens them in that marketplace's list |
| `/plugin install <source>` | `i` | Reports a [marketplace not found](https://code.claude.com/docs/en/plugins/troubleshooting.md#marketplace-not-found) error and installs nothing when the target is a path, URL, or `owner/repo`, even a source you've already added. To install from a source, see [Add a marketplace and install in one command](https://code.claude.com/docs/en/plugins/install.md#add-a-marketplace-and-install-in-one-command) |
| `/plugin install <plugin> --marketplace <source>` | `i` | Adds the marketplace at `<source>` when you haven't added it yet, asking you to confirm first, then opens the plugin's details. See [Add a marketplace and install in one command](https://code.claude.com/docs/en/plugins/install.md#add-a-marketplace-and-install-in-one-command). Requires Claude Code v2.1.275 or later |
| `/plugin manage` | | Opens the **Installed** tab |
| `/plugin stats` | | Opens the **Stats** tab, in sessions where [`/skill-doctor`](https://code.claude.com/docs/en/skills#find-unused-skills) is available. Anywhere else it opens the panel on the **Discover** tab |
| `/plugin enable <plugin>` | | Opens the **Installed** tab at the plugin and enables it |
| `/plugin disable <plugin>` | | Opens the **Installed** tab at the plugin and disables it |
| `/plugin uninstall <plugin>` | | Opens the **Installed** tab at the plugin and uninstalls it |
| `/plugin configure <plugin>` | `config` | Opens the plugin's [`userConfig`](https://code.claude.com/docs/en/plugins/manifest-reference) dialog, or reports that the plugin declares none |
| `/plugin validate <path>` | | Prints the same report as `claude plugin validate`, inline |
| `/plugin tag [path] [--push] [--dry-run] [--force]` | | Creates the release tag as `claude plugin tag` does. Accepts `--push`, `--dry-run`, and `--force` or `-f`; with any other flag or an extra argument, Claude Code prints usage instead |
| `/plugin marketplace` | `market` | Does nothing visible. Pass `add`, `list`, `update`, or `remove` |
| `/plugin marketplace add [source]` | `market add` | With a source, adds it and reports the result. Without one, opens the **Add marketplace** input |
| `/plugin marketplace list` | `market list` | Prints your marketplace names inline |
| `/plugin marketplace update [name]` | `market update` | Opens the **Marketplaces** tab. With a name, refreshes that marketplace there |
| `/plugin marketplace remove [name]` | `market remove`, `market rm`, `marketplace rm` | Opens the **Marketplaces** tab. With a name, removes that marketplace there |

If you name a plugin that isn't installed in the current project in `/plugin enable`, `disable`, `uninstall`, or `configure`, Claude Code prints `Plugin "<plugin>" is not installed in this project` instead of acting.

## /reload-plugins

Apply pending plugin changes to the running session without restarting it. Pending changes are plugins you installed, updated, enabled, disabled, or edited on disk since the session started.

When you close the `/plugin` panel with pending changes you made in it, Claude Code runs `/reload-plugins` for you. Run it yourself after plugin changes that happen outside the panel, such as a `claude plugin` command you ran in another terminal.

```text theme={null}
/reload-plugins [--force]
```

| Flag | Description |
| :- | :- |
| `--force` | Apply the reload even when it would invalidate the prompt cache. `force` without dashes works too |

### Reload summary

Claude Code reloads every active plugin and prints one summary line, `Reloaded: N plugins · N skills · N agents · N hooks · N plugin MCP servers · N plugin LSP servers`, omitting the plugin MCP server count in a session without an interactive terminal. When any plugin failed, the summary adds `N errors during load. Run /plugin for details.`

The skills count covers every skill a plugin provides, both its `commands/` entries and its `SKILL.md` skills. The agents count is the number of agents loaded in the session, including ones that don't come from plugins.

When a reloaded plugin's [dependencies](https://code.claude.com/docs/en/plugins/dependencies.md) are missing, Claude Code installs them, reloads again, and appends `(+ N dependencies: <names>) resolved` to the summary.

### Reloads that change MCP tools

When the reload would add or remove a plugin MCP server or the `LSP` tool, and that change would invalidate the [prompt cache](https://code.claude.com/docs/en/prompt-caching.md#enabling-or-disabling-a-plugin), Claude Code doesn't apply the reload. It prints a line such as `This reload changes MCP tools (<server>) — your next message will re-read the whole conversation instead of using the cache. Run /reload-plugins --force to apply.` Pass `--force` to apply it anyway.

### Sessions without an interactive terminal

`/reload-plugins` also runs in sessions without an interactive terminal, such as the desktop app, the Agent SDK, and [non-interactive mode](https://code.claude.com/docs/en/headless.md) with `-p`. Requires Claude Code v2.1.260 or later.

In those sessions, the command runs only when you type it into the session yourself, such as in the `-p` prompt or the desktop app's prompt box. When it arrives another way, such as through [Remote Control](https://code.claude.com/docs/en/remote-control.md) or a message relayed from Slack, the command replies `/reload-plugins isn't available over a remote connection in this session.` and reloads nothing.

The reload in those sessions doesn't connect or disconnect plugin MCP servers. Those changes take effect in your next session.

## Flags that load a plugin for one session

Two `claude` flags load a plugin for one session only, without installing it. Both are repeatable.

Plugin authors use them to test a plugin before publishing. For the load-edit-reload workflow, see [Develop without a marketplace](https://code.claude.com/docs/en/plugins/create.md#develop-without-a-marketplace).

| Flag | Description | Example |
| :- | :- | :- |
| `--plugin-dir <path>` | Load a plugin from a directory or a `.zip` archive of one. A folder of plugins loads each child folder that holds a `.claude-plugin/plugin.json`. Each flag takes one path | `claude --plugin-dir ./my-plugin --plugin-dir ./other.zip` |
| `--plugin-url <url>` | Fetch a plugin `.zip` archive from a URL. Repeat the flag, or pass several URLs space-separated in one quoted value | `claude --plugin-url "https://example.com/a.zip https://example.com/b.zip"` |

A plugin that either flag loads is a session-only plugin. [`claude plugin list`](#plugin-list) shows it only when the same flag precedes the subcommand, as in `claude --plugin-dir ./my-plugin plugin list`. The plugin appears as `<name>@inline` under a heading that begins `Session-only plugins`, and `--json` reports its `scope` as `session`.

When a session-only plugin shares a name with an installed plugin, Claude Code loads the session-only copy for that session and skips the installed one. The installed copy loads instead if you disabled the session-only copy with `claude plugin disable <name>@inline`, or if managed settings lock that plugin name. For the precedence, see [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading.md).

An administrator can reject both flags, and folders named in the [`CLAUDE_CODE_PLUGIN_DIRS`](https://code.claude.com/docs/en/env-vars#variables) variable, with the managed [`disableSideloadFlags`](https://code.claude.com/docs/en/settings-reference#disablesideloadflags) setting. Claude Code then prints that the flag is disabled by your organization's managed settings and exits `1` without starting.

From the Agent SDK, the [`plugins`](https://code.claude.com/docs/en/agent-sdk/plugins) option is the equivalent of `--plugin-dir`.

## Next steps

* [Install and manage plugins](https://code.claude.com/docs/en/plugins/install.md): the same operations as steps, with what you see at each one
* [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading.md): what each command changes on disk and which scope takes effect
* [Troubleshoot plugins](https://code.claude.com/docs/en/plugins/troubleshooting.md): install, marketplace, load, and validation error messages with their fixes
* [Plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference.md): the fields `claude plugin validate` checks
