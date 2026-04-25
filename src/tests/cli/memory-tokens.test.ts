import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemorySubcommand } from "../../cli/subcommands/memory";

interface Capture {
  stdout: string[];
  stderr: string[];
}

function captureConsole(): { capture: Capture; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => {
      stdout.push(args.map((a) => String(a)).join(" "));
    },
  );
  const errSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      stderr.push(args.map((a) => String(a)).join(" "));
    },
  );

  return {
    capture: { stdout, stderr },
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("letta memory tokens", () => {
  let tmpRoot: string;
  let priorMemoryDir: string | undefined;
  let priorAgentId: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memory-tokens-"));
    priorMemoryDir = process.env.MEMORY_DIR;
    priorAgentId = process.env.LETTA_AGENT_ID;
    delete process.env.MEMORY_DIR;
    delete process.env.LETTA_AGENT_ID;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (priorMemoryDir !== undefined) {
      process.env.MEMORY_DIR = priorMemoryDir;
    } else {
      delete process.env.MEMORY_DIR;
    }
    if (priorAgentId !== undefined) {
      process.env.LETTA_AGENT_ID = priorAgentId;
    } else {
      delete process.env.LETTA_AGENT_ID;
    }
  });

  function writeSystemFile(relativePath: string, content: string): void {
    const full = join(tmpRoot, "system", relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  test("returns 64 when no memory dir source is available", async () => {
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand(["tokens"]);
      expect(code).toBe(64);
      expect(capture.stderr.join("\n")).toContain("Missing memory dir");
    } finally {
      restore();
    }
  });

  test("tokens with --memory-dir and empty system/ exits 0", async () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
      ]);
      expect(code).toBe(0);
      expect(capture.stdout.join("\n")).toContain("Total: 0 tokens");
    } finally {
      restore();
    }
  });

  test("reads MEMORY_DIR env when --memory-dir not passed", async () => {
    writeSystemFile("persona.md", "abcd");
    process.env.MEMORY_DIR = tmpRoot;
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand(["tokens", "--quiet"]);
      expect(code).toBe(0);
      expect(capture.stdout.join("\n")).toContain("Total: 1 tokens");
    } finally {
      restore();
    }
  });

  test("--memory-dir takes precedence over $MEMORY_DIR", async () => {
    // Populate tmpRoot (used via --memory-dir), leave the env var pointing
    // at a nonexistent path to confirm the flag wins.
    writeSystemFile("persona.md", "a".repeat(8)); // 2 tokens
    process.env.MEMORY_DIR = "/nonexistent/does-not-exist";
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--quiet",
      ]);
      expect(code).toBe(0);
      expect(capture.stdout.join("\n")).toContain("Total: 2 tokens");
    } finally {
      restore();
    }
  });

  test("exits 0 regardless of size (CLI reports, does not judge)", async () => {
    writeSystemFile("persona.md", "a".repeat(4 * 50000));
    const { restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--quiet",
      ]);
      expect(code).toBe(0);
    } finally {
      restore();
    }
  });

  test("returns 64 for invalid --format", async () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--format",
        "xml",
      ]);
      expect(code).toBe(64);
      expect(capture.stderr.join("\n")).toContain("Invalid --format");
    } finally {
      restore();
    }
  });

  test("returns 64 for invalid --top", async () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--top",
        "abc",
      ]);
      expect(code).toBe(64);
      expect(capture.stderr.join("\n")).toContain("Invalid --top");
    } finally {
      restore();
    }
  });

  test("json output contains expected fields and nothing else", async () => {
    writeSystemFile("persona.md", "abcd");
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--format",
        "json",
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(capture.stdout.join("\n"));
      expect(parsed.total_tokens).toBe(1);
      expect(parsed.files).toEqual([{ path: "system/persona.md", tokens: 1 }]);
      // No policy fields.
      expect(parsed.status).toBeUndefined();
      expect(parsed.threshold_warn).toBeUndefined();
      expect(parsed.threshold_fail).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("text output includes top files sorted by tokens desc", async () => {
    writeSystemFile("small.md", "a".repeat(4)); // 1 token
    writeSystemFile("large.md", "a".repeat(40)); // 10 tokens
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
      ]);
      expect(code).toBe(0);
      const out = capture.stdout.join("\n");
      const largeIdx = out.indexOf("system/large.md");
      const smallIdx = out.indexOf("system/small.md");
      expect(largeIdx).toBeGreaterThanOrEqual(0);
      expect(smallIdx).toBeGreaterThanOrEqual(0);
      expect(largeIdx).toBeLessThan(smallIdx);
    } finally {
      restore();
    }
  });

  test("--quiet suppresses per-file breakdown", async () => {
    writeSystemFile("persona.md", "abcd");
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--quiet",
      ]);
      expect(code).toBe(0);
      const out = capture.stdout.join("\n");
      expect(out).toContain("Total:");
      expect(out).not.toContain("Top files:");
      expect(out).not.toContain("system/persona.md");
    } finally {
      restore();
    }
  });

  test("help usage mentions tokens", async () => {
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([]);
      expect(code).toBe(0);
      expect(capture.stdout.join("\n")).toContain("letta memory tokens");
    } finally {
      restore();
    }
  });
});
