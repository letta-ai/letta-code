import { expect, test } from "bun:test";

import {
  formatOutboundChannelMessage,
  markdownToTelegramHtml,
} from "../../tools/impl/MessageChannel";

test("formats Telegram markdown as HTML", () => {
  const formatted = formatOutboundChannelMessage(
    "telegram",
    "**bold** and *italic* and ~~gone~~",
  );

  expect(formatted).toEqual({
    text: "<b>bold</b> and <i>italic</i> and <s>gone</s>",
    parseMode: "HTML",
  });
});

test("leaves non-Telegram channel messages unchanged", () => {
  expect(formatOutboundChannelMessage("slack", "**bold**")).toEqual({
    text: "**bold**",
  });
});

test("preserves markdown markers inside inline code", () => {
  expect(markdownToTelegramHtml("`**bold**`")).toBe("<code>**bold**</code>");
});

test("preserves markdown markers inside fenced code blocks", () => {
  expect(markdownToTelegramHtml('```js\nconst x = "**bold**";\n```')).toBe(
    '<pre>const x = "**bold**";</pre>',
  );
});

test("renders markdown links with balanced parentheses and escaped attributes", () => {
  expect(
    markdownToTelegramHtml('[**docs**](https://example.com/?q="x"&ref=(test))'),
  ).toBe(
    '<a href="https://example.com/?q=&quot;x&quot;&amp;ref=(test)"><b>docs</b></a>',
  );
});

test("does not treat spaced arithmetic operators as italic markup", () => {
  expect(markdownToTelegramHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
});
