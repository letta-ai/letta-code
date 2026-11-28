import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { SingleSelectPicker } from "@/cli/components/SingleSelectPicker";
import type { SelectableItem } from "./SingleSelectPicker";

export function SearchablePicker({
  items: allItems,
  title,
  more,
  onSelect,
  onCancel,
}: {
  items: SelectableItem[];
  title: string;
  more?: boolean;
  onSelect: (key: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = allItems.filter((item) =>
    (item.label + " " + item.key).toLowerCase().includes(query.toLowerCase()),
  );
  useInput((input, key) => {
    if (key.leftArrow) setPage((value) => Math.max(0, value - 1));
    else if (key.rightArrow && (page + 1) * 10 < filtered.length)
      setPage((value) => value + 1);
    else if (key.backspace || key.delete) {
      setPage(0);
      setQuery((value) => value.slice(0, -1));
    } else if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.return &&
      !key.escape &&
      !key.tab &&
      !key.upArrow &&
      !key.downArrow &&
      !key.rightArrow
    ) {
      setQuery((value) => value + input);
      setPage(0);
    }
  });
  const items = filtered.slice(page * 10, (page + 1) * 10);
  if (more && (page + 1) * 10 >= filtered.length)
    items.push({ key: "@more", label: "Load more…" });
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text>Search: {query}</Text>
      <SingleSelectPicker
        key={query + page}
        items={items}
        onSelect={onSelect}
        onCancel={onCancel}
        footer={
          <Text dimColor>↑↓ select · ←→ page · Enter choose · Esc close</Text>
        }
      />
    </Box>
  );
}
