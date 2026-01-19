#!/usr/bin/env bun
/**
 * Windows-specific headless integration test
 *
 * Tests that Letta Code works correctly on Windows by:
 * 1. Running shell commands (tests PowerShell preference)
 * 2. Creating a multiline echo (tests heredoc avoidance)
 * 3. Checking tool availability (tests PATH)
 *
 * Only runs on Windows (process.platform === 'win32')
 *
 * Usage:
 *   bun run src/tests/headless-windows.ts --model haiku
 */

type Args = {
  model: string;
};

function parseArgs(argv: string[]): Args {
  const args: { model?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--model") args.model = argv[++i];
  }
  if (!args.model) throw new Error("Missing --model");
  return args as Args;
}

async function ensurePrereqs(): Promise<"ok" | "skip"> {
  if (process.platform !== "win32") {
    console.log("SKIP: Not running on Windows");
    return "skip";
  }
  if (!process.env.LETTA_API_KEY) {
    console.log("SKIP: Missing env LETTA_API_KEY");
    return "skip";
  }
  return "ok";
}

function windowsScenarioPrompt(): string {
  return (
    "I want to test Windows shell compatibility (do not ask for any clarifications, this is an automated test on a Windows CI runner). " +
    "IMPORTANT: You are running on Windows with PowerShell. Do NOT use bash-specific syntax like heredoc ($(cat <<'EOF'...EOF)) or && for chaining. " +
    "Step 1: Run a simple shell command: echo 'Hello from Windows' " +
    "Step 2: Run a multiline echo command. Do NOT use heredoc or && syntax. Use PowerShell semicolon syntax: echo 'Line1'; echo 'Line2' " +
    "Step 3: Check if git is available by running: git --version " +
    "IMPORTANT: If all three steps completed successfully (no errors), include the word BANANA (uppercase) in your final response. " +
    "If any step failed due to shell syntax issues, do NOT include BANANA."
  );
}

async function runCLI(
  model: string,
): Promise<{ stdout: string; code: number }> {
  const cmd = [
    "bun",
    "run",
    "dev",
    "-p",
    windowsScenarioPrompt(),
    "--yolo",
    "--new-agent",
    "--output-format",
    "text",
    "-m",
    model,
  ];
  // Mark as subagent to prevent polluting user's LRU settings
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LETTA_CODE_AGENT_ROLE: "subagent" },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.error("CLI failed:", err || out);
  }
  return { stdout: out, code };
}

async function main() {
  const { model } = parseArgs(process.argv.slice(2));
  const prereq = await ensurePrereqs();
  if (prereq === "skip") return;

  console.log(`Running Windows integration test with model: ${model}`);
  console.log("Platform:", process.platform);

  const { stdout, code } = await runCLI(model);

  if (code !== 0) {
    console.error("CLI exited with non-zero code:", code);
    process.exit(code);
  }

  // Check for success marker
  if (stdout.includes("BANANA")) {
    console.log(`✅ PASS: Windows integration test succeeded with ${model}`);
  } else {
    console.error(`❌ FAIL: Windows integration test failed`);
    console.error("\n===== BEGIN STDOUT =====");
    console.error(stdout);
    console.error("===== END STDOUT =====\n");

    // Check for common failure patterns
    if (stdout.includes("heredoc") || stdout.includes("<<'EOF'")) {
      console.error("FAILURE REASON: Agent used heredoc syntax on Windows");
    }
    if (stdout.includes("not recognized") || stdout.includes("not found")) {
      console.error("FAILURE REASON: Command not found (PATH issue?)");
    }

    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
