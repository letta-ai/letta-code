import { expect, test } from "bun:test";

import {
  formatOutboundChannelMessage,
  markdownToSlackMrkdwn,
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

test("formats Slack markdown as mrkdwn", () => {
  expect(formatOutboundChannelMessage("slack", "**bold**")).toEqual({
    text: "*bold*",
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

test("renders bullet lists for Slack", () => {
  expect(markdownToSlackMrkdwn("- one\n- two")).toBe("• one\n• two");
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
