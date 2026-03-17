import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../../utils/frontmatter";

describe("parseFrontmatter", () => {
  test("parses LF frontmatter", () => {
    const content = `---
name: reflection
description: custom reflection
---
Prompt body`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.name).toBe("reflection");
    expect(frontmatter.description).toBe("custom reflection");
    expect(body).toBe("Prompt body");
  });

  test("parses CRLF frontmatter", () => {
    const content =
      "---\r\nname: reflection\r\ndescription: custom reflection\r\n---\r\nPrompt body\r\nLine 2";

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.name).toBe("reflection");
    expect(frontmatter.description).toBe("custom reflection");
    expect(body).toBe("Prompt body\nLine 2");
    expect(body.includes("\r")).toBe(false);
  });

  test("parses BOM + CRLF frontmatter", () => {
    const content =
      "\uFEFF---\r\nname: reflection\r\ndescription: custom reflection\r\n---\r\nPrompt body";

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.name).toBe("reflection");
    expect(frontmatter.description).toBe("custom reflection");
    expect(body).toBe("Prompt body");
  });
});
