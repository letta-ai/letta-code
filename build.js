#!/usr/bin/env bun

/**
 * Build script for Letta Code CLI
 * Bundles TypeScript source into a single JavaScript file
 */

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const version = pkg.version;

console.log(`📦 Building Letta Code v${version}...`);

await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: ".",
  target: "node",
  format: "esm",
  minify: false, // Keep readable for debugging
  sourcemap: "external",
  naming: {
    entry: "letta.js",
  },
  define: {
    "process.env.LETTA_VERSION": JSON.stringify(version),
  },
  // Load text files as strings (for markdown, etc.)
  loader: {
    ".md": "text",
    ".mdx": "text",
    ".txt": "text",
  },
});

// Add shebang to output file
const outputPath = join(__dirname, "letta.js");
let content = readFileSync(outputPath, "utf-8");

// Remove any existing shebang first
if (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}

const withShebang = `#!/usr/bin/env node\n${content}`;
await Bun.write(outputPath, withShebang);

// Make executable
await Bun.$`chmod +x letta.js`;

// Copy bundled skills to skills/ directory for shipping
const bundledSkillsSrc = join(__dirname, "src/skills/builtin");
const bundledSkillsDst = join(__dirname, "skills");

if (existsSync(bundledSkillsSrc)) {
  // Clean and copy
  if (existsSync(bundledSkillsDst)) {
    rmSync(bundledSkillsDst, { recursive: true });
  }
  cpSync(bundledSkillsSrc, bundledSkillsDst, { recursive: true });
  console.log("📂 Copied bundled skills to skills/");
}

console.log("✅ Build complete!");
console.log(`   Output: letta.js`);
console.log(
  `   Size: ${((await Bun.file(outputPath).size) / 1024).toFixed(0)}KB`,
);
