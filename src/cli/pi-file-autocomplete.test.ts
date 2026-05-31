import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyPiFileCompletion,
  PiFileAutocompleteProvider,
} from "@/cli/helpers/pi-file-autocomplete";

async function setupFolder(
  baseDir: string,
  structure: { dirs?: string[]; files?: Record<string, string> },
): Promise<void> {
  for (const dir of structure.dirs ?? []) {
    await mkdir(join(baseDir, dir), { recursive: true });
  }
  for (const [filePath, contents] of Object.entries(structure.files ?? {})) {
    const fullPath = join(baseDir, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }
}

async function createFakeFd(rootDir: string): Promise<string> {
  const fdPath = join(rootDir, "fd");
  await writeFile(
    fdPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let baseDir = process.cwd();
let maxResults = Infinity;
let query = "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--base-directory") {
    baseDir = args[++i];
  } else if (arg === "--max-results") {
    maxResults = Number(args[++i]);
  } else if (arg === "--type" || arg === "--exclude") {
    i++;
  } else if (!arg.startsWith("-")) {
    query = arg;
  }
}
let pattern = null;
if (query) {
  try {
    pattern = new RegExp(query, "i");
  } catch {
    pattern = null;
  }
}
const out = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\\\/g, "/");
    if (entry.isDirectory()) {
      const display = rel + "/";
      if (!query || (pattern ? pattern.test(display) : display.toLowerCase().includes(query.toLowerCase()))) {
        out.push(display);
      }
      visit(full);
    } else if (entry.isFile()) {
      if (!query || (pattern ? pattern.test(rel) : rel.toLowerCase().includes(query.toLowerCase()))) {
        out.push(rel);
      }
    }
    if (out.length >= maxResults) return;
  }
}
visit(baseDir);
process.stdout.write(out.slice(0, maxResults).join("\\n"));
`,
  );
  await chmod(fdPath, 0o755);
  return fdPath;
}

const describeFd = process.platform === "win32" ? describe.skip : describe;

describe("Pi @ file completion application", () => {
  test("adds a trailing space for files", () => {
    const result = applyPiFileCompletion(
      "read @REA",
      9,
      {
        value: "@README.md",
        label: "README.md",
        description: "README.md",
      },
      "@REA",
    );

    expect(result).toEqual({
      value: "read @README.md ",
      cursorPosition: "read @README.md ".length,
    });
  });

  test("does not add a trailing space for directories", () => {
    const result = applyPiFileCompletion(
      "read @sr",
      8,
      {
        value: "@src/",
        label: "src/",
        description: "src",
      },
      "@sr",
    );

    expect(result).toEqual({
      value: "read @src/",
      cursorPosition: "read @src/".length,
    });
  });
});

describeFd("PiFileAutocompleteProvider fd @ suggestions", () => {
  let rootDir = "";
  let baseDir = "";
  let fdPath = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "letta-pi-autocomplete-root-"));
    baseDir = join(rootDir, "cwd");
    await mkdir(baseDir, { recursive: true });
    fdPath = await createFakeFd(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("returns all files and folders for empty @ query", async () => {
    await setupFolder(baseDir, {
      dirs: ["src"],
      files: { "README.md": "readme" },
    });

    const provider = new PiFileAutocompleteProvider(baseDir, fdPath);
    const result = await provider.getSuggestions("@", 1, {
      signal: new AbortController().signal,
    });

    const values = result?.items.map((item) => item.value).sort();
    expect(values).toEqual(["@README.md", "@src/"].sort());
  });

  test("matches file with extension in query", async () => {
    await setupFolder(baseDir, {
      files: { "file.txt": "content" },
    });

    const provider = new PiFileAutocompleteProvider(baseDir, fdPath);
    const result = await provider.getSuggestions("@file.txt", 9, {
      signal: new AbortController().signal,
    });

    const values = result?.items.map((item) => item.value);
    expect(values).toContain("@file.txt");
  });

  test("scopes fuzzy search when @ query contains a slash", async () => {
    await setupFolder(baseDir, {
      dirs: ["src"],
      files: {
        "src/Button.tsx": "button",
        "other/Button.tsx": "other",
      },
    });

    const provider = new PiFileAutocompleteProvider(baseDir, fdPath);
    const result = await provider.getSuggestions("@src/But", 8, {
      signal: new AbortController().signal,
    });

    const values = result?.items.map((item) => item.value);
    expect(values).toContain("@src/Button.tsx");
    expect(values).not.toContain("@other/Button.tsx");
  });

  test("quotes completions containing spaces like Pi", async () => {
    await setupFolder(baseDir, {
      files: { "file with spaces.txt": "content" },
    });

    const provider = new PiFileAutocompleteProvider(baseDir, fdPath);
    const result = await provider.getSuggestions("@file", 5, {
      signal: new AbortController().signal,
    });

    const values = result?.items.map((item) => item.value);
    expect(values).toContain('@"file with spaces.txt"');
  });
});
