> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Interactive mode

> Complete reference for keyboard shortcuts, input modes, and interactive features in Claude Code sessions.

## Keyboard shortcuts

<Note>
  Keyboard shortcuts may vary by platform and terminal. In [fullscreen rendering](/docs/en/fullscreen), press `?` in the transcript viewer to see available shortcuts there.

  **macOS users**: Option/Alt key shortcuts (`Alt+B`, `Alt+F`, `Alt+Y`, `Alt+P`) require configuring Option as Meta in your terminal. See [Enable Option key shortcuts on macOS](/docs/en/terminal-config#enable-option-key-shortcuts-on-macos) for the setting in each terminal.
</Note>

### General controls

| Shortcut                                                                                     | Description                                                                                                                                                | Context                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C`                                                                                     | Interrupt, or clear input                                                                                                                                  | Interrupts a running operation. If nothing is running, the first press clears the prompt input and a second press exits Claude Code                                                                                                                                                                                                                                                                                                      |
| `Ctrl+X Ctrl+K`                                                                              | Stop all running [background subagents](/docs/en/sub-agents#run-subagents-in-foreground-or-background) in this session. Press twice within 3 seconds to confirm | Subagent control                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Ctrl+D`                                                                                     | Exit Claude Code session                                                                                                                                   | The first press shows a confirmation hint and a second press within 800ms exits. When the prompt has text, `Ctrl+D` deletes the character after the cursor instead                                                                                                                                                                                                                                                                       |
| `Ctrl+G` or `Ctrl+X Ctrl+E`                                                                  | Open in default text editor                                                                                                                                | Edit your prompt or custom response in your default text editor. `Ctrl+X Ctrl+E` is the readline-native binding. Turn on **Show last response in external editor** in `/config` to prepend Claude's previous reply as `#`-commented context above your prompt; Claude Code strips the comment block when you save                                                                                                                        |
| `Ctrl+L`                                                                                     | Redraw screen                                                                                                                                              | Forces a full terminal redraw, keeping input and conversation history. Use this to recover if the display becomes garbled or partially blank. In [fullscreen rendering](/docs/en/fullscreen#clear-the-conversation), if you press `Ctrl+L` once, Claude Code redraws the screen and also shows a hint that pressing it again runs `/clear`. If you press it twice within two seconds, Claude Code runs `/clear` and starts a new conversation |
| `Ctrl+O`                                                                                     | Toggle transcript viewer                                                                                                                                   | Shows detailed tool usage and execution, with a timestamp and the model used on each assistant message. Also expands MCP calls, which collapse to a single line like "Called slack 3 times" by default                                                                                                                                                                                                                                   |
| `Ctrl+R`                                                                                     | Reverse search command history                                                                                                                             | Search through previous commands interactively                                                                                                                                                                                                                                                                                                                                                                                           |
| `Ctrl+V` or `Cmd+V` (iTerm2) or `Alt+V` (Windows and WSL)                                    | Paste image from clipboard                                                                                                                                 | Inserts an `[Image #N]` chip at the cursor so you can reference it positionally in your prompt. On WSL, both `Ctrl+V` and `Alt+V` are bound; use `Alt+V` if your terminal intercepts `Ctrl+V`                                                                                                                                                                                                                                            |
| `Ctrl+B`                                                                                     | Background running tasks                                                                                                                                   | Backgrounds Bash commands and agents. Tmux users press twice                                                                                                                                                                                                                                                                                                                                                                             |
| `Ctrl+T`                                                                                     | Toggle Claude's task checklist                                                                                                                             | Show or hide [Claude's to-do checklist](#task-list) in the status area. This is not the background-task view; use [`/tasks`](/docs/en/commands) to see running shells and subagents                                                                                                                                                                                                                                                           |
| `Ctrl+S`                                                                                     | Stash or restore prompt                                                                                                                                    | With text in the input, stashes it and clears the prompt. Pressed again on an empty prompt, restores the stashed text, cursor position, and pasted content                                                                                                                                                                                                                                                                               |
| `Ctrl+Z`                                                                                     | Suspend Claude Code                                                                                                                                        | Unix only. Suspends the process to your shell; run `fg` to resume                                                                                                                                                                                                                                                                                                                                                                        |
| `Left/Right arrows`                                                                          | Cycle through dialog tabs                                                                                                                                  | Navigate between tabs in permission dialogs and menus                                                                                                                                                                                                                                                                                                                                                                                    |
| `Up/Down arrows` or `Ctrl+P`/`Ctrl+N`                                                        | Move cursor or navigate command history                                                                                                                    | When the input spans more than one visual row, whether wrapped or multiline, first moves the cursor within the prompt. Once the cursor is on the first or last visual row, pressing again navigates command history. While you have messages queued, `Up` from the first row instead [takes them back](#take-back-what-you-queued)                                                                                                       |
| `Esc`                                                                                        | Interrupt Claude, or close a dialog                                                                                                                        | Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far. If you have [messages queued](#queue-messages-while-claude-works), Claude Code sends them next. When a dialog such as a permission prompt is open, `Esc` closes the dialog rather than interrupting Claude                                                                                                                       |
| `Esc` + `Esc`                                                                                | Clear input draft, or rewind                                                                                                                               | When the prompt input contains text, double `Esc` clears it and saves the draft to history so `Up` recalls it. When the input is empty, double `Esc` opens the [rewind menu](/docs/en/checkpointing) to restore or summarize code and conversation from a previous point                                                                                                                                                                      |
| `Shift+Tab`, or `Alt+M` on Windows when the Node or Bun runtime doesn't enable VT input mode | Cycle permission modes                                                                                                                                     | Cycle through `default` (labeled Manual in the mode indicator), `acceptEdits`, `plan`, and, when available, `bypassPermissions` and then `auto`. From `auto`, the first press switches to `default`. See [permission modes](/docs/en/permission-modes).                                                                                                                                                                                       |
| `Option+P` (macOS) or `Alt+P` (Windows/Linux)                                                | Switch model                                                                                                                                               | Switch models without clearing your prompt                                                                                                                                                                                                                                                                                                                                                                                               |
| `Option+T` (macOS) or `Alt+T` (Windows/Linux)                                                | Toggle extended thinking                                                                                                                                   | Enable or disable extended thinking mode. Has no effect on Fable 5, which always uses extended thinking. Works on macOS without configuring Option as Meta                                                                                                                                                                                                                                                                               |
| `Option+O` (macOS) or `Alt+O` (Windows/Linux)                                                | Toggle fast mode                                                                                                                                           | Enable or disable [fast mode](/docs/en/fast-mode)                                                                                                                                                                                                                                                                                                                                                                                             |

### Text editing

| Shortcut                   | Description                          | Context                                                                                                                                                                               |
| :------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Ctrl+A`                   | Move cursor to start of current line | In multiline input, moves to the start of the current logical line                                                                                                                    |
| `Ctrl+E`                   | Move cursor to end of current line   | In multiline input, moves to the end of the current logical line                                                                                                                      |
| `Ctrl+K`                   | Delete to end of line                | Stores deleted text for pasting                                                                                                                                                       |
| `Ctrl+U`                   | Delete from cursor to line start     | Stores deleted text for pasting. Repeat to clear across lines in multiline input. On macOS, terminal emulators including iTerm2 and Terminal.app map `Cmd+Backspace` to this shortcut |
| `Ctrl+W`                   | Delete previous word                 | Stores deleted text for pasting. On macOS, `Option+Delete` also deletes the previous word, and on Windows, `Ctrl+Backspace` does                                                      |
| `Ctrl+Y`                   | Paste deleted text                   | Paste text deleted with `Ctrl+K`, `Ctrl+U`, or `Ctrl+W`                                                                                                                               |
| `Alt+Y` (after `Ctrl+Y`)   | Cycle paste history                  | After pasting, cycle through previously deleted text. Requires [Option as Meta](#keyboard-shortcuts) on macOS                                                                         |
| `Alt+B`                    | Move cursor back one word            | Word navigation. Requires [Option as Meta](#keyboard-shortcuts) on macOS                                                                                                              |
| `Alt+F`                    | Move cursor forward one word         | Word navigation. Requires [Option as Meta](#keyboard-shortcuts) on macOS                                                                                                              |
| `Ctrl+_` or `Ctrl+Shift+-` | Undo last input edit                 | Restores the previous input text and cursor position                                                                                                                                  |

### Theme and display

| Shortcut | Description                                | Context                                                                                                      |
| :------- | :----------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `Ctrl+T` | Toggle syntax highlighting for code blocks | Only works inside the `/theme` picker menu. Controls whether code in Claude's responses uses syntax coloring |

### Multiline input

| Method           | Shortcut       | Context                                                                                                                                                                            |
| :--------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quick escape     | `\` + `Enter`  | Works in all terminals                                                                                                                                                             |
| Option key       | `Option+Enter` | After enabling [Option as Meta](/docs/en/terminal-config#enable-option-key-shortcuts-on-macos) on macOS                                                                                 |
| Shift+Enter      | `Shift+Enter`  | Native in iTerm2, WezTerm, Ghostty, Kitty, Warp, Apple Terminal, Windows Terminal. For other terminals, see [Enter multiline prompts](/docs/en/terminal-config#enter-multiline-prompts) |
| Control sequence | `Ctrl+J`       | Works in any terminal without configuration                                                                                                                                        |
| Paste mode       | Paste directly | For code blocks, logs                                                                                                                                                              |

### Quick commands

| Shortcut           | Description                    | Notes                                                                                                                                                                                                                                                                                                                                            |
| :----------------- | :----------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` at start       | Command or skill               | See [commands](#commands) and [skills](/docs/en/skills)                                                                                                                                                                                                                                                                                               |
| `!` at start       | Shell mode                     | Run a command directly, add its output to the session, and have Claude respond to it                                                                                                                                                                                                                                                             |
| `@`                | File path mention              | Trigger file path autocomplete. In sessions with [cross-session messaging](/docs/en/cross-session-messaging#message-another-session), when you type at least one letter after the `@`, Claude Code also suggests your other live sessions on this machine, so you can tell Claude to message the one you pick. Requires Claude Code v2.1.232 or later |
| `:`                | Emoji shortcode                | Type a full `:name:` to insert the emoji, or two or more characters for suggestions. See [Emoji shortcodes](#emoji-shortcodes). Requires Claude Code v2.1.217 or later                                                                                                                                                                           |
| `?` on empty input | Toggle the shortcut help panel | Typing `?` when the input already contains text inserts the character                                                                                                                                                                                                                                                                            |

### Transcript viewer

When the transcript viewer is open (toggled with `Ctrl+O`), these shortcuts are available. Run `/tui` with no argument to check which renderer is active. `Ctrl+E` can be rebound via [`transcript:toggleShowAll`](/docs/en/keybindings).

| Shortcut             | Description                                                                                                                                                                                                           |
| :------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?`                  | Toggle the keyboard shortcut help panel. Requires [fullscreen rendering](/docs/en/fullscreen)                                                                                                                              |
| `{` / `}`            | Jump to the previous or next user prompt, like vim paragraph motion. Requires [fullscreen rendering](/docs/en/fullscreen)                                                                                                  |
| `Ctrl+E`             | Toggle show all content. Available in the classic renderer only, not in [fullscreen rendering](/docs/en/fullscreen)                                                                                                        |
| `[`                  | Write the full conversation to your terminal's native scrollback so `Cmd+F`, tmux copy mode, and other native tools can search it. Requires [fullscreen rendering](/docs/en/fullscreen#search-and-review-the-conversation) |
| `v`                  | Write the conversation to a temporary file and open it in `$VISUAL` or `$EDITOR`. Requires [fullscreen rendering](/docs/en/fullscreen)                                                                                     |
| `q`, `Ctrl+C`, `Esc` | Exit transcript view. All three can be rebound via [`transcript:exit`](/docs/en/keybindings)                                                                                                                               |

### Voice input

| Shortcut            | Description     | Notes                                                                                                                                                                            |
| :------------------ | :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold or tap `Space` | Voice dictation | Requires [voice dictation](/docs/en/voice-dictation) to be enabled. Hold to record, or run `/voice tap` for tap-to-toggle. [Rebindable](/docs/en/voice-dictation#rebind-the-dictation-key) |

## Commands

Type `/` in Claude Code to see all available commands, or type `/` followed by any letters to filter. The `/` menu shows everything you can invoke: built-in commands, bundled and user-authored [skills](/docs/en/skills), and commands contributed by [plugins](/docs/en/plugins) and [MCP servers](/docs/en/mcp#use-mcp-prompts-as-commands). Not all built-in commands are visible to every user since some depend on your platform or plan.

In [fullscreen rendering](/docs/en/fullscreen#use-the-mouse), the `/` command and `@` file suggestion lists also respond to the mouse: hovering highlights a row and clicking accepts it.

See the [commands reference](/docs/en/commands) for the full list of commands included in Claude Code.

## Vim editor mode

Enable vim-style editing via `/config` → Editor mode.

### Mode switching

| Command | Action                                | From mode      |
| :------ | :------------------------------------ | :------------- |
| `Esc`   | Enter NORMAL mode                     | INSERT, VISUAL |
| `i`     | Insert before cursor                  | NORMAL         |
| `I`     | Insert at beginning of line           | NORMAL         |
| `a`     | Insert after cursor                   | NORMAL         |
| `A`     | Insert at end of line                 | NORMAL         |
| `o`     | Open line below                       | NORMAL         |
| `O`     | Open line above                       | NORMAL         |
| `v`     | Start character-wise visual selection | NORMAL         |
| `V`     | Start line-wise visual selection      | NORMAL         |

### Remap INSERT-mode key sequences

The [`vimInsertModeRemaps`](/docs/en/settings#available-settings) setting maps a two-key INSERT-mode sequence to Escape, so a mapping like `jj` returns you to NORMAL mode. Requires Claude Code v2.1.208 or later.

The following `~/.claude/settings.json` example turns on vim mode and maps `jj` to Escape:

```json theme={null}
{
  "editorMode": "vim",
  "vimInsertModeRemaps": { "jj": "<Esc>" }
}
```

Each key is exactly two printable characters typed in sequence, and `"<Esc>"` is the only supported target. Entries with a different length or target are ignored.

Typing the first character of a sequence inserts it normally. Pressing the second character within one second removes that pending character and switches to NORMAL mode, leaving neither character in your input. After the one-second window, or if a different key follows, both characters stay as literal text, so you can still type a word containing the sequence by pausing between the two keys.

Claude Code reads this setting from your user settings file, the `--settings` flag, and [managed settings](/docs/en/permissions#managed-settings) only. Entries in a project's `.claude/settings.json` or `.claude/settings.local.json` are ignored, so a checked-out repository can't remap your keystrokes.

### Navigation (NORMAL mode)

| Command         | Action                                                                                                                                              |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h`/`j`/`k`/`l` | Move left/down/up/right                                                                                                                             |
| `Space`         | Move right                                                                                                                                          |
| `w`             | Next word                                                                                                                                           |
| `e`             | End of word                                                                                                                                         |
| `b`             | Previous word                                                                                                                                       |
| `0`             | Beginning of line                                                                                                                                   |
| `$`             | End of line                                                                                                                                         |
| `^`             | First non-blank character                                                                                                                           |
| `gg`            | Beginning of input                                                                                                                                  |
| `G`             | End of input                                                                                                                                        |
| `f{char}`       | Jump to next occurrence of character                                                                                                                |
| `F{char}`       | Jump to previous occurrence of character                                                                                                            |
| `t{char}`       | Jump to just before next occurrence of character                                                                                                    |
| `T{char}`       | Jump to just after previous occurrence of character                                                                                                 |
| `;`             | Repeat last f/F/t/T motion                                                                                                                          |
| `,`             | Repeat last f/F/t/T motion in reverse                                                                                                               |
| `/`             | Open reverse history search, same as `Ctrl+R`. The empty search prompt shows a hint: press `Esc` then `i` then `/` to open the command menu instead |

<Note>
  In vim NORMAL mode, if the cursor is at the beginning or end of input and can't move further, `j`/`k` and `↑`/`↓` navigate command history instead. `←` on an empty prompt opens [agent view](/docs/en/agent-view) from NORMAL mode as well as INSERT; before v2.1.219, `←` on an empty prompt did nothing in NORMAL mode.
</Note>

### Editing (NORMAL mode)

| Command        | Action                                                                                                                    |
| :------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `x`            | Delete character                                                                                                          |
| `dd`           | Delete line                                                                                                               |
| `D`            | Delete to end of line                                                                                                     |
| `dw`/`de`/`db` | Delete word/to end/back                                                                                                   |
| `cc`           | Change line                                                                                                               |
| `C`            | Change to end of line                                                                                                     |
| `cw`/`ce`/`cb` | Change word/to end/back                                                                                                   |
| `s`            | Substitute character: delete the character under the cursor and enter INSERT mode. Requires Claude Code v2.1.211 or later |
| `S`            | Substitute line: clear the line and enter INSERT mode. Requires Claude Code v2.1.211 or later                             |
| `yy`/`Y`       | Yank (copy) line                                                                                                          |
| `yw`/`ye`/`yb` | Yank word/to end/back                                                                                                     |
| `p`            | Paste after cursor                                                                                                        |
| `P`            | Paste before cursor                                                                                                       |
| `>>`           | Indent line                                                                                                               |
| `<<`           | Dedent line                                                                                                               |
| `J`            | Join lines                                                                                                                |
| `u`            | Undo                                                                                                                      |
| `.`            | Repeat last change                                                                                                        |

### Text objects (NORMAL mode)

Text objects work with operators like `d`, `c`, and `y`:

| Command   | Action                                   |
| :-------- | :--------------------------------------- |
| `iw`/`aw` | Inner/around word                        |
| `iW`/`aW` | Inner/around WORD (whitespace-delimited) |
| `i"`/`a"` | Inner/around double quotes               |
| `i'`/`a'` | Inner/around single quotes               |
| `i(`/`a(` | Inner/around parentheses                 |
| `i[`/`a[` | Inner/around brackets                    |
| `i{`/`a{` | Inner/around braces                      |

### Visual mode

Press `v` for character-wise selection or `V` for line-wise selection. Motions extend the selection, and operators act on it directly.

| Command          | Action                                               |
| :--------------- | :--------------------------------------------------- |
| `d`/`x`          | Delete selection                                     |
| `y`              | Yank selection                                       |
| `c`/`s`          | Change selection                                     |
| `p`              | Replace selection with register contents             |
| `r{char}`        | Replace every selected character with `{char}`       |
| `~`/`u`/`U`      | Toggle, lowercase, or uppercase selection            |
| `>`/`<`          | Indent or dedent selected lines                      |
| `J`              | Join selected lines                                  |
| `o`              | Swap cursor and anchor                               |
| `iw`/`aw`/`i"`/… | Select a text object                                 |
| `v`/`V`          | Toggle between character-wise and line-wise, or exit |

Block-wise visual mode with `Ctrl+V` is not supported.

## Command history

Claude Code keeps a history of the prompts you type, and Up-arrow recall reaches prompts from past sessions of the same project:

* Input history is stored per working directory
* Running `/clear` starts a new session: recall then lists the new session's prompts first, with earlier sessions' prompts after them. The previous session's conversation is preserved and can be resumed.
* Submitting the same prompt twice in a row records one history entry, so pressing Up steps to the previous distinct prompt
* When you recall a prompt that included pasted text, Claude Code sends the full pasted content again when you resubmit. If the content has since been [cleaned up](/docs/en/claude-directory#cleaned-up-automatically), Claude Code doesn't send the literal `[Pasted text #N]` string; see [Paste large content](/docs/en/terminal-config#paste-large-content) for what happens to the prompt
* History expansion with `!` is disabled by default

### Reverse search with Ctrl+R

Press `Ctrl+R` to interactively search through your command history. In [fullscreen rendering](/docs/en/fullscreen), `Ctrl+R` opens a search dialog instead: type to filter, press `Up` and `Down` to move through matches, and press `Ctrl+S` to cycle the scope through this session, this project, and all projects. Press `Enter` or `Tab` to place a match in the prompt input, or `Esc` to cancel. The steps below describe the classic renderer's inline search:

1. **Start search**: press `Ctrl+R` to activate reverse history search
2. **Type query**: enter text to search for in previous commands. The search term is highlighted in matching results
3. **Navigate matches**: press `Ctrl+R` again to cycle through older matches
4. **Search scope**: the inline search always searches prompts from all projects
5. **Accept match**:
   * Press `Tab` or `Esc` to accept the current match and continue editing
   * Press `Enter` to accept and execute the command immediately
6. **Cancel search**:
   * Press `Ctrl+C` to cancel and restore your original input
   * Press `Backspace` on empty search to cancel

The inline search scans your full prompt history, newest first, with duplicates collapsed to the newest occurrence. The fullscreen dialog searches your whole prompt history in the selected scope, newest first, with duplicates collapsed to the newest occurrence: the most recent prompts appear immediately, and matches from older prompts fill in as Claude Code loads the rest. Matching prompts display with the search term highlighted, so you can find and reuse previous inputs.

Accepting a match or canceling the search takes effect immediately, even while Claude Code is still loading the history.

## Background Bash commands

Claude Code supports running Bash commands in the background, allowing you to continue working while long-running processes execute.

### How backgrounding works

When Claude Code runs a command in the background, it runs the command asynchronously and immediately returns a background task ID. Claude Code can respond to new prompts while the command continues executing in the background.

To run commands in the background, you can either:

* Prompt Claude Code to run a command in the background
* Press `Ctrl+B` to move a regular Bash tool invocation to the background. Tmux users must press `Ctrl+B` twice due to tmux's prefix key.

**Key features:**

* Output is written to a file and Claude can retrieve it using the Read tool
* Background tasks have unique IDs for tracking and output retrieval
* Background tasks are automatically cleaned up when Claude Code exits. If you background the session instead of exiting it, Claude Code hands them to the background session, where they keep running. See [background a running session](/docs/en/agent-view#from-inside-a-session)
* Background tasks are automatically terminated if output exceeds 5GB, with a note in stderr explaining why
* On macOS and Linux, Claude Code terminates running background tasks when the operating system signals memory pressure, provided the session has been idle for at least 30 minutes and no turn or subagent is running. Set [`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`](/docs/en/env-vars) to `1` to turn this off. Requires Claude Code v2.1.193 or later. Background commands owned by a [subagent](/docs/en/sub-agents) are instead terminated after 60 minutes, configurable in milliseconds with [`CLAUDE_SUBAGENT_BG_SHELL_MAX_MS`](/docs/en/env-vars). A command owned by a subagent running in the foreground also ends when that subagent gives its final response; see [Background commands](/docs/en/tools-reference#background-commands) in the tools reference. Before v2.1.218, neither the memory-pressure reap nor the 60-minute limit covered commands moved to the background with `Ctrl+B`

To disable all background task functionality, set the `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` environment variable to `1`. See [Environment variables](/docs/en/env-vars) for details.

**Common backgrounded commands:**

* Build tools (webpack, vite, make)
* Package managers (npm, yarn, pnpm)
* Test runners (jest, pytest)
* Development servers
* Long-running processes (docker, terraform)

### Shell mode with `!` prefix

Run shell commands directly without going through Claude by prefixing your input with `!`:

```bash theme={null}
! npm test
! git status
! ls -la
```

Shell mode:

* Adds the command and its output to the conversation context
* Shows real-time progress and output
* Supports the same `Ctrl+B` backgrounding for long-running commands
* Doesn't require Claude to interpret or approve the command
* Supports history-based autocomplete: type a partial command and press `Tab` to complete from previous `!` commands in the current project
* Supports live file path autocomplete as of v2.1.193 on all platforms: type a token containing a forward slash, such as `./src/` or `~/`, to see a dropdown of matching files and directories, then press `Tab` to accept. Use forward slashes on Windows too; the dropdown is triggered by `/`, not `\`
* Exit with `Escape`, `Backspace`, or `Ctrl+U` on an empty prompt
* Pasting text that starts with `!` into an empty prompt enters shell mode automatically, matching typed `!` behavior

Claude responds to the command output automatically once it lands in the transcript, so you can run `! npm test` and get an explanation of the failures without a second prompt. The response costs the same as sending a normal prompt. To restore the earlier behavior where the output is added to context without a response, set [`respondToBashCommands`](/docs/en/settings#available-settings) to `false` in `settings.json`. Before v2.1.186, shell mode always added output to context without a response.

## Queue messages while Claude works

Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of interrupting the turn, and lists the queued entries above the input box until it sends them. You can queue `!` [shell commands](#shell-mode-with-prefix) and most [commands](/docs/en/commands) the same way, apart from the commands, such as `/status`, that Claude Code runs as soon as you send them.

### When Claude Code sends what you queued

When a queued entry reaches Claude depends on what you queued.

* Messages: if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. When the turn ends, Claude Code sends the messages that are still queued as the next turn, each as a separate message
* Commands and shell commands: Claude Code holds them until the turn ends, then runs them one at a time

Press `Esc` to interrupt the turn instead. Claude Code keeps what you queued and sends it right away.

### Take back what you queued

Press `Up` from the first line of the input box to take back the queued messages and commands. Claude Code removes them from the queue and puts them in the input box, one per line, ahead of any text you had typed. Edit the text and press `Enter` to queue it again as one entry, or clear the input box to drop it.

Claude Code takes back queued shell commands only when the input box is empty and you have nothing else queued, and it switches the input box to shell mode when it does. Otherwise it leaves them in the queue, listed with their `!` prefix, and runs them after the turn ends.

## Prompt suggestions

When you first open a session, Claude Code shows a grayed-out example command in the prompt input to help you get started. It picks this from your project's git history, so the example reflects files you've been working on recently.

After Claude responds, Claude Code can suggest your next prompt based on your conversation history, such as a follow-up step from a multi-part request or a natural continuation of your workflow.

* Press `Tab` or `Right arrow` to place the suggestion in the prompt input, then `Enter` to submit
* Start typing to dismiss it

Claude Code generates each of these next-prompt suggestions with a background request that reuses the conversation's prompt cache, so the additional cost is minimal.

### When Claude Code skips suggestions

In interactive mode, Claude Code leaves prompt suggestions off by default and hides the **Prompt suggestions** toggle in `/config` when it doesn't evaluate feature flags. That happens in these cases:

* You use Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry as the model provider, unless a host platform that embeds Claude Code sets [`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`](/docs/en/env-vars) to a true value such as `1`
* You are signed in to a [Claude apps gateway](/docs/en/claude-apps-gateway)
* You set [`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, or `DISABLE_GROWTHBOOK`](/docs/en/env-vars#features-that-need-feature-flag-fetching) to a value that turns off feature-flag evaluation

Outside those cases, if you start a session before Claude Code has ever fetched feature flags, such as your first session after installing on a slow network, Claude Code can also leave suggestions off and hide the **Prompt suggestions** toggle for that session. It shows them starting with the next session after a fetch succeeds.

Claude Code also skips individual suggestions in several situations, including:

* The prompt cache is cold, to avoid unnecessary cost
* After the first turn of a conversation, in some sessions
* The previous response ended in an error
* While you're in plan mode
* In an [agent team](/docs/en/agent-teams), in teammates' sessions by default. The lead's session shows suggestions

In print mode, Claude Code doesn't generate suggestions by default. Pass [`--prompt-suggestions`](/docs/en/cli-reference#cli-flags) with `-p "<prompt>" --output-format stream-json --verbose` to have Claude Code emit a `prompt_suggestion` message after each turn that generates one. The generator skips very short conversations and cold prompt caches here too, so a single short `-p` query can emit none.

### Turn prompt suggestions off

To disable prompt suggestions entirely, use any of the following:

* Turn off **Prompt suggestions** in `/config`
* Set [`promptSuggestionEnabled`](/docs/en/settings#available-settings) to `false` in your settings file
* Set the `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` environment variable to `false`, which takes precedence over the setting:
  ```bash theme={null}
  export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false
  ```

To turn prompt suggestions off across an organization, set `promptSuggestionEnabled` to `false` in [managed settings](/docs/en/settings#settings-files). Also set `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` to `false` under the managed [`env`](/docs/en/settings#environment-variables) key so that users can't re-enable them with their own environment variable.

## Emoji shortcodes

Type a `:` followed by an emoji shortcode in the prompt input to insert the emoji. Requires Claude Code v2.1.217 or later.

* Type a complete shortcode such as `:heart:` and Claude Code replaces it with ❤️ as soon as you type the closing `:`
* Type `:` plus at least two characters of a name, such as `:hea`, to open a suggestion popup, then press `Tab` or `Enter` to insert the highlighted emoji

The shortcode must start the input or follow a space, so a `:` inside a word or URL doesn't open suggestions.

To turn the feature off, set [`emojiCompletionEnabled`](/docs/en/settings#available-settings) to `false` in `settings.json`. This disables both the suggestion popup and the inline replacement.

## Check spelling as you type

Claude Code can underline misspelled words in the prompt input while you type. It checks only the text in the input box, never Claude's replies or your files. It also checks nothing while the input box is in [shell mode](#shell-mode-with-prefix), `Ctrl+R` history search, or [voice dictation](/docs/en/voice-dictation).

Spell checking is off by default, and Claude Code checks nothing in [screen reader mode](/docs/en/accessibility). Requires Claude Code v2.1.235 or later.

### Prerequisites

* Install [aspell](https://github.com/GNUAspell/aspell), [hunspell](https://github.com/hunspell/hunspell), or [ispell](https://en.wikipedia.org/wiki/Ispell) and make sure it's on your `PATH`. Claude Code runs the first of the three it finds, in that order, on every platform, including a `.cmd` shim a package manager installs on Windows.
* To check that the program is on your `PATH`, run `aspell --version`, `hunspell --version`, or `ispell -v` in your terminal. A "command not found" error means it isn't on your `PATH` yet.

### Turn spell checking on or off

Claude Code reads the [`spellcheck`](/docs/en/settings#available-settings) setting from three places, and ignores it in a project's `.claude/settings.json` and `.claude/settings.local.json`. Turn it on from whichever one you use:

<Tabs>
  <Tab title="User settings">
    Add `spellcheck` to `~/.claude/settings.json`. It applies in every project you open, like the rest of your [user settings](/docs/en/settings#settings-files):

    ```json theme={null}
    {
      "spellcheck": { "enabled": true }
    }
    ```
  </Tab>

  <Tab title="Command line">
    Save `spellcheck` in a JSON file, such as `spellcheck.json`:

    ```json theme={null}
    {
      "spellcheck": { "enabled": true }
    }
    ```

    Then pass the file to `--settings`. It applies to that session only:

    ```bash theme={null}
    claude --settings spellcheck.json
    ```
  </Tab>

  <Tab title="Managed settings">
    Add `spellcheck` to one of your organization's [managed settings sources](/docs/en/permissions#managed-settings). It applies to every user who receives those settings, and they can't turn it off:

    ```json theme={null}
    {
      "spellcheck": { "enabled": true }
    }
    ```
  </Tab>
</Tabs>

To check that spell checking is on, type a misspelled word and a space. Claude Code underlines the word. If it doesn't, see [When Claude Code underlines nothing](#when-claude-code-underlines-nothing). To turn spell checking off again, set `enabled` to `false` in the same place, or remove `spellcheck`.

To choose which of the three programs Claude Code runs, which dictionary it uses, or the underline color, add any of these fields next to `enabled`, in the same place:

* `checker`: `aspell`, `hunspell`, or `ispell`. Claude Code doesn't fall back from a checker you name, and treats any other value as `auto`.
* `language`: a dictionary name in your checker's form, such as `en_GB`. Claude Code ignores any value that isn't a plain dictionary name, such as a path or a name with spaces, and the checker uses its default dictionary.
* `color`: a color name such as `yellow`, or a `#rrggbb`, `#rgb`, `rgb(r,g,b)`, `ansi256(n)`, or `ansi:<name>` value. Claude Code uses your theme's error color by default and for any value it doesn't recognize.

For example, this `spellcheck` setting runs hunspell with its `en_GB` dictionary and underlines words in yellow. It works the same in `~/.claude/settings.json`, in the file you pass to `--settings`, and in managed settings:

```json theme={null}
{
  "spellcheck": {
    "enabled": true,
    "checker": "hunspell",
    "language": "en_GB",
    "color": "yellow"
  }
}
```

If more than one of the three places has a `spellcheck` setting, Claude Code uses only one of them: managed settings first, then `--settings`, then user settings. It doesn't combine fields from two places. For example, when `--settings` sets `spellcheck`, a `language` in your user settings has no effect.

### What Claude Code underlines

Shortly after you pause typing, Claude Code underlines the words the dictionary doesn't know. It leaves the word you're still typing alone until you move past it, and it never changes your text. It also skips text that looks like code:

* Commands such as `/help`, `@` mentions, URLs, file paths, and flags such as `--verbose`
* Words with digits, underscores, or a capital letter after the first, and text in backticks

Claude Code also skips Chinese, Japanese, Korean, Thai, Lao, Khmer, and Myanmar text.

Claude Code has no word list of its own: a word is misspelled when your checker says so. To stop Claude Code from underlining a word, add the word to your checker's personal dictionary, following the checker's own documentation. Claude Code picks up the new word after you restart it.

### When Claude Code underlines nothing

Claude Code underlines nothing when it can't keep a checker running:

* No checker is installed, or the one you named in `checker` is missing
* The checker fails twice in a row, at startup or later in the session. Claude Code restarts it after the first failure and stops checking after the second, until you restart Claude Code
* The checker takes more than 15 seconds to answer, three times. Each time, Claude Code leaves the words it was waiting on unmarked; after the third, it stops checking until you restart Claude Code

To find out which of these happened, start `claude --debug` with spell checking on and type a word. Then look for the `[spellcheck]` lines in the debug log at `~/.claude/debug/<session-id>.txt`. One line names the program Claude Code started, or lists the ones it looked for and didn't find. Later lines say why it stopped. A missing-dictionary error there means the checker has no dictionary for your `language` value, or no default one when `language` is unset. Install one, or set `language` to a dictionary you have.

## Side questions with /btw

Use `/btw` to ask a question about your current work without adding to the conversation history.

```
/btw what was the name of that config file again?
```

Claude answers a side question from what's already in the conversation: your messages, its replies, and the tool results it has gathered. You can ask about code Claude has already read, decisions it made earlier, or anything else from the session. A later side question also sees your earlier side questions: Claude Code replays the newest 20 exchanges with each ask, until you clear them. The question and answer never enter the conversation history. In the terminal, they appear in a dismissible overlay. The terminal keeps the thread in memory: press `x` to clear the earlier exchanges, and it's gone when you exit Claude Code.

In the [VS Code extension](/docs/en/vs-code#use-the-prompt-box)'s chat panel, `/btw` opens a panel rather than the overlay this section describes, and you ask follow-up questions right in the panel. The panel's thread survives window reloads, on the retention schedule that page describes. You need the extension at v2.1.227 or later. Earlier extension versions don't offer `/btw`.

* **Available while Claude is working**: you can run `/btw` even while Claude is processing a response. The side question runs independently and doesn't interrupt the main turn. It sees everything in the conversation so far, except the reply Claude is still writing.
* **No tool access**: side questions answer only from what is already in context. Claude can't read files, run commands, or search when answering a side question.
* **Single response**: there are no follow-up turns in the overlay. To continue the thread, ask another `/btw` question. To continue with full tool access, fork this question and answer into their own session with `f`.
* **Low cost**: while the conversation's [prompt cache](/docs/en/prompt-caching) is warm, a side question costs little beyond the answer itself.

Your five newest earlier side questions appear as a dimmed list above the current answer, with a count of any older ones. They stay out of the conversation history.

To return to the overlay after dismissing it, run `/btw` with no question. The overlay reopens on your most recent exchange. Press `Left` to step back through earlier answers. Before v2.1.212, `/btw` without a question printed a usage message instead.

Once the answer appears, the overlay accepts these keys.

| Key                        | Action                                                                                                                                                                                                                                                                    |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Space`, `Enter`, `Escape` | Dismiss the answer and return to the prompt                                                                                                                                                                                                                               |
| `Up` / `Down`              | Scroll the answer                                                                                                                                                                                                                                                         |
| `Left` / `Right`           | Step between this answer and your earlier `/btw` answers. `Left` moves to older answers and `Right` returns toward the current one. Requires Claude Code v2.1.187 or later                                                                                                |
| `c`                        | Copy the answer to your clipboard as raw Markdown. Use this instead of mouse selection, which captures the hard-wrapped terminal rendering rather than the source text                                                                                                    |
| `f`                        | Fork into a new session. The fork inherits the parent conversation plus this question and answer as real transcript turns, so you can continue with full tool access. The original session is preserved under [`/resume`](/docs/en/commands). Available in local sessions only |
| `x`                        | Clear the list of earlier `/btw` exchanges shown above the current answer                                                                                                                                                                                                 |

`/btw` is the inverse of a [subagent](/docs/en/sub-agents): it sees your full conversation but has no tools, while a subagent has full tools but starts with an empty context. Use `/btw` to ask about what Claude already knows from this session; use a subagent to go find out something new.

## Task list

The task list is Claude's to-do checklist: items Claude created to plan multi-step work, with indicators showing what's pending, in progress, or complete. It's separate from the background-task view. To see running shells and subagents, use [`/tasks`](/docs/en/commands) instead.

On [Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and later versions of those families](/docs/en/tools-reference#task-tool-availability), Claude keeps track of multi-step work without a written checklist, and Claude Code doesn't provide the tools that fill this list, so it stays empty. If you'd like the task list on those models anyway, opt in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or one of the other ways under [Task tool availability](/docs/en/tools-reference#task-tool-availability). On earlier models such as Opus 4.7, and after you opt in, the task list works as follows:

* Press `Ctrl+T` to toggle the task list view. The display shows up to five tasks at a time. When Claude hasn't created any checklist items yet, the toggle has no visible effect because there's nothing to display
* To see all tasks or clear them, ask Claude directly: "show me all tasks" or "clear all tasks"
* Tasks persist across context compactions, helping Claude stay organized on larger projects
* To share a task list across sessions, set `CLAUDE_CODE_TASK_LIST_ID` to use a named directory in `~/.claude/tasks/`: `CLAUDE_CODE_TASK_LIST_ID=my-project claude`

## Session recap

When you return to the terminal after stepping away, Claude Code shows a one-line recap of what happened in the session so far. The recap generates in the background once at least three minutes have passed since the last completed turn and the terminal is unfocused, so it's ready when you switch back. Recaps only appear once the session has at least three turns, and never twice in a row.

Run `/recap` to generate a summary on demand. To turn automatic recaps off, open `/config` and disable **Session recap**.

Session recap is on by default for every plan and provider. The recap is always skipped in non-interactive mode.

## PR review status

When working on a branch with an open pull request, Claude Code displays a clickable PR link in the footer, such as "PR #446". The link has a colored underline indicating the review state:

* Green: approved
* Yellow: pending review
* Red: changes requested
* Gray: draft

The badge disappears once the pull request merges or closes. `Cmd+click` (macOS) or `Ctrl+click` (Windows/Linux) the link to open the pull request in your browser. How often Claude Code refreshes the status depends on your provider:

* **Anthropic API with [feature-flag fetching](/docs/en/env-vars#features-that-need-feature-flag-fetching) on**: about every 90 seconds while you're active in the session, and less often while you're idle, while your terminal is unfocused, or while Claude Code keeps finding no pull request for the branch
* **Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, Claude Platform on AWS, or feature-flag fetching off**: every 60 seconds

On either schedule, Claude Code also refreshes as soon as a `git push`, or a `gh pr` command that changes the pull request such as `gh pr create` or `gh pr merge`, succeeds in the session. After an hour without input from you, Claude Code stops refreshing, and your next prompt starts it again.

Claude Code renders the badge as a hyperlink even when it can't detect hyperlink support in your terminal, which commonly happens over SSH or in tmux. Set [`FORCE_HYPERLINK=0`](/docs/en/env-vars) to render the badge as plain text.

<Note>
  PR status for GitHub repositories requires the `gh` CLI to be installed and authenticated with `gh auth login`.
</Note>

### GitLab merge requests

When you work on a branch with an open GitLab merge request, Claude Code shows a clickable `MR !N` badge in the footer slot that otherwise holds the GitHub PR link. `!N` is GitLab's own reference syntax for merge request number N. The colored underline shows the merge request's state:

* Green: GitLab reports the merge request as mergeable
* Yellow: any other open state
* Gray: draft

The badge disappears once the merge request merges or closes. Claude Code checks merge request status on the same schedule as the GitHub badge, and refreshes as soon as a `glab mr create` or `git push` succeeds in the session.

To get the badge, you need:

* Claude Code v2.1.234 or later
* A repository remote that points at your GitLab host, either gitlab.com or a self-managed instance
* The [`glab` CLI](https://gitlab.com/gitlab-org/cli) on your `PATH`, authenticated with `glab auth login`

Claude Code ignores `glab`'s token environment variables, such as `GITLAB_TOKEN`, when it checks status, so you get no badge from an exported token alone. Claude Code also looks for `glab` and for its login once per session, so restart Claude Code after you install `glab` or run `glab auth login`.

## See also

* [Skills](/docs/en/skills) - Custom prompts and workflows
* [Checkpointing](/docs/en/checkpointing) - Rewind Claude's edits and restore previous states
* [CLI reference](/docs/en/cli-reference) - Command-line flags and options
* [Settings](/docs/en/settings) - Configuration options
* [Memory management](/docs/en/memory) - Managing CLAUDE.md files
