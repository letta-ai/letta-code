import { tokenizeInlineMarkdown } from "../../cli/components/InlineMarkdownRenderer";

describe("tokenizeInlineMarkdown", () => {
  test("preserves plain text when there is no markdown", () => {
    expect(tokenizeInlineMarkdown("just text")).toEqual([
      { type: "text", value: "just text" },
    ]);
  });

  test("parses markdown links into clickable link tokens", () => {
    expect(
      tokenizeInlineMarkdown("See [docs](https://docs.letta.com) please"),
    ).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        text: "docs",
        url: "https://docs.letta.com",
      },
      { type: "text", value: " please" },
    ]);
  });

  test("keeps malformed markdown links as plain text", () => {
    expect(tokenizeInlineMarkdown("[docs](https://docs.letta.com")).toEqual([
      { type: "text", value: "[docs](https://docs.letta.com" },
    ]);
  });
});
