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

describe("letta memory subcommand", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memory-subcommand-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSystemFile(relativePath: string, content: string): void {
    const full = join(tmpRoot, "system", relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  test("prints usage with no action and exits 0", async () => {
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([]);
      expect(code).toBe(0);
      expect(capture.stdout.join("\n")).toContain("letta memory tokens");
    } finally {
      restore();
    }
  });

  test("returns 64 when --memory-dir missing and MEMORY_DIR unset", async () => {
    const prior = process.env.MEMORY_DIR;
    delete process.env.MEMORY_DIR;
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand(["tokens"]);
      expect(code).toBe(64);
      expect(capture.stderr.join("\n")).toContain("Missing memory dir");
    } finally {
      if (prior !== undefined) process.env.MEMORY_DIR = prior;
      restore();
    }
  });

  test("tokens action with empty system/ exits 0", async () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
      ]);
      expect(code).toBe(0);
      const out = capture.stdout.join("\n");
      expect(out).toContain("Total: 0 tokens");
      expect(out).toContain("Status: within target");
    } finally {
      restore();
    }
  });

  test("exits 0 when under warn threshold", async () => {
    writeSystemFile("persona.md", "a".repeat(4 * 10000)); // ~10k tokens
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

  test("exits 1 when between warn and fail", async () => {
    // 4 bytes/token, so 90k bytes -> 22.5k tokens
    writeSystemFile("persona.md", "a".repeat(4 * 22500));
    const { restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--quiet",
      ]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });

  test("exits 2 when over fail threshold", async () => {
    // 4 bytes/token, so 120k bytes -> 30k tokens (> 25k default fail)
    writeSystemFile("persona.md", "a".repeat(4 * 30000));
    const { restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--quiet",
      ]);
      expect(code).toBe(2);
    } finally {
      restore();
    }
  });

  test("respects --threshold-warn and --threshold-fail overrides", async () => {
    writeSystemFile("persona.md", "a".repeat(4 * 100)); // 100 tokens
    const { restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--threshold-warn",
        "50",
        "--threshold-fail",
        "200",
        "--quiet",
      ]);
      expect(code).toBe(1); // 100 is > 50 (warn) but <= 200 (fail)
    } finally {
      restore();
    }
  });

  test("returns 64 when --threshold-fail < --threshold-warn", async () => {
    mkdirSync(join(tmpRoot, "system"), { recursive: true });
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand([
        "tokens",
        "--memory-dir",
        tmpRoot,
        "--threshold-warn",
        "1000",
        "--threshold-fail",
        "500",
      ]);
      expect(code).toBe(64);
      expect(capture.stderr.join("\n")).toContain("Invalid thresholds");
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

  test("json output contains expected fields", async () => {
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
      expect(parsed.status).toBe("within_target");
      expect(parsed.threshold_warn).toBe(20000);
      expect(parsed.threshold_fail).toBe(25000);
      expect(parsed.files).toEqual([{ path: "system/persona.md", tokens: 1 }]);
    } finally {
      restore();
    }
  });

  test("text output includes top files sorted by tokens", async () => {
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
      expect(largeIdx).toBeLessThan(smallIdx); // large printed first
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

  test("unknown action returns 64", async () => {
    const { capture, restore } = captureConsole();
    try {
      const code = await runMemorySubcommand(["nonsense"]);
      expect(code).toBe(64);
      expect(capture.stderr.join("\n")).toContain("Unknown action");
    } finally {
      restore();
    }
  });
});
