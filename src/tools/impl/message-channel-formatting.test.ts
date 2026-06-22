import { expect, test } from "bun:test";

import {
  formatOutboundChannelMessage,
  markdownToSignalTextStyles,
  markdownToSlackMrkdwn,
  markdownToTelegramHtml,
} from "@/tools/impl/message-channel";

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

test("formats Slack markdown as mrkdwn", () => {
  expect(formatOutboundChannelMessage("slack", "**bold**")).toEqual({
    text: "*bold*",
  });
});

test("formats Signal markdown as signal-cli text styles", () => {
  expect(
    markdownToSignalTextStyles("**Bold** _it_ ~~gone~~ `code` ||secret||"),
  ).toEqual({
    text: "Bold it gone code secret",
    textStyle: [
      "0:4:BOLD",
      "5:2:ITALIC",
      "8:4:STRIKETHROUGH",
      "13:4:MONOSPACE",
      "18:6:SPOILER",
    ],
  });
});

test("renders Signal headings, blockquotes, bullets, and fenced code", () => {
  expect(
    markdownToSignalTextStyles(
      "## Title\n> quote\n* item\n```ts\nconst x = 1;\n```",
    ),
  ).toEqual({
    text: "Title\nquote\n- item\nconst x = 1;",
    textStyle: ["0:5:BOLD", "6:5:ITALIC", "19:12:MONOSPACE"],
  });
});

test("converts Signal markdown links to auto-linkable plain text", () => {
  expect(
    markdownToSignalTextStyles("See [**docs**](https://example.com)"),
  ).toEqual({
    text: "See docs (https://example.com)",
    textStyle: ["4:4:BOLD"],
  });
});

test("converts markdown links for Slack mrkdwn", () => {
  expect(markdownToSlackMrkdwn("[docs](https://example.com)")).toBe(
    "<https://example.com|docs>",
  );
});

test("preserves markdown markers inside inline code for Slack", () => {
  expect(markdownToSlackMrkdwn("`**bold**`")).toBe("`**bold**`");
});

test("preserves markdown markers inside fenced code blocks for Slack", () => {
  expect(markdownToSlackMrkdwn('```js\nconst x = "**bold**";\n```')).toBe(
    '```\nconst x = "**bold**";\n```',
  );
});

test("escapes unsafe characters for Slack mrkdwn", () => {
  expect(markdownToSlackMrkdwn("a & b < c > d")).toBe(
    "a &amp; b &lt; c &gt; d",
  );
});

test("preserves existing Slack angle-bracket tokens", () => {
  expect(
    markdownToSlackMrkdwn(
      "hi <@U123> see <https://example.com|docs> and <!here>",
    ),
  ).toBe("hi <@U123> see <https://example.com|docs> and <!here>");
});

test("keeps Slack bullet lists ASCII-safe", () => {
  expect(markdownToSlackMrkdwn("- one\n- two")).toBe("- one\n- two");
  expect(markdownToSlackMrkdwn("+ one\n* two")).toBe("- one\n- two");
});

test("renders headings as bold text for Slack", () => {
  expect(markdownToSlackMrkdwn("# Title")).toBe("*Title*");
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

test("renders Telegram block quotes as HTML blockquote tags", () => {
  expect(markdownToTelegramHtml("> quoted\n> **bold** & safe\n\nnormal")).toBe(
    "<blockquote>quoted\n<b>bold</b> &amp; safe</blockquote>\n\nnormal",
  );
});

test("does not render block quote markers inside Telegram code blocks", () => {
  expect(markdownToTelegramHtml("```\n> quoted\n```")).toBe(
    "<pre>&gt; quoted</pre>",
  );
});

test("does not treat spaced arithmetic operators as italic markup", () => {
  expect(markdownToTelegramHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
});

test("decodes basic xml entities before channel formatting", () => {
  expect(
    formatOutboundChannelMessage(
      "telegram",
      "Fish &amp; chips &lt;3 &quot;yes&quot;",
    ),
  ).toEqual({
    text: 'Fish &amp; chips &lt;3 "yes"',
    parseMode: "HTML",
  });
});
