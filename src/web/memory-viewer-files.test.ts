import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { TestDirectory } from "@/test-utils/test-fs";
import { collectFiles } from "./generate-memory-viewer";
import template from "./memory-viewer-template.txt";
import type { MemoryFile } from "./types";

class ViewerElement {
  innerHTML = "";
  textContent = "";
  value = "";
  style = { display: "" };
  dataset: Record<string, string> = {};
  parentElement = { parentElement: { innerHTML: "" } };
  classList = { add() {}, remove() {}, toggle() {} };
  listeners = new Map<string, ((event: ViewerEvent) => void)[]>();
  toggleButton?: ViewerElement;

  addEventListener(name: string, handler: (event: ViewerEvent) => void) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  querySelector(selector: string) {
    if (selector === ".raw-toggle" && this.innerHTML.includes("raw-toggle")) {
      this.toggleButton = new ViewerElement();
      return this.toggleButton;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  dispatch(event: ViewerEvent) {
    for (const handler of this.listeners.get("click") ?? []) handler(event);
  }
}

interface ViewerEvent {
  target: { closest(selector: string): ViewerElement | null };
}

// 执行完整的浏览器脚本；只替换 DOM 容器，不替换文件处理或 Markdown 渲染。
function openViewer(files: MemoryFile[]) {
  const elements = new Map<string, ViewerElement>();
  function getElement(id: string) {
    let element = elements.get(id);
    if (!element) {
      element = new ViewerElement();
      elements.set(id, element);
    }
    return element;
  }
  getElement("letta-data").textContent = JSON.stringify({
    agent: { id: "test-agent", name: "Test Agent", serverUrl: "" },
    files,
    commits: [],
    generatedAt: "2026-10-02T00:00:00Z",
    totalCommitCount: 0,
  });
  const context = createContext({
    document: {
      getElementById: getElement,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    location: { hash: "" },
  });
  for (const match of template.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    runInContext(match[1] ?? "", context);
  }
  return {
    getElement,
    select(path: string, core = false) {
      const node = new ViewerElement();
      node.dataset.path = path;
      getElement(core ? "tree-panel-core" : "tree-panel-external").dispatch({
        target: {
          closest: (selector) =>
            selector === ".tree-item.file[data-path]" ? node : null,
        },
      });
      return getElement(core ? "file-panel-core" : "file-panel-external");
    },
  };
}

describe("Memory Palace files (#3894)", () => {
  let directory: TestDirectory;

  beforeEach(() => {
    directory = new TestDirectory();
  });

  afterEach(() => directory.cleanup());

  test("includes skill scripts, configuration, extensionless and empty files", () => {
    directory.createFile("skills/example/SKILL.md", "# Example");
    directory.createFile("skills/example/scripts/check.py", 'print("检查")\n');
    directory.createFile("skills/example/config.json", '{"enabled": true}\n');
    directory.createFile("skills/example/LICENSE", "License text\n");
    directory.createFile("skills/example/empty.txt", "");
    expect(
      collectFiles(directory.path)
        .map((file) => file.path)
        .sort(),
    ).toEqual([
      "skills/example/LICENSE",
      "skills/example/SKILL.md",
      "skills/example/config.json",
      "skills/example/empty.txt",
      "skills/example/scripts/check.py",
    ]);
  });

  test("preserves non-Markdown frontmatter-like content and Unicode exactly", () => {
    const content = "---\nname: 中文配置\n---\n# Not a heading\n";
    directory.createFile("skills/example/config.yaml", content);
    expect(collectFiles(directory.path)[0]).toMatchObject({
      content,
      frontmatter: {},
      isSystem: false,
    });
  });

  test("keeps Markdown frontmatter and core classification, including uppercase extensions", () => {
    directory.createFile(
      "system/persona.md",
      "---\ndescription: Persona\n---\n# Persona\n",
    );
    directory.createFile(
      "skills/example/README.MARKDOWN",
      "---\ndescription: Skill\n---\n# Skill\n",
    );
    const files = collectFiles(directory.path);
    expect(
      files.find((file) => file.path === "system/persona.md"),
    ).toMatchObject({
      isSystem: true,
      frontmatter: { description: "Persona" },
      content: "# Persona\n",
    });
    expect(
      files.find((file) => file.path.endsWith("README.MARKDOWN")),
    ).toMatchObject({
      isSystem: false,
      frontmatter: { description: "Skill" },
      content: "# Skill\n",
    });
  });

  test("keeps hidden files and git internals excluded", () => {
    directory.createFile(".git/HEAD", "ref: refs/heads/main");
    directory.createFile("skills/.hidden/script.py", "hidden");
    directory.createFile(".hidden.md", "hidden");
    directory.createFile("visible.md", "visible");
    expect(collectFiles(directory.path).map((file) => file.path)).toEqual([
      "visible.md",
    ]);
  });

  test("preserves a UTF-8 BOM and exact text bytes", () => {
    const content = "\ufeff中文 <tag>\r\n";
    directory.createFile("notes.txt", content);
    expect(collectFiles(directory.path)[0]).toMatchObject({
      content,
      contentType: "text",
      sizeBytes: Buffer.byteLength(content),
    });
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps unreadable files visible without blocking readable files",
    () => {
      const path = directory.createFile("private.txt", "private");
      directory.createFile("visible.md", "# Visible\n");
      chmodSync(path, 0);
      try {
        const files = collectFiles(directory.path);
        expect(files.find((file) => file.path === "private.txt")).toMatchObject(
          {
            content: "",
            contentType: "unreadable",
          },
        );
        const viewer = openViewer(files);
        expect(viewer.getElement("tree-panel-external").innerHTML).toContain(
          "unreadable",
        );
        const panel = viewer.select("private.txt");
        expect(panel.innerHTML).toContain(
          "Unable to read file. Preview is not available.",
        );
        expect(panel.innerHTML).not.toContain("raw-toggle");
        expect(viewer.select("visible.md").innerHTML).toContain(
          "<h1>Visible</h1>",
        );
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  test("lists binary and non-UTF-8 assets without embedding their bytes as text", () => {
    directory.createBinaryFile(
      "skills/example/assets/image.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
    );
    directory.createBinaryFile(
      "skills/example/assets/nul.bin",
      Buffer.from([65, 0, 66]),
    );
    directory.createBinaryFile(
      "skills/example/assets/invalid.txt",
      Buffer.from([0xc3, 0x28]),
    );
    const files = collectFiles(directory.path);
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(file).toMatchObject({
        content: "",
        frontmatter: {},
        contentType: "binary",
      });
    }
    expect(files.find((file) => file.path.endsWith("image.png"))).toMatchObject(
      { sizeBytes: 5 },
    );
  });

  test("shows files in the tree, escapes code, and preserves raw mode", () => {
    const content =
      '# <script>alert("test")</script>\n**not Markdown** & text\n';
    const path = "skills/example/scripts/check.py";
    directory.createFile(path, content);
    const viewer = openViewer(collectFiles(directory.path));
    expect(viewer.getElement("tree-panel-external").innerHTML).toContain(
      `data-path="${path}"`,
    );
    const panel = viewer.select(path);
    expect(panel.innerHTML).toContain(
      '<pre><code># &lt;script&gt;alert("test")&lt;/script&gt;',
    );
    expect(panel.innerHTML).toContain("**not Markdown** &amp; text");
    expect(panel.innerHTML).not.toContain("<script>");
    expect(panel.innerHTML).not.toContain("<strong>");
    panel.toggleButton?.dispatch({ target: { closest: () => null } });
    expect(panel.innerHTML).toContain(
      'class="file-body-raw" style="display:block"',
    );
  });

  test("renders Markdown normally and binary assets as metadata-only entries", () => {
    directory.createFile("system/persona.md", "# Persona\n");
    directory.createBinaryFile(
      "assets/image.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
    );
    const viewer = openViewer(collectFiles(directory.path));
    expect(viewer.select("system/persona.md", true).innerHTML).toContain(
      "<h1>Persona</h1>",
    );
    expect(viewer.getElement("tree-panel-external").innerHTML).toContain(
      "5 bytes",
    );
    const panel = viewer.select("assets/image.png");
    expect(panel.innerHTML).toContain(
      "Binary or non-UTF-8 file (5 bytes). Preview is not available.",
    );
    expect(panel.innerHTML).not.toContain("raw-toggle");
    expect(panel.innerHTML).not.toContain("file-body-raw");
  });
});
