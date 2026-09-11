import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "./generate-memory-viewer";

describe("collectFiles", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-memory-viewer-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  test("collects markdown files with frontmatter parsed", () => {
    const sysDir = join(tempRoot, "system");
    mkdirSync(sysDir, { recursive: true });

    writeFileSync(
      join(sysDir, "persona.md"),
      "---\ndescription: Agent persona\nread_only: true\n---\nI am a helpful agent.",
    );

    const files = collectFiles(tempRoot);
    expect(files).toHaveLength(1);
    const persona = files[0];
    expect(persona).toBeDefined();
    if (persona) {
      expect(persona).toEqual({
        path: "system/persona.md",
        isSystem: true,
        frontmatter: {
          description: "Agent persona",
          read_only: "true",
        },
        content: "I am a helpful agent.",
      });
    }
  });

  test("collects non-Markdown files without dropping them", () => {
    const skillsDir = join(tempRoot, "skills", "data-analyzer");
    const scriptsDir = join(skillsDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });

    writeFileSync(
      join(skillsDir, "SKILL.md"),
      "---\ndescription: Data analyzer skill\n---\nSkill instructions here.",
    );
    writeFileSync(
      join(scriptsDir, "process.py"),
      'def run():\n    print("processing data")\n',
    );
    writeFileSync(
      join(skillsDir, "config.json"),
      '{\n  "version": "1.0.0"\n}\n',
    );
    writeFileSync(
      join(skillsDir, "run.sh"),
      "#!/bin/bash\npython scripts/process.py\n",
    );

    const files = collectFiles(tempRoot);
    const paths = files.map((f) => f.path).sort();

    expect(paths).toEqual([
      "skills/data-analyzer/SKILL.md",
      "skills/data-analyzer/config.json",
      "skills/data-analyzer/run.sh",
      "skills/data-analyzer/scripts/process.py",
    ]);

    const pyFile = files.find((f) => f.path.endsWith("process.py"));
    expect(pyFile).toBeDefined();
    expect(pyFile?.isSystem).toBe(false);
    expect(pyFile?.frontmatter).toEqual({});
    expect(pyFile?.content).toBe('def run():\n    print("processing data")\n');

    const jsonFile = files.find((f) => f.path.endsWith("config.json"));
    expect(jsonFile).toBeDefined();
    expect(jsonFile?.isSystem).toBe(false);
    expect(jsonFile?.frontmatter).toEqual({});
    expect(jsonFile?.content).toBe('{\n  "version": "1.0.0"\n}\n');
  });

  test("preserves non-markdown content starting with triple dashes", () => {
    const extDir = join(tempRoot, "configs");
    mkdirSync(extDir, { recursive: true });

    const yamlContent = "---\nversion: 2\nname: test\n";
    writeFileSync(join(extDir, "settings.yaml"), yamlContent);

    const files = collectFiles(tempRoot);
    expect(files).toHaveLength(1);
    const yamlFile = files[0];
    expect(yamlFile).toBeDefined();
    if (yamlFile) {
      expect(yamlFile.path).toBe("configs/settings.yaml");
      expect(yamlFile.frontmatter).toEqual({});
      expect(yamlFile.content).toBe(yamlContent);
    }
  });

  test("ignores hidden files and directories", () => {
    const gitDir = join(tempRoot, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    writeFileSync(join(tempRoot, ".hidden.md"), "secret");
    writeFileSync(join(tempRoot, "visible.txt"), "hello world");

    const files = collectFiles(tempRoot);
    expect(files).toHaveLength(1);
    const visibleFile = files[0];
    expect(visibleFile).toBeDefined();
    if (visibleFile) {
      expect(visibleFile.path).toBe("visible.txt");
      expect(visibleFile.content).toBe("hello world");
    }
  });
});
