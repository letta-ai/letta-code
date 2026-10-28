> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Interactive mode

> Complete reference for keyboard shortcuts, input modes, and interactive features in Claude Code sessions.

## Keyboard shortcuts

> [!NOTE]
>
> Keyboard shortcuts may vary by platform and terminal. In [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md), press `?` in the transcript viewer to see available shortcuts there.
>
> **macOS users**: Option/Alt key shortcuts (`Alt+B`, `Alt+F`, `Alt+D`, `Alt+Y`, `Alt+P`) require configuring Option as Meta in your terminal. See [Enable Option key shortcuts on macOS](https://code.claude.com/docs/en/terminal-config.md#enable-option-key-shortcuts-on-macos) for the setting in each terminal.

### General controls

| Shortcut | Description | Context |
| :- | :- | :- |
| `Ctrl+C` | Interrupt, or clear input | Interrupts a running operation. If nothing is running, the first press clears the prompt input and a second press exits Claude Code. To get a cleared draft back, see [Bring back a cleared draft](#bring-back-a-cleared-draft) |
| `Ctrl+X Ctrl+K` | Stop all running [background subagents](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) in this session, and turn off [artifact auto-replies](https://code.claude.com/docs/en/artifacts.md#let-claude-reply-to-comments-on-its-own) for the rest of it. Press twice within 3 seconds to confirm. You can press it while a background subagent's permission prompt is open | Subagent control |
| `Ctrl+D` | Exit Claude Code session | The first press shows a confirmation hint and a second press within 800ms exits. When the prompt has text, `Ctrl+D` deletes the character after the cursor instead |
| `Ctrl+G` or `Ctrl+X Ctrl+E` | Open in default text editor | Edit your prompt or custom response in your default text editor. `Ctrl+X Ctrl+E` is the readline-native binding. Turn on **Show last response in external editor** in `/config` to prepend Claude's previous reply as `#`-commented context above your prompt; Claude Code strips the comment block when you save |
| `Ctrl+L` | Redraw the screen | Forces a full terminal redraw, keeping input and conversation history. Use this to recover if the display becomes garbled or partially blank. See [Clear the conversation](https://code.claude.com/docs/en/fullscreen.md#clear-the-conversation) for fullscreen rendering |
| `Ctrl+O` | Toggle transcript viewer | Shows detailed tool usage and execution, with a timestamp and the model used on each assistant message. Also expands lines that collapse by default, such as MCP calls, shown as a single `Called slack 3 times` line, and [messages from your other sessions](https://code.claude.com/docs/en/cross-session-messaging.md#what-a-message-looks-like), shown as a one-line `Message from @<sender>` preview |
| `Ctrl+R` | Reverse search command history | Search through previous commands interactively |
| `Ctrl+V` or `Cmd+V` (iTerm2) or `Alt+V` (Windows and WSL) | Paste image from clipboard | Inserts an `[Image #N]` chip at the cursor so you can reference it positionally in your prompt. On WSL, both `Ctrl+V` and `Alt+V` are bound; use `Alt+V` if your terminal intercepts `Ctrl+V` |
| `Ctrl+B` | Background running tasks | Backgrounds Bash commands and agents. Tmux users press twice |
| `Ctrl+T` | Toggle Claude's task checklist | Show or hide [Claude's to-do checklist](#task-list) in the status area. This is not the background-task view; use [`/tasks`](https://code.claude.com/docs/en/commands) to see running shells and subagents |
| `Ctrl+S` | Stash or restore prompt | With text in the input, stashes it and clears the prompt. Pressed again on an empty prompt, restores the stashed text, cursor position, pasted content, and input mode, so a stashed `!` [shell command](#shell-mode-with-prefix) comes back in shell mode |
| `Ctrl+Z` | Suspend Claude Code | Unix only. Suspends the process to your shell; run `fg` to resume |
| `Left/Right arrows` | Cycle through dialog tabs | Navigate between tabs in permission dialogs and menus. In a tabbed dialog, the keys switch tabs while the tab row has focus. See [Tabs actions](https://code.claude.com/docs/en/keybindings.md#tabs-actions) for how focus moves |
| `Tab` | Accept an autocomplete suggestion, or add a comment to a permission answer | While autocomplete suggestions are showing in the prompt input, accepts the selected suggestion. On most permission prompts, with **Yes** or **No** focused, opens a comment field on that option, and pressing it again closes the field. See [add a comment when you answer a permission prompt](https://code.claude.com/docs/en/permissions.md#add-a-comment-when-you-answer-a-permission-prompt) |
| `Up/Down arrows` or `Ctrl+P`/`Ctrl+N` | Move cursor or navigate command history | When the input spans more than one visual row, whether wrapped or multiline, first moves the cursor within the prompt. Once the cursor is on the first or last visual row, pressing again navigates command history. While you have messages queued, `Up` from the first row instead [takes them back](#take-back-what-you-queued) |
| `Esc` | Interrupt Claude, or close a dialog | Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far. If you have [messages queued](#queue-messages-while-claude-works), Claude Code sends them next. When a dialog is open, `Esc` closes the dialog. While a footer item is selected, such as a row in the [subagent panel](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) below the prompt, `Esc` [deselects it](https://code.claude.com/docs/en/keybindings.md#footer-actions) instead of interrupting. On a permission prompt, `Esc` declines the action, the same as [**No** without a comment](https://code.claude.com/docs/en/permissions.md#add-a-comment-when-you-answer-a-permission-prompt) |
| `Esc` + `Esc` | Clear input draft, or rewind | When the prompt input contains text, double `Esc` clears it and saves the draft to history so `Up` recalls it. When the input is empty, double `Esc` opens the [rewind menu](https://code.claude.com/docs/en/checkpointing.md) to restore or summarize code and conversation from a previous point |
| `Ctrl+Enter` or `Ctrl+X Ctrl+S` | Send queued messages now | Sends your [queued messages](#queue-messages-while-claude-works), and your draft with them, right away. [When Claude Code sends what you queued](#when-claude-code-sends-what-you-queued) covers what happens to the turn Claude is working on. In [shell mode](#shell-mode-with-prefix), the key only queues your command. In terminals that don't report extended keys, `Ctrl+Enter` arrives as plain `Enter`; `Ctrl+X Ctrl+S` works in any terminal. Requires Claude Code v2.1.275 or later |
| `Shift+Tab`, or `Alt+M` on Windows when the Node or Bun runtime doesn't enable VT input mode | Cycle permission modes | Cycle through `default` (labeled Manual in the mode indicator), `acceptEdits`, `plan`, and, when available, `bypassPermissions` and then `auto`. From `auto`, the first press switches to `default`. See [permission modes](https://code.claude.com/docs/en/permission-modes.md). On a file permission prompt, the same key closes an open [comment field](https://code.claude.com/docs/en/permissions.md#add-a-comment-when-you-answer-a-permission-prompt). With no field open, it selects the option that allows the action for the rest of the session, when the prompt offers that option |
| `Option+P` (macOS) or `Alt+P` (Windows/Linux) | Switch model | Switch models without clearing your prompt |
| `Option+T` (macOS) or `Alt+T` (Windows/Linux) | Toggle extended thinking | Enable or disable extended thinking mode. Has no effect on Opus 5.5, Sonnet 5.5, Haiku 5.5, or the Fable models, which always use extended thinking. Works on macOS without configuring Option as Meta |
| `Option+O` (macOS) or `Alt+O` (Windows/Linux) | Toggle fast mode | Enable or disable [fast mode](https://code.claude.com/docs/en/fast-mode.md) |

### Text editing

| Shortcut | Description | Context |
| :- | :- | :- |
| `Ctrl+A` | Move cursor to start of current line | In multiline input, moves to the start of the current logical line |
| `Ctrl+E` | Move cursor to end of current line | In multiline input, moves to the end of the current logical line |
| `Ctrl+K` | Delete to end of line | Stores deleted text for pasting |
| `Ctrl+U` | Delete from cursor to line start | Stores deleted text for pasting. Repeat to clear across lines in multiline input. On macOS, terminal emulators including iTerm2 and Terminal.app map `Cmd+Backspace` to this shortcut |
| `Ctrl+W` | Delete back to previous whitespace | Stores deleted text for pasting. One press removes a whole path or `--flag=value`. To delete only the previous word, press `Option+Delete` on macOS or `Ctrl+Backspace` on Windows |
| `Ctrl+Y` | Paste deleted text | Pastes the text you last deleted with one of the word or line deletion shortcuts, such as `Ctrl+K`, `Ctrl+U`, or `Ctrl+W` |
| `Alt+Y` (after `Ctrl+Y`) | Cycle paste history | After pasting, cycle through previously deleted text. Requires [Option as Meta](#keyboard-shortcuts) on macOS |
| `Alt+B` | Move cursor back one word | Word navigation. Requires [Option as Meta](#keyboard-shortcuts) on macOS |
| `Alt+F` | Move cursor forward one word | Moves to the end of the current word, or to the end of the next word when the cursor is between words. Requires [Option as Meta](#keyboard-shortcuts) on macOS |
| `Alt+D` | Delete to end of word | Deletes to the end of the current word, or to the end of the next word when the cursor is between words. Stores deleted text for pasting. Requires [Option as Meta](#keyboard-shortcuts) on macOS |
| `Ctrl+_` or `Ctrl+Shift+-` | Undo last input edit | Restores the previous input text and cursor position |

### Word boundaries in editing shortcuts

The word shortcuts `Alt+B`, `Alt+F`, `Alt+D`, `Option+Delete`, and `Ctrl+Backspace` treat a word as a run of letters and digits, so punctuation such as `_`, `.`, and `/` separates words. With `src/utils/foo.ts` in the prompt, repeated presses of `Alt+B` stop at the start of `ts`, `foo`, `utils`, and `src`.

`Ctrl+W` is different: it ignores punctuation and deletes back to the previous whitespace, so one press removes all of `src/utils/foo.ts`.

In text written without spaces, such as Chinese or Japanese, the word shortcuts still move or delete one word at a time.

These readline conventions apply in Claude Code v2.1.261 and later. The [`keybindingFlavor`](https://code.claude.com/docs/en/settings-reference#keybindingflavor) setting that turned them on in earlier versions is deprecated and has no effect.

You can't remap these shortcuts in the [keybindings configuration file](https://code.claude.com/docs/en/keybindings.md), which has no actions for them.

### Theme and display

| Shortcut | Description | Context |
| :- | :- | :- |
| `Ctrl+T` | Toggle syntax highlighting for code blocks | Only works inside the `/theme` picker menu. Controls whether code in Claude's responses uses syntax coloring |

### Multiline input

| Method | Shortcut | Context |
| :- | :- | :- |
| Quick escape | `\` + `Enter` | Works in all terminals |
| Option key | `Option+Enter` | After enabling [Option as Meta](https://code.claude.com/docs/en/terminal-config.md#enable-option-key-shortcuts-on-macos) on macOS |
| Shift+Enter | `Shift+Enter` | Native in iTerm2, WezTerm, Ghostty, Kitty, Warp, Apple Terminal, Windows Terminal. For other terminals, see [Enter multiline prompts](https://code.claude.com/docs/en/terminal-config.md#enter-multiline-prompts) |
| Control sequence | `Ctrl+J` | Works in any terminal without configuration |
| Paste mode | Paste directly | For code blocks, logs |

### Quick commands

| Shortcut | Description | Notes |
| :- | :- | :- |
| `/` at start | Command or skill | See [commands](#commands) and [skills](https://code.claude.com/docs/en/skills.md) |
| `!` at start | Shell mode | Run a command directly, add its output to the session, and have Claude respond to it |
| `@` | File path mention | Trigger file path autocomplete. In sessions with [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md#message-another-session), when you type at least one letter after the `@`, Claude Code also suggests your other live sessions on this machine, so you can tell Claude to message the one you pick. Requires Claude Code v2.1.232 or later |
| `:` | Emoji shortcode | Type a full `:name:` to insert the emoji, or two or more characters for suggestions. See [Emoji shortcodes](#emoji-shortcodes) |
| `?` on empty input | Toggle the shortcut help panel | Typing `?` when the input already contains text inserts the character |

### Transcript viewer

When the transcript viewer is open (toggled with `Ctrl+O`), these shortcuts are available. Run `/tui` with no argument to check which renderer is active. `Ctrl+E` can be rebound via [`transcript:toggleShowAll`](https://code.claude.com/docs/en/keybindings).

| Shortcut | Description |
| :- | :- |
| `?` | Toggle the keyboard shortcut help panel. Requires [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md) |
| `{` / `}` | Jump to the previous or next user prompt, like vim paragraph motion. Requires [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md) |
| `Ctrl+E` | Toggle show all content. Available in the classic renderer only, not in [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md) |
| `[` | Write the full conversation to your terminal's native scrollback so `Cmd+F`, tmux copy mode, and other native tools can search it. Requires [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md#search-and-review-the-conversation) |
| `v` | Write the conversation to a temporary file and open it in `$VISUAL` or `$EDITOR`. Requires [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md) |
| `q`, `Ctrl+C`, `Esc` | Exit transcript view. All three can be rebound via [`transcript:exit`](https://code.claude.com/docs/en/keybindings) |

### Voice input

| Shortcut | Description | Notes |
| :- | :- | :- |
| Hold or tap `Space` | Voice dictation | Requires [voice dictation](https://code.claude.com/docs/en/voice-dictation.md) to be enabled. Hold to record, or run `/voice tap` for tap-to-toggle. [Rebindable](https://code.claude.com/docs/en/voice-dictation.md#rebind-the-dictation-key) |

## Commands

Type `/` in Claude Code to see the commands available to you, or type `/` followed by any letters to filter. The `/` menu lists built-in commands, bundled and user-authored [skills](https://code.claude.com/docs/en/skills.md), and commands contributed by [plugins](https://code.claude.com/docs/en/plugins/overview.md) and [MCP servers](https://code.claude.com/docs/en/mcp.md#use-mcp-prompts-as-commands). Not all built-in commands are visible to every user since some depend on your platform or plan, and [a few available commands are hidden from the menu by design](https://code.claude.com/docs/en/commands.md#how-the-command-menu-matches-what-you-type) and run when you type their full name.

In [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md#use-the-mouse), the `/` command and `@` file suggestion lists also respond to the mouse: hovering highlights a row and clicking accepts it.

See the [commands reference](https://code.claude.com/docs/en/commands.md) for the full list of commands included in Claude Code.

### Complete a command mid-prompt

Command completion also works partway through a prompt: type `/` after a space, then the first letters of a name, as in `run the tests, then /com`. Only commands whose names start with those letters match, so a file path such as `/tmp/notes.md` doesn't keep a list open. Claude Code runs a command itself only when the command [starts your message](https://code.claude.com/docs/en/commands.md).

* **In [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md)**: the matches open as a list while you type, with no row highlighted, so `Enter` still sends your prompt as typed. Press `Tab` to insert the top match, or pick a row with the arrow keys and `Enter`.
* **Outside fullscreen**: the rest of the top match appears as ghost text at your cursor, with a count such as `+2` when more commands match. Press `Tab` to insert the only match, or to open the list when several match, then pick a row with the arrow keys and `Enter`.

In both renderers, press `Tab` on a bare mid-prompt `/` to list every command.

A plugin skill matches on its bare name too, so `/deploy` finds a skill named `myplugin:deploy-app`. When you insert the match, Claude Code writes the full `/myplugin:deploy-app`.

## Vim editor mode

Enable vim-style editing via `/config` → Editor mode.

Claude Code keeps your vim mode and cursor position when you toggle the [transcript viewer](#transcript-viewer) with `Ctrl+O` or open and close a panel such as `/config`. If you leave the prompt in NORMAL mode, it's still in NORMAL mode when you return, with the cursor where you left it.

### Mode switching

| Command | Action | From mode |
| :- | :- | :- |
| `Esc` or `Ctrl+[` | Enter NORMAL mode. In terminals that use the Kitty keyboard protocol, `Ctrl+[` requires v2.1.242 or later | INSERT, VISUAL |
| `i` | Insert before cursor | NORMAL |
| `I` | Insert at beginning of line | NORMAL |
| `a` | Insert after cursor | NORMAL |
| `A` | Insert at end of line | NORMAL |
| `o` | Open line below | NORMAL |
| `O` | Open line above | NORMAL |
| `v` | Start character-wise visual selection | NORMAL |
| `V` | Start line-wise visual selection | NORMAL |

### Remap INSERT-mode key sequences

The [`vimInsertModeRemaps`](https://code.claude.com/docs/en/settings-reference#viminsertmoderemaps) setting maps a two-key INSERT-mode sequence to Escape, so a mapping like `jj` returns you to NORMAL mode.

The following `~/.claude/settings.json` example turns on vim mode and maps `jj` to Escape:

```json theme={null}
{
  "editorMode": "vim",
  "vimInsertModeRemaps": { "jj": "<Esc>" }
}
```

Each key is exactly two printable characters typed in sequence, and `"<Esc>"` is the only supported target. Entries with a different length or target are ignored.

Typing the first character of a sequence inserts it normally. Pressing the second character within one second removes that pending character and switches to NORMAL mode, leaving neither character in your input. After the one-second window, or if a different key follows, both characters stay as literal text, so you can still type a word containing the sequence by pausing between the two keys.

Claude Code reads this setting from your user settings file, the `--settings` flag, and [managed settings](https://code.claude.com/docs/en/managed-settings.md) only. Entries in a project's `.claude/settings.json` or `.claude/settings.local.json` are ignored, so a checked-out repository can't remap your keystrokes.

### Navigation (NORMAL mode)

| Command | Action |
| :- | :- |
| `h`/`j`/`k`/`l` | Move left/down/up/right |
| `Space` | Move right |
| `w` | Next word |
| `e` | End of word |
| `b` | Previous word |
| `0` | Beginning of line |
| `$` | End of line |
| `^` | First non-blank character |
| `gg` | Beginning of input |
| `G` | Beginning of last line |
| `f{char}` | Jump to next occurrence of character on the current line |
| `F{char}` | Jump to previous occurrence of character on the current line |
| `t{char}` | Jump to just before next occurrence of character on the current line |
| `T{char}` | Jump to just after previous occurrence of character on the current line |
| `;` | Repeat last f/F/t/T motion |
| `,` | Repeat last f/F/t/T motion in reverse |
| `%` | Jump to the matching `()`, `[]`, or `{}` bracket, starting from the next bracket on the current line when the cursor isn't on a bracket. Requires Claude Code v2.1.301 or later |
| `/` | Open reverse history search, same as `Ctrl+R`. The empty search prompt shows a hint: press `Esc` then `i` then `/` to open the command menu instead |

> [!NOTE]
>
> In vim NORMAL mode, if the cursor is at the beginning or end of input and can't move further, `j`/`k` and `↑`/`↓` navigate command history instead. `←` on an empty prompt opens [agent view](https://code.claude.com/docs/en/agent-view.md) from NORMAL mode as well as INSERT.

### Editing (NORMAL mode)

| Command | Action |
| :- | :- |
| `x` | Delete character |
| `r{char}` | Replace character under cursor with `{char}` |
| `dd` | Delete line |
| `D` | Delete to end of line |
| `dw`/`de`/`db` | Delete word/to end/back |
| `df{char}`/`dt{char}` | Delete to and including, or up to, the next occurrence of a character on the current line |
| `dj`/`dk` | Delete the current line and the line below or above |
| `dgg`/`dG` | Delete from the current line to the first or last line |
| `d0`/`c0`/`y0` | Delete, change, or yank from the cursor back to the beginning of the line. Requires Claude Code v2.1.281 or later |
| `d%`/`c%`/`y%` | Delete, change, or yank from the cursor through the bracket that `%` jumps to. Requires Claude Code v2.1.301 or later |
| `cc` | Change line |
| `C` | Change to end of line |
| `cw`/`ce`/`cb` | Change word/to end/back |
| `s` | Substitute character: delete the character under the cursor and enter INSERT mode |
| `S` | Substitute line: clear the line and enter INSERT mode |
| `yy`/`Y` | Yank (copy) line |
| `yw`/`ye`/`yb` | Yank word/to end/back |
| `p` | Paste after cursor |
| `P` | Paste before cursor |
| `>>` | Indent line |
| `<<` | Dedent line |
| `J` | Join lines |
| `u` | Undo |
| `.` | Repeat last change |

### Text objects (NORMAL mode)

Text objects work with operators like `d`, `c`, and `y`:

| Command | Action |
| :- | :- |
| `iw`/`aw` | Inner/around word |
| `iW`/`aW` | Inner/around WORD (whitespace-delimited) |
| `i"`/`a"` | Inner/around double quotes |
| `i'`/`a'` | Inner/around single quotes |
| `i(`/`a(` | Inner/around parentheses |
| `i[`/`a[` | Inner/around brackets |
| `i{`/`a{` | Inner/around braces |

### Visual mode

Press `v` for character-wise selection or `V` for line-wise selection. Motions extend the selection, and operators act on it directly.

| Command | Action |
| :- | :- |
| `d`/`x` | Delete selection |
| `y` | Yank selection |
| `c`/`s` | Change selection |
| `p` | Replace selection with register contents |
| `r{char}` | Replace every selected character with `{char}` |
| `~`/`u`/`U` | Toggle, lowercase, or uppercase selection |
| `>`/`<` | Indent or dedent selected lines |
| `J` | Join selected lines |
| `o` | Swap cursor and anchor |
| `iw`/`aw`/`i"`/… | Select a text object |
| `v`/`V` | Toggle between character-wise and line-wise, or exit |

Block-wise visual mode with `Ctrl+V` is not supported.

### Cancel a question in vim mode

When you're typing your own answer in the `Other` row of a [question Claude asks](https://code.claude.com/docs/en/tools-reference.md#askuserquestion-tool-behavior), press `Esc` twice to cancel the question.

To cancel with a single key press instead, [bind another key to cancel the question](https://code.claude.com/docs/en/keybindings.md#cancel-a-question-with-one-key-press).

## Command history

Claude Code keeps a history of the prompts you type, and Up-arrow recall reaches prompts from past sessions of the same project:

* Input history is stored per working directory
* Running `/clear` starts a new session: recall then lists the new session's prompts first, with earlier sessions' prompts after them. The previous session's conversation is preserved and can be resumed.
* Submitting the same prompt twice in a row records one history entry, so pressing Up steps to the previous distinct prompt
* When you recall a prompt that included pasted text, Claude Code sends the full pasted content again when you resubmit. If the content has since been [cleaned up](https://code.claude.com/docs/en/claude-directory.md#cleaned-up-automatically), Claude Code doesn't send the literal `[Pasted text #N]` string; see [Paste large content](https://code.claude.com/docs/en/terminal-config.md#paste-large-content) for what happens to the prompt
* History expansion with `!` is disabled by default

### Bring back a cleared draft

To get back a draft you cleared with `Ctrl+C`, press `Up`, either right away or after you've sent a message or command:

* **Right after clearing the draft**: press `Up` once while the prompt is still empty. Requires Claude Code v2.1.288 or later.
* **After sending a message or command**: press `Up` to step back to the draft. Claude Code keeps the ten most recent cleared drafts for the current session, with their pasted text and images, and discards them when you exit. Requires Claude Code v2.1.292 or later.

### Reverse search with Ctrl+R

Press `Ctrl+R` to interactively search through your command history. In [fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md), `Ctrl+R` opens a search dialog instead: type to filter, press `Up` and `Down` to move through matches, and press `Ctrl+S` to cycle the scope through this session, this project, and all projects. Press `Enter` or `Tab` to place a match in the prompt input, or `Esc` to cancel. The steps below describe the classic renderer's inline search:

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

When a command reaches its timeout before it finishes, Claude Code automatically [moves it to the background](https://code.claude.com/docs/en/tools-reference.md#foreground-commands-that-move-to-the-background) instead of stopping it, unless the command starts with `sleep`. If you've turned background commands off with [`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`](https://code.claude.com/docs/en/env-vars#variables) or by starting in [bare mode](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode), the command stops at its timeout. To change the timeout, set the [Bash timeout environment variables](https://code.claude.com/docs/en/tools-reference.md#timeout-and-output-limits).

**Key features:**

* Output is written to a file and Claude can retrieve it using the Read tool
* Background tasks have unique IDs for tracking and output retrieval
* Background tasks are automatically cleaned up when Claude Code exits. On macOS and Linux, when you stop a background task from [`/tasks`](https://code.claude.com/docs/en/commands) or Claude Code stops it at exit, processes that detached from the task's shell, such as ones started under `setsid` or `timeout`, stop too
* If you background the session instead of exiting it, your background tasks keep running in the background session. See [background a running session](https://code.claude.com/docs/en/agent-view.md#from-inside-a-session)
* Background tasks are automatically terminated if output exceeds 5GB, with a note in stderr explaining why
* On macOS and Linux, Claude Code stops your running background tasks when the operating system reports critical memory pressure, provided the session has been idle for at least 30 minutes and no turn or subagent is running
  * The [debug log](https://code.claude.com/docs/en/debug-your-config.md) says why tasks were stopped, or why a pressure event left them running
  * Set [`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`](https://code.claude.com/docs/en/env-vars) to `1` to turn off memory-pressure stops
* Background commands in a local session you work in from a terminal, the desktop app, or the VS Code extension have no time limit. In a session that runs unattended, such as a `-p` run or a cloud session, Claude Code stops a background command at its [time limit](https://code.claude.com/docs/en/tools-reference.md#time-limit-for-background-commands)
* A background command that a foreground [subagent](https://code.claude.com/docs/en/sub-agents.md#run-subagents-in-foreground-or-background) started ends when that subagent's run ends, whether it finished, failed, or was interrupted; see [When a background command stops](https://code.claude.com/docs/en/tools-reference.md#when-a-background-command-stops) in the tools reference

To turn off background commands, set the [`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`](https://code.claude.com/docs/en/env-vars#variables) environment variable to `1`. With it set, you also lose background subagents, background forked skills, and `Ctrl+B`. Starting in [bare mode](https://code.claude.com/docs/en/headless.md#start-faster-with-bare-mode) has the same effect.

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
* Supports live file path autocomplete: type a token containing a forward slash, such as `./src/` or `~/`, to see a dropdown of matching files and directories, then press `Tab` to accept. Use forward slashes on Windows too; the dropdown is triggered by `/`, not `\`
* Exit with `Escape`, `Backspace`, or `Ctrl+U` on an empty prompt
* Pasting text that starts with `!` into an empty prompt enters shell mode automatically, matching typed `!` behavior

Unless your session is one of those listed under [strict sandbox mode](https://code.claude.com/docs/en/sandboxing.md#turn-off-the-retry-with-strict-sandbox-mode), commands you type in shell mode run outside the [sandbox](https://code.claude.com/docs/en/sandboxing.md) even when you've enabled sandboxing, because the sandbox applies to the commands Claude runs.

Claude responds to the command output automatically once it lands in the transcript, so you can run `! npm test` and get an explanation of the failures without a second prompt. The response costs the same as sending a normal prompt. To add the output to context without a response instead, set [`respondToBashCommands`](https://code.claude.com/docs/en/settings-reference#respondtobashcommands) to `false` in `settings.json`.

## Queue messages while Claude works

Type a message and press `Enter` while Claude is working. Claude Code queues the message instead of interrupting the turn, and lists the queued entries in the conversation until it sends them. You can queue `!` [shell commands](#shell-mode-with-prefix) and most [commands](https://code.claude.com/docs/en/commands.md) the same way, apart from the commands, such as `/status`, that Claude Code runs as soon as you send them.

Sent and queued messages show in gray until Claude starts responding to them, so you can tell which messages Claude hasn't started on yet.

If you queue a message with a selection attached from a [connected IDE](https://code.claude.com/docs/en/vs-code.md#the-built-in-ide-mcp-server), it keeps the selection you had when you pressed `Enter`, whatever you select afterward.

### When Claude Code sends what you queued

When a queued entry reaches Claude depends on what you queued.

* Messages: if you queue a message while Claude is running tool calls, Claude Code passes it to Claude as soon as those tool calls finish, within the same turn. When the turn ends with messages still queued, they go out without another key press, in the order you typed them
* Commands and shell commands: Claude Code holds them until the turn ends, then runs them one at a time, keeping the order you queued them in

To send what you queued without waiting, press `Ctrl+Enter`. Your queued messages go out right away, with your draft queued behind them if you had typed one. Requires Claude Code v2.1.275 or later.

If you queued a `!` shell command ahead of your messages, the key interrupts the turn. Otherwise, what happens to the turn depends on what Claude is doing when you press the key:

* Running shell commands, subagents, or other work that can move to the [background](#background-bash-commands): that work moves to the background and keeps running, and Claude reads your messages in the same turn
* Only writing a response, or running something that can't move to the background: Claude Code interrupts the turn and sends your messages next. Before v2.1.281, the key interrupted the turn in both cases

In [shell mode](#shell-mode-with-prefix), the key only queues your command. In terminals that don't report extended keys, `Ctrl+Enter` arrives as plain `Enter` and queues the draft instead; `Ctrl+X Ctrl+S` works in any terminal. Both keys are bindings of the [`chat:sendNow` action](https://code.claude.com/docs/en/keybindings#chat-actions).

Press `Esc` to interrupt the turn without submitting your draft. Claude Code keeps what you queued and sends it right away.

Claude Code runs some commands as soon as you send them instead of queueing them, among them `/model`, `/effort`, and `/fast`. Each of the three changes a setting: the model, the effort level, or fast mode. Whether Claude Code applies the new setting to the turn Claude is already working on, or only from your next turn, differs by command:

* [`/model`](https://code.claude.com/docs/en/model-config#setting-your-model): once you confirm the [cache warning](https://code.claude.com/docs/en/prompt-caching.md#switching-models), if Claude Code shows one, Claude Code applies your change to the next request it makes in that turn
* `/effort`: the next message you send runs at the new level. To [start it in the turn Claude is already working on](https://code.claude.com/docs/en/model-config.md#when-a-new-effort-level-starts), queue a message while Claude is running tool calls
* [`/fast`](https://code.claude.com/docs/en/fast-mode#toggle-fast-mode): Claude Code keeps the fast mode setting that was active when the turn started, so your speed change applies from your next turn. If your current model doesn't support fast mode, turning it on also [switches your model](https://code.claude.com/docs/en/prompt-caching.md#turning-on-fast-mode), and Claude Code uses the new model from its next request in that turn

### Background a session with messages queued

When the session moves to the background after you [press `←`](https://code.claude.com/docs/en/agent-view#switch-sessions-without-leaving-the-terminal), the messages you had queued move with it. Claude reads them there in the order you sent them.

Commands and `!` shell commands can't move, and neither can some messages, such as one with an [IDE selection](https://code.claude.com/docs/en/vs-code.md#the-built-in-ide-mcp-server) attached. If you press `←` while one of them is queued, the session stays in the foreground and a notice that begins `Cannot open agents` appears. To background the session, get the entry out of the queue and then press `←` again:

* **Commands and `!` shell commands**: wait for them to run at the end of the turn, or [take them back](#take-back-what-you-queued) and clear the input box. While anything else is queued, you can't take `!` shell commands back, so wait for them to run.
* **Messages that can't move**: wait until Claude has read them

### Take back what you queued

Press `Up` from the first line of the input box to take back the queued messages and commands. Claude Code removes them from the queue and puts them in the input box, one per line, ahead of any text you had typed. Edit the text and press `Enter` to queue it again as one entry, or clear the input box to drop it.

Claude Code takes back queued shell commands only when the input box is empty and you have nothing else queued, and it switches the input box to shell mode when it does. Otherwise it leaves them in the queue, listed with their `!` prefix, and runs them after the turn ends.

If you take back queued text while `←` [waits to background the session](https://code.claude.com/docs/en/agent-view.md#switch-sessions-without-leaving-the-terminal), the text stays in the input box and Claude Code cancels the switch. If you take it back at the moment the session moves, the text disappears with the foreground screen: it wasn't sent. Each message you took back is saved as its own entry in [command history](#command-history). To recover one, reopen the session and press `Up` on an empty prompt with nothing queued.

## Prompt suggestions

When you first open a session, Claude Code shows a grayed-out example command in the prompt input to help you get started. It picks this from your project's git history, so the example reflects files you've been working on recently.

After Claude responds, Claude Code can suggest your next prompt based on your conversation history, such as a follow-up step from a multi-part request or a natural continuation of your workflow.

* Press `Tab` or `Right arrow` to place the suggestion in the prompt input, then `Enter` to submit
* Start typing to dismiss it

Claude Code generates each of these next-prompt suggestions with a short background request to the same model your session is using. The request counts toward your plan's usage limits or your API costs. Because it reuses the conversation's prompt cache, it is mostly cache reads plus a few output tokens, so the added cost is small.

### When Claude Code skips suggestions

In interactive mode, Claude Code leaves prompt suggestions off by default and hides the **Prompt suggestions** toggle in `/config` in a [session that doesn't fetch feature flags](https://code.claude.com/docs/en/env-vars.md#features-that-need-feature-flag-fetching), such as one on a third-party provider or through a Claude apps gateway, and in a [first session after an install or upgrade](https://code.claude.com/docs/en/env-vars.md#first-session-after-an-install-or-upgrade) whose flags haven't arrived yet.

Claude Code also skips individual suggestions in several situations, including:

* The prompt cache is cold, to avoid unnecessary cost
* After the first turn of a conversation, in some sessions
* The previous response ended in an error
* While you're in plan mode
* Your account is close to or at its usage limit. To keep this skip from applying until you reach the limit, set [`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`](https://code.claude.com/docs/en/env-vars) to `true`. Before v2.1.238, Claude Code skipped suggestions near the limit even with the variable set to `true`
* In an [agent team](https://code.claude.com/docs/en/agent-teams.md), in teammates' sessions by default. The lead's session shows suggestions

The notice `Showing fewer prompt suggestions · use one to bring them back` means Claude Code is showing suggestions less often because you left many in a row unused. To return to the usual frequency, use a suggestion or set [`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`](https://code.claude.com/docs/en/env-vars) to `true`.

In print mode, Claude Code doesn't generate suggestions by default. Pass [`--prompt-suggestions`](https://code.claude.com/docs/en/cli-reference#cli-flags) with `-p "<prompt>" --output-format stream-json --verbose` to have Claude Code emit a `prompt_suggestion` message after each turn that generates one. The generator skips very short conversations and cold prompt caches here too, so a single short `-p` query can emit none.

### Turn prompt suggestions off

To disable prompt suggestions entirely, use any of the following:

* Turn off **Prompt suggestions** in `/config`
* Set [`promptSuggestionEnabled`](https://code.claude.com/docs/en/settings-reference#promptsuggestionenabled) to `false` in your settings file
* Set the [`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`](https://code.claude.com/docs/en/env-vars) environment variable to `false`, which takes precedence over the setting:
  ```bash theme={null}
  export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false
  ```

To turn prompt suggestions off across an organization, set `promptSuggestionEnabled` to `false` in [managed settings](https://code.claude.com/docs/en/managed-settings.md). Also set `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` to `false` under the managed [`env`](https://code.claude.com/docs/en/settings-reference#env) key so that users can't re-enable them with their own environment variable.

## You should know suggestions

"You should know" looks for one thing you should know but might have missed, such as a tradeoff Claude chose without calling it out or a result that may be off. When it finds one, it shows a short note above the prompt input:

```text theme={null}
✦ Heads up · There was a change to how folder sharing starts in June, which may have bumped usage metrics artificially.
  1: Learn more   2: Knew this already   0: Dismiss
```

It's one of Claude Code's [built-in mods](https://code.claude.com/docs/en/plugins/mods/overview.md#mods-built-into-claude-code), a plugin built into Claude Code that is off by default. Requires Claude Code v2.1.287 or later.

While it's on, a side agent rereads the conversation from time to time as Claude works through a longer task. The side agent is a separate request to the same model and has no tools, so it can't read files, run commands, or change what Claude does.

If the mod is available for your organization, `/plugin` lists it when you connect to the Claude API directly with a claude.ai account or a Console API key. It doesn't when you connect through an [LLM gateway](https://code.claude.com/docs/en/llm-gateway) or a [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway), or get your key from an [`apiKeyHelper`](https://code.claude.com/docs/en/settings-reference#apikeyhelper). Even with a direct connection, these sessions don't list it:

* A session that [doesn't fetch the feature flags](https://code.claude.com/docs/en/env-vars.md#features-that-need-feature-flag-fetching) the mod depends on, such as one with `DISABLE_TELEMETRY` set
* A [first session after an install or upgrade](https://code.claude.com/docs/en/env-vars.md#first-session-after-an-install-or-upgrade) whose flags haven't arrived yet

To turn it on, run this at the Claude Code prompt:

```text theme={null}
/plugin enable cc-plugin-you-should-know@builtin
```

Where `/plugin` doesn't list the mod, the enable command answers `Plugin "cc-plugin-you-should-know@builtin" is not installed in this project`.

### Cost of checks

While the mod is on, checks are background requests to the same model your session is using, and they count toward your plan's usage limits or your API costs. Each check sends what's already in Claude's context, meaning the conversation so far with its tool results, followed by the mod's own instructions and the text of your recent notes. The conversation part is read from the session's [prompt cache](https://code.claude.com/docs/en/prompt-caching.md) on the same terms as Claude's own next request. The instructions, several thousand tokens of them, and the side agent's reply are billed in full on every check.

To watch the checks happen, set [`CLAUDE_CODE_YOU_SHOULD_KNOW_DEBUG=1`](https://code.claude.com/docs/en/env-vars) in your shell before you start Claude Code.

### Answer a note

Type the choice's digit on its own into an empty prompt input. A note offers these choices:

* **Learn more**: opens a short explanation under the note, with its own choices:
  * **Understood**: closes it and marks the topic as known
  * **Chat in main session**: quotes the note into your prompt input so you can add a question and send it to Claude
  * **Dismiss**: closes it without marking the topic as known
* **Knew this already**: closes the note and marks the topic as known.
* **Dismiss**: closes the note.

The main agent doesn't see a note unless you send it with **Chat in main session**.

Claude Code keeps your recent notes and the topics you marked as known in a file whose name starts with `cc-plugin-you-should-know` under `~/.claude/plugins/store/`. Each check, in this session and later ones, lists them to the side agent as ones not to repeat. Claude Code deletes the file once it has gone [`cleanupPeriodDays`](https://code.claude.com/docs/en/settings-reference#cleanupperioddays) without a session reading or writing it. To clear them sooner, delete that file while no session is running.

### Turn off You should know

To turn off You should know, use either of the following:

* At the Claude Code prompt, run `/plugin disable cc-plugin-you-should-know@builtin`, or turn it off from the **Installed** tab of `/plugin`
* After you choose **Dismiss** on a note without opening **Learn more** first, choose **Turn off suggestions** on the `Dismissed.` line, which clears after 20 seconds

## Emoji shortcodes

Type a `:` followed by an emoji shortcode in the prompt input to insert the emoji.

* Type a complete shortcode such as `:heart:` and Claude Code replaces it with ❤️ as soon as you type the closing `:`
* Type `:` plus at least two characters of a name, such as `:hea`, to open a suggestion popup, then press `Tab` or `Enter` to insert the highlighted emoji

The shortcode must start the input or follow a space, so a `:` inside a word or URL doesn't open suggestions.

To turn the feature off, set [`emojiCompletionEnabled`](https://code.claude.com/docs/en/settings-reference#emojicompletionenabled) to `false` in `settings.json`. This disables both the suggestion popup and the inline replacement.

## Check spelling as you type

Claude Code can underline misspelled words in the prompt input while you type. It checks only the text in the input box, never Claude's replies or your files. It also checks nothing while the input box is in [shell mode](#shell-mode-with-prefix), `Ctrl+R` history search, or [voice dictation](https://code.claude.com/docs/en/voice-dictation.md).

Spell checking is off by default, and Claude Code checks nothing in [screen reader mode](https://code.claude.com/docs/en/accessibility.md). Requires Claude Code v2.1.235 or later.

### Prerequisites

* Install [aspell](https://github.com/GNUAspell/aspell), [hunspell](https://github.com/hunspell/hunspell), or [ispell](https://en.wikipedia.org/wiki/Ispell) and make sure it's on your `PATH`. Claude Code runs the first of the three it finds, in that order, on every platform, including a `.cmd` shim a package manager installs on Windows.
* To check that the program is on your `PATH`, run `aspell --version`, `hunspell --version`, or `ispell -v` in your terminal. A "command not found" error means it isn't on your `PATH` yet.

### Turn spell checking on or off

Claude Code reads the [`spellcheck`](https://code.claude.com/docs/en/settings-reference#spellcheck) setting from three places, and ignores it in a project's `.claude/settings.json` and `.claude/settings.local.json`. Turn it on from whichever one you use:

**User settings**

Add `spellcheck` to `~/.claude/settings.json`. It applies in every project you open, like the rest of your [user settings](https://code.claude.com/docs/en/settings.md#where-settings-live):

```json theme={null}
{
  "spellcheck": { "enabled": true }
}
```

**Command line**

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

**Managed settings**

Add `spellcheck` to one of your organization's [managed settings sources](https://code.claude.com/docs/en/permissions.md#managed-settings). It applies to every user who receives those settings, and they can't turn it off:

```json theme={null}
{
  "spellcheck": { "enabled": true }
}
```

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

## Invisible characters in prompts

Pasted text can carry Unicode characters that a terminal draws as nothing at all, such as tag characters, bidirectional controls, and zero-width spaces, so a prompt can contain text you never see. To keep copied text from carrying instructions your terminal doesn't draw, Claude Code removes those characters when you press Enter, before sending anything. It cleans both the prompt and the contents of any collapsed [pasted-text reference](https://code.claude.com/docs/en/terminal-config.md#paste-large-content) the prompt includes. Claude Code keeps the joiners that Persian and Indic scripts write and the selectors inside emoji sequences.

If Claude Code removed anything, that Enter sends nothing. The cleaned prompt goes back into the input box with a notice such as `Removed 3 invisible characters · review and press Enter to send`, and pressing Enter again sends the text as shown.

When you pass a prompt on the command line, as in `claude "fix the login bug"`, Claude Code doesn't wait for a second Enter. It removes the characters, shows a notice, and sends the cleaned prompt. If the cleaned prompt would begin with `/`, Claude Code puts it in the input box for you to review and send instead.

## Review changes with /diff

Run `/diff` to look over the changes in your working tree without leaving Claude Code. You see the edits Claude has made so far alongside anything else you haven't committed. What `/diff` opens depends on which renderer is active:

* **[Fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md)**: the [diff panel](#diff-panel) opens beside the conversation. It stays open and updates while you keep working.
* **Classic renderer**: the [diff dialog](#diff-dialog) opens above the prompt, and you close it when you're done reading.

The panel and the dialog both come from `cc-plugin-diff`, one of the [mods built into Claude Code](https://code.claude.com/docs/en/plugins/mods/overview.md#mods-built-into-claude-code). If you disable that mod in `/plugin`, `/diff` opens Claude Code's earlier panel and [diff viewer](https://code.claude.com/docs/en/keybindings.md#diff-actions) instead.

In the changes `/diff` reads from git, a submodule appears as a single entry, and only when the commit it points to changes; edits to files inside the submodule don't appear there. The panel and the dialog also offer a view of each turn's edits once Claude has edited files. These turn views come from Claude's file edits rather than from git, so a change Claude makes through a shell command appears only under `Current`, the working-tree view.

### Diff panel

The diff panel lists the changed files with their added and removed line counts, and shows each file's diff under the list. Claude Code refreshes it each time Claude edits a file or runs a shell command. To close the panel, run `/diff` again or click the `✕` in its header.

To use the panel you need:

* [Fullscreen rendering](https://code.claude.com/docs/en/fullscreen.md)
* A git repository
* A terminal at least 110 columns wide
* Claude Code v2.1.287 or later

The panel also opens on its own once Claude starts editing files, if your terminal is at least 144 columns wide. After you've opened it yourself with `/diff`, later sessions open it as soon as Claude edits a file in any terminal wide enough to fit it. Close the panel and it stays closed, in this session and later ones, until you run `/diff` again.

While the panel is open, you can:

* **Jump to a file**: click its row in the list. Scroll the panel with the mouse wheel. When the file list itself is too long to fit, scroll it with `Alt+Up` and `Alt+Down`, or `Ctrl+Up` and `Ctrl+Down`.
* **Ask Claude about a file's changes**: click `ask`, at the right of the file's name above its diff. Claude Code attaches that file's diff to your next prompt, and the button reads `asked ✓` until you send that prompt. Asking on a second file replaces the first.
* **Show one turn's edits**: click the `source` picker in the panel's header, then choose a turn with `Up` and `Down` and press `Enter`. Turns are labeled `T1`, `T2`, and so on. The picker appears once Claude has edited files, and `Current` returns you to the working tree.
* **Show the files the panel leaves out**: the list skips test files and generated files, and collapses changes from before this session into one line at the bottom. Click either count line to expand it.
* **Change what the panel compares against**: press `Ctrl+X B` to cycle from this session's changes, to your uncommitted changes as one list, to everything since your branch split from the default branch. Claude Code remembers the choice for each repository.

To rebind the keys that scroll the file list or change the comparison, see [Diff panel actions](https://code.claude.com/docs/en/keybindings.md#diff-panel-actions).

During an unfinished merge, rebase, cherry-pick, or revert, the panel keeps showing the changes it last read from git, so it doesn't fill with the operation's incoming changes. It updates at its first refresh after the operation ends, for example when Claude next edits a file.

### Diff dialog

The diff dialog opens as a bordered block above the prompt and lists your changed files with their added and removed line counts. It compares them against `HEAD`, or against whatever you last [chose in the diff panel](#diff-panel) for this repository.

Once Claude has edited files, a `source` picker appears above the list. It offers one turn view, labeled `T1`, `T2`, and so on, for each of your prompts that led Claude to edit files. A turn view shows only that turn's edits, and `Current` returns you to the working tree.

Use these keys in the dialog:

* **Up and Down**: select a file.
* **Enter**: open the selected file's diff. Scroll it with Up and Down, or PageUp and PageDown.
* **Esc**: return from a file's diff to the list, or close the dialog from the list.
* **Tab**: move to the `source` picker, then choose `Current` or a turn view with Up and Down and press Enter. In a file's diff, Tab moves to the `ask` button. Press Enter to attach that file's diff to your next prompt.

## Side questions with /btw

Use `/btw` to ask a question about your current work without adding to the conversation history.

```
/btw what was the name of that config file again?
```

Claude answers a side question from what's already in the conversation: your messages, its replies, and the tool results it has gathered. You can ask about code Claude has already read, decisions it made earlier, or anything else from the session. A later side question also sees your earlier side questions: Claude Code replays the newest 20 exchanges with each ask, until you clear them. The question and answer never enter the conversation history. In the terminal, they appear in a dismissible overlay. The terminal keeps the thread in memory: press `x` to clear the earlier exchanges, and it's gone when you exit Claude Code.

In the [VS Code extension](https://code.claude.com/docs/en/vs-code.md#use-the-prompt-box)'s chat panel, `/btw` opens a panel rather than the overlay this section describes, and you ask follow-up questions right in the panel. The panel's thread survives window reloads, on the retention schedule that page describes. You need the extension at v2.1.227 or later. Earlier extension versions don't offer `/btw`.

* **Available while Claude is working**: you can run `/btw` even while Claude is processing a response. The side question runs independently and doesn't interrupt the main turn. It sees everything in the conversation so far, except the reply Claude is still writing.
* **No tool access**: side questions answer only from what is already in context. Claude can't read files, run commands, or search when answering a side question. If Claude writes out tool calls as text anyway, the answer ends with a note that nothing was executed.
* **Single response**: there are no follow-up turns in the overlay. To continue the thread, ask another `/btw` question. To continue with full tool access in a local session, press `f` to fork this question and answer into a [background subagent](https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation).
* **Low cost**: while the conversation's [prompt cache](https://code.claude.com/docs/en/prompt-caching.md) is warm, a side question costs little beyond the answer itself.

Your five newest earlier side questions appear as a dimmed list above the current answer, with a count of any older ones. They stay out of the conversation history.

To return to the overlay after dismissing it, run `/btw` with no question. The overlay reopens on your most recent exchange.

Once the answer appears, the overlay accepts these keys.

| Key | Action |
| :- | :- |
| `Space`, `Enter`, `Escape` | Dismiss the answer and return to the prompt |
| `Up` / `Down` | Scroll the answer |
| `Shift+Left` / `Shift+Right` | Step between this answer and your earlier `/btw` answers. `Shift+Left` moves to older answers and `Shift+Right` returns toward the current one. `[` and `]` do the same, for terminals that don't report `Shift` with arrow keys. `Tab` / `Shift+Tab` cycle through the same answers. Requires Claude Code v2.1.257 or later. Between v2.1.187 and v2.1.256, the keys were plain `Left` / `Right` |
| `c` | Copy the answer to your clipboard as raw Markdown. Use this instead of mouse selection, which captures the hard-wrapped terminal rendering rather than the source text |
| `f` | Start a [forked subagent](https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation) that inherits the parent conversation plus this question and answer, so it can continue with full tool access. You stay in the current session and find the fork in the [panel below your prompt](https://code.claude.com/docs/en/sub-agents.md#observe-and-steer-running-forks). Available in local sessions only |
| `x` | Clear the list of earlier `/btw` exchanges shown above the current answer |

In an attached [background session](https://code.claude.com/docs/en/agent-view.md#attach-to-a-session), `Left` detaches and returns you to agent view, even while the answer is still arriving. The side question keeps running while you're away. The next time you attach to the session, the overlay reopens with the side question, or with its answer. Before v2.1.257, `Left` didn't detach there.

`/btw` sees your full conversation but has no tools. A [subagent](https://code.claude.com/docs/en/sub-agents.md) has tools and starts from the prompt it receives, or, for a [fork](https://code.claude.com/docs/en/sub-agents.md#fork-the-current-conversation), from a copy of this conversation. Use `/btw` to ask about what Claude already knows from this session; use a subagent to go find out something new.

## Task list

The task list is Claude's to-do checklist: items Claude created to plan multi-step work, with indicators showing what's pending, in progress, or complete. It's separate from the background-task view. To see running shells and subagents, use [`/tasks`](https://code.claude.com/docs/en/commands) instead.

The list fills only in sessions that have the task-tracking tools, which Claude Code provides by default on [Opus 4.7, Sonnet 4.6, Haiku 4.5, and earlier models](https://code.claude.com/docs/en/tools-reference.md#task-tool-availability). On any other model, including a model ID Claude Code doesn't recognize, the list stays empty unless you opt in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or one of the other ways under [Task tool availability](https://code.claude.com/docs/en/tools-reference.md#task-tool-availability). When the session has the tools, the task list works as follows:

* Press `Ctrl+T` to toggle the task list view. The display shows up to five tasks at a time. When Claude hasn't created any checklist items yet, the toggle has no visible effect because there's nothing to display
* If you leave the list expanded, Claude Code restores the expanded view the next time you launch into a session that still has tasks, such as with `--resume` or `--continue`. When the task list is empty, Claude Code starts it collapsed
* To see all tasks or clear them, ask Claude directly: "show me all tasks" or "clear all tasks"
* Tasks persist across context compactions, helping Claude stay organized on larger projects
* To share a task list across sessions, set `CLAUDE_CODE_TASK_LIST_ID` to use a named directory in `~/.claude/tasks/`: `CLAUDE_CODE_TASK_LIST_ID=my-project claude`

## Session recap

When you return to the terminal after stepping away, Claude Code shows a one-line recap of what happened in the session so far. The recap generates in the background once at least three minutes have passed since the last completed turn and the terminal is unfocused, so it's ready when you switch back. Recaps only appear once the session has at least three turns, and never twice in a row.

Run `/recap` to generate a summary on demand. It runs only when you ask for it yourself. When it arrives in a message relayed from a Slack, Teams, or project thread, you get a [notice](https://code.claude.com/docs/en/errors.md#recap-only-runs-when-you-ask-for-it-yourself) instead of a recap. You also get the notice when `/recap` arrives in a prompt a cloud scheduled task sent.

Session recap is on by default for every plan and provider. To turn automatic recaps off, open `/config` and turn off **Session recap**. The automatic recap never appears in non-interactive mode. Claude Code caps both automatic recaps and `/recap` output at 400 characters.

## Wait for a usage limit to reset

When a claude.ai [usage limit](https://code.claude.com/docs/en/errors.md#youve-hit-your-session-limit) stops Claude mid-task, Claude Code waits in the open session and continues the task on its own after the limit resets. Automatic continue is on by default in interactive sessions signed in with a claude.ai subscription. Requires Claude Code v2.1.234 or later.

While Claude Code waits, the lines at the bottom of the session show when your limit resets and when Claude will continue:

```text theme={null}
Usage limit reached · limit resets 3:45pm
Continuing automatically at 3:45pm · Esc to cancel
```

Either line can carry more after these words, such as a help link on the first or `/usage-credits to continue now` on the second. When the wait starts on its own, the conversation also records it with a line that reads `Usage limit reached · continuing automatically at 3:45pm · esc to cancel`.

Keep the session open. What happens next depends on how the wait ends:

* **At the reset**: the second line changes to `Continuing shortly · Esc to cancel`. Then `Usage limit reset · Continuing automatically` appears in the conversation, and Claude Code prompts Claude to pick the task up where it stopped. It doesn't resend your last message.
* **After your computer slept**: if it slept for more than about 30 minutes and the limit reset while it slept, the first line reads `Your usage limit has reset` and the second reads `Press enter to continue`. Press `Enter` to continue. After a shorter sleep, or one that ended before the reset, Claude Code continues on its own.
* **Early**: when you finish adding [usage credits](https://code.claude.com/docs/en/costs.md#add-usage-credits-to-your-subscription) with `/usage-credits`, sign back in after `/upgrade`, or switch models with `/model` during the wait, Claude Code checks whether usage is available again and continues right away if it is. It doesn't check after an upgrade or purchase you make in a browser on your own. Under [`opusplan`](https://code.claude.com/docs/en/model-config#opusplan-model-setting) and other model settings that run plan mode on a different model, Claude Code waits for the reset instead.

The continued task runs like any other turn. Claude Code still asks for [permissions](https://code.claude.com/docs/en/permissions.md) as usual, so the task can stop on a prompt while you're away. If it hits the limit again, Claude Code re-arms the wait on its own at most twice in a row, then stops and shows `Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again`.

### Cancel the wait

Press `Esc` at an empty prompt, or `Ctrl+C`, while the lines show, or run [`/rate-limit-options`](https://code.claude.com/docs/en/commands#all-commands) and pick **Don't continue automatically**. Claude Code confirms with a line that starts `Automatic continue cancelled`.

After a cancel, nothing continues until you send a prompt or pick the row that starts **Wait here, then continue automatically** from `/rate-limit-options` again. Claude Code doesn't start a wait on its own again for that reset window; the next reset window starts fresh.

The wait also ends without continuing the task in these cases:

* **You send a prompt**: Claude Code sends your prompt instead of waiting. If your prompt hits the limit too, it stays in the conversation and Claude Code starts the wait again.
* **You exit Claude Code**: the wait doesn't restart when you resume the session.
* **The conversation changes hands**: you switch accounts with `/login`, clear or rewind the conversation, `/resume` another session, pull one with `/teleport`, relaunch with `/tui`, or hand the session to Claude Desktop, a background session, or the cloud.
* **The setting turns off, or the reset moves past 24 hours**: this ends only a wait Claude Code started on its own. A wait you picked from `/rate-limit-options` keeps counting down.
* **The continuation is blocked**: a [`UserPromptSubmit` hook](https://code.claude.com/docs/en/hooks#userpromptsubmit) that blocks the continuation prompt, or a failure before it reaches the model, ends the wait. Claude Code tells you the continuation didn't run. Send a prompt to continue.

### Start a wait yourself

Claude Code doesn't start the wait on its own in these cases:

* **Remote Control and agent team teammate sessions**: a person at that terminal can still start one.
* **A reset more than 24 hours away**: a weekly limit can reset days out.
* **An Opus or Sonnet limit while you run a model outside that family**: your next turn may not hit that limit. [`opusplan`](https://code.claude.com/docs/en/model-config#opusplan-model-setting) and other model settings that run plan mode on the limited family don't get this exception.

In those cases, and whenever automatic continue is off, Claude Code opens the usage-limit options menu once per reset window when you hit a limit at your own terminal. Pick the row that starts **Wait here, then continue automatically** to start the wait. In a [Remote Control](https://code.claude.com/docs/en/remote-control.md) or [agent team](https://code.claude.com/docs/en/agent-teams.md) teammate session, run `/rate-limit-options` yourself to open the menu.

Claude Code doesn't offer the wait at all in these cases:

* **Background sessions and `-p` runs**: the menu row isn't available.
* **API keys, cloud providers, and usage-based billing**: usage there is metered per request, so there is no reset to wait for.
* **An [LLM gateway](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways) without a saved claude.ai login**: Claude Code offers the wait only while a saved claude.ai login is the active credential.

### Turn automatic continue off

In `/config`, turn off **Continue automatically at usage limit**, or set [`autoContinueAtUsageLimit`](https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit) to `false` in your user settings. `/config autoContinueAtUsageLimit=false` also works, including with `-p`, but the `key=value` form can't turn it back on, because the setting grants unattended execution. Which settings files Claude Code reads for this key is in the [settings reference](https://code.claude.com/docs/en/settings-reference.md#autocontinueatusagelimit).

## PR review status

When working on a branch with an open pull request, Claude Code displays a clickable PR link in the footer, such as "PR #446". The link has a colored underline indicating the review state:

* Green: approved
* Yellow: pending review
* Red: changes requested
* Gray: draft

The badge disappears once the pull request merges or closes.

`Cmd+click` (macOS) or `Ctrl+click` (Windows/Linux) the link to open the pull request in your browser.

The status refreshes as soon as a `git push`, or a `gh pr` command that changes the pull request, such as `gh pr create` or `gh pr merge`, succeeds in the session.

Claude Code renders the badge as a hyperlink even when it can't detect hyperlink support in your terminal, which commonly happens over SSH or in tmux. Set [`FORCE_HYPERLINK=0`](https://code.claude.com/docs/en/env-vars) to render the badge as plain text.

When you set [`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`](https://code.claude.com/docs/en/env-vars), Claude Code doesn't check pull request or merge request status.

> [!NOTE]
>
> PR status for GitHub repositories needs a GitHub token. Claude Code finds one based on the remote's host:
>
> * **github.com**: `GH_TOKEN` or `GITHUB_TOKEN`, or the token saved by `gh auth login`. Without one, the footer shows `install gh for PR status` when the `gh` CLI isn't installed, or `gh auth login for PR status` when it is
> * **A GitHub Enterprise host set as `GH_HOST`**: `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`, or the token saved by `gh auth login --hostname <host>`. Without one, the footer shows the same hints
> * **Any other GitHub host**: the token saved by `gh auth login --hostname <host>`. Without one, Claude Code shows no badge and no hint

### GitLab merge requests

When you work on a branch with an open GitLab merge request, Claude Code shows a clickable `MR !N` badge in the footer slot that otherwise holds the GitHub PR link. `!N` is GitLab's own reference syntax for merge request number N. The colored underline shows the merge request's state:

* Green: GitLab reports the merge request as mergeable
* Yellow: any other open state
* Gray: draft

The badge disappears once the merge request merges or closes.

It refreshes as soon as a `git push`, or a `glab mr` command that changes the merge request, such as `glab mr create` or `glab mr merge`, succeeds in the session.

To get the badge, you need:

* Claude Code v2.1.234 or later
* A repository remote that points at your GitLab host, either gitlab.com or a self-managed instance
* The [`glab` CLI](https://gitlab.com/gitlab-org/cli) on your `PATH`, authenticated with `glab auth login`

Claude Code ignores `glab`'s token environment variables, such as `GITLAB_TOKEN`, when it checks status, so you get no badge from an exported token alone. Claude Code also looks for `glab` and for its login once per session, so restart Claude Code after you install `glab` or run `glab auth login`.

## Issue reference links

When Claude mentions an issue as `owner/repo#123`, you can click the reference to open it, as long as your terminal supports hyperlinks. If Claude Code doesn't detect hyperlink support in your terminal, set [`FORCE_HYPERLINK`](https://code.claude.com/docs/en/env-vars) to `1` to turn the links on, or to `0` to keep references as plain text.

You get a link only for the two-part `owner/repo#123` form. These stay plain text:

* A bare `#123`
* A nested GitLab path such as `group/subgroup/project#123`
* Any reference inside a code span or code block
* Any reference in a reply longer than about 1,000 lines or 100,000 characters

Claude Code builds the link for the host of the repository it identifies from your git remote, not for the repository the reference names:

| Your repository's host | Where `owner/repo#123` links |
| :- | :- |
| github.com, a GitHub Enterprise host, or any host not listed below | `https://<host>/owner/repo/issues/123` |
| gitlab.com | `https://gitlab.com/owner/repo/-/issues/123` |
| bitbucket.org, codeberg.org, or gitea.com | No link; the reference stays plain text |

## See also

* [Skills](https://code.claude.com/docs/en/skills.md) - Custom prompts and workflows
* [Checkpointing](https://code.claude.com/docs/en/checkpointing.md) - Rewind Claude's edits and restore previous states
* [CLI reference](https://code.claude.com/docs/en/cli-reference.md) - Command-line flags and options
* [Settings](https://code.claude.com/docs/en/settings.md) - Configuration options
* [Memory management](https://code.claude.com/docs/en/memory.md) - Managing CLAUDE.md files
