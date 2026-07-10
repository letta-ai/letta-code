#!/usr/bin/env bun

const LABEL_WIDTH = 32;

function formatLabel(name) {
  const dots = ".".repeat(Math.max(3, LABEL_WIDTH - name.length - 1));
  return `${name} ${dots}`;
}

function parseFileCount(output) {
  const m = output.match(/(?:Processed|Checked) ([\d,]+) files/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const checks = [
  { name: "circular dependencies", script: ["check:cycles", "--no-spinner"] },
  { name: "layer boundaries", script: ["check:boundaries"] },
  { name: "exported function style", script: ["check:exported-functions"] },
  { name: "filename casing", script: ["check:filename-casing"] },
  { name: "source file size", script: ["check:file-size"] },
  { name: "module ownership", script: ["check:module-ownership"] },
  { name: "test mock isolation", script: ["check:test-mock-isolation"] },
  { name: "test coverage", script: ["check:test-coverage"] },
  { name: "skill frontmatter", script: ["check:skill-frontmatter"] },
  { name: "bundled skill scripts", script: ["check:bundled-skill-scripts"] },
  { name: "biome", script: ["lint"] },
  { name: "typescript", script: ["typecheck"] },
];

const N = checks.length;
let failed = 0;
const wallStart = performance.now();

for (let i = 0; i < N; i++) {
  const { name, script } = checks[i];
  const t0 = performance.now();

  const proc = Bun.spawn(["bun", "run", ...script], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const ok = exitCode === 0;
  const combined = stdout + stderr;
  const count = parseFileCount(combined);
  const countStr = count ? `  (${count.toLocaleString()} files)` : "";

  process.stdout.write(
    `[${i + 1}/${N}] ${formatLabel(name)} ${ok ? "PASS" : "FAIL"}  ${elapsed}s${countStr}\n`,
  );

  if (!ok) {
    failed++;
    const lines = combined
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines) {
      process.stderr.write(`       ${line}\n`);
    }
    process.stderr.write("\n");
  }
}

const total = ((performance.now() - wallStart) / 1000).toFixed(1);
process.stdout.write("\n");

if (failed === 0) {
  process.stdout.write(`✓ ${N} checks passed in ${total}s\n`);
} else {
  process.stderr.write(`✗ ${failed} of ${N} checks failed in ${total}s\n`);
  process.exit(1);
}
