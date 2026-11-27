import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { appendInputHistory } from "@/cli/components/input-history";
import { PasteAwareTextInput } from "@/cli/components/PasteAwareTextInput";
import { resolvePlaceholders } from "@/cli/helpers/paste-registry";
import type { TerminalSession } from "./terminal-session";

const commands = [
  "agents",
  "clear",
  "compact",
  "connect",
  "context",
  "context-limit",
  "dream",
  "exit",
  "help",
  "history",
  "init",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "new",
  "queue",
  "reflect",
  "rename",
  "resume",
  "skills",
  "usage",
];

export function TerminalComposer({
  store,
  active,
}: {
  store: TerminalSession;
  active: boolean;
}) {
  const { exit } = useApp();
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [position, setPosition] = useState<number>();
  const [parked, setParked] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const prefix = /(?:^|\s)(@[^\s]*)$/.exec(draft.slice(0, cursor))?.[1];
  useEffect(() => {
    let current = true;
    setFiles([]);
    setSelected(0);
    if (active && prefix)
      void store
        .searchFiles(prefix.slice(1))
        .then((paths) => {
          if (current) setFiles(paths);
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [store, active, prefix]);
  const matches = prefix
    ? files.map((path) => (path.includes(" ") ? `@"${path}"` : `@${path}`))
    : /^\/[\w-]*$/.test(draft)
      ? commands
          .map((command) => "/" + command)
          .filter((command) => command.startsWith(draft) && command !== draft)
      : [];
  function change(value: string) {
    setDraft(value);
    setSelected(0);
    setPosition(undefined);
  }
  function complete() {
    const match = matches[selected];
    if (!match) return;
    const start = prefix ? cursor - prefix.length : 0;
    const end = prefix ? cursor : draft.length;
    change(draft.slice(0, start) + match + " " + draft.slice(end));
    setCursor(start + match.length + 1);
  }
  useInput(
    (_input, key) => {
      if (key.tab && !key.shift && matches.length) {
        complete();
        return;
      }
      if (!key.upArrow && !key.downArrow) return;
      if (matches.length) {
        setSelected((index) =>
          Math.max(
            0,
            Math.min(matches.length - 1, index + (key.upArrow ? -1 : 1)),
          ),
        );
        return;
      }
      if (!history.length) return;
      if (position === undefined) setParked(draft);
      const next = Math.max(
        0,
        Math.min(
          history.length,
          (position ?? history.length) + (key.upArrow ? -1 : 1),
        ),
      );
      const value = history[next] ?? parked;
      setDraft(value);
      setCursor(value.length);
      setPosition(next);
    },
    { isActive: active },
  );
  function submit(raw: string) {
    if (!active || !raw.trim()) return;
    if (prefix && matches.length) {
      complete();
      return;
    }
    const value = resolvePlaceholders(raw).trimEnd();
    if (value === "/exit") {
      exit();
      return;
    }
    setHistory((previous) => appendInputHistory(previous, value));
    change("");
    setCursor(0);
    void store.send(value);
  }
  return (
    <Box display={active ? "flex" : "none"} flexDirection="column">
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold>❯ </Text>
        <PasteAwareTextInput
          focus={active}
          value={draft}
          cursorPosition={cursor}
          onCursorMove={setCursor}
          onChange={change}
          onSubmit={submit}
          placeholder="Message · /help for commands"
        />
      </Box>
      {matches
        .slice(Math.max(0, selected - 5), Math.max(0, selected - 5) + 6)
        .map((match) => (
          <Text key={match} dimColor={match !== matches[selected]}>
            {match === matches[selected] ? "❯ " : "  "}
            {match}
          </Text>
        ))}
    </Box>
  );
}
