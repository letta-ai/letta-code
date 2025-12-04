import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { read_file } from "../tools/impl/ReadFileCodex.js";

describe("read_file indentation mode", () => {
  let tempDir: string;

  async function createTempFile(content: string): Promise<string> {
    if (!tempDir) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-file-test-"));
    }
    const filePath = path.join(tempDir, `test-${Date.now()}.txt`);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  test("slice mode reads requested range", async () => {
    const filePath = await createTempFile("alpha\nbeta\ngamma\n");
    const result = await read_file({
      file_path: filePath,
      offset: 2,
      limit: 2,
    });
    expect(result.content).toBe("L2: beta\nL3: gamma");
  });

  test("indentation mode captures block", async () => {
    const content = `fn outer() {
    if cond {
        inner();
    }
    tail();
}
`;
    const filePath = await createTempFile(content);
    const result = await read_file({
      file_path: filePath,
      offset: 3,
      limit: 10,
      mode: "indentation",
      indentation: {
        anchor_line: 3,
        include_siblings: false,
        max_levels: 1,
      },
    });

    expect(result.content).toBe(
      "L2:     if cond {\nL3:         inner();\nL4:     }",
    );
  });

  test("indentation mode expands parents", async () => {
    const content = `mod root {
    fn outer() {
        if cond {
            inner();
        }
    }
}
`;
    const filePath = await createTempFile(content);

    // max_levels: 2 should capture fn outer and its contents
    const result = await read_file({
      file_path: filePath,
      offset: 4,
      limit: 50,
      mode: "indentation",
      indentation: {
        anchor_line: 4,
        max_levels: 2,
      },
    });

    expect(result.content).toBe(
      "L2:     fn outer() {\nL3:         if cond {\nL4:             inner();\nL5:         }\nL6:     }",
    );
  });

  test("indentation mode respects sibling flag", async () => {
    const content = `fn wrapper() {
    if first {
        do_first();
    }
    if second {
        do_second();
    }
}
`;
    const filePath = await createTempFile(content);

    // Without siblings
    const result1 = await read_file({
      file_path: filePath,
      offset: 3,
      limit: 50,
      mode: "indentation",
      indentation: {
        anchor_line: 3,
        include_siblings: false,
        max_levels: 1,
      },
    });

    expect(result1.content).toBe(
      "L2:     if first {\nL3:         do_first();\nL4:     }",
    );

    // With siblings
    const result2 = await read_file({
      file_path: filePath,
      offset: 3,
      limit: 50,
      mode: "indentation",
      indentation: {
        anchor_line: 3,
        include_siblings: true,
        max_levels: 1,
      },
    });

    expect(result2.content).toBe(
      "L2:     if first {\nL3:         do_first();\nL4:     }\nL5:     if second {\nL6:         do_second();\nL7:     }",
    );
  });

  test("indentation mode includes header comments", async () => {
    const content = `class Foo {
    // This is a comment
    void method() {
        doSomething();
    }
}
`;
    const filePath = await createTempFile(content);

    const result = await read_file({
      file_path: filePath,
      offset: 4,
      limit: 50,
      mode: "indentation",
      indentation: {
        anchor_line: 4,
        max_levels: 1,
        include_header: true,
      },
    });

    // Should include the comment above the method
    expect(result.content).toContain("// This is a comment");
  });
});
