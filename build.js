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
const useMagick = Bun.env.USE_MAGICK;
const features = [];

console.log(`📦 Building Letta Code v${version}...`);
if (useMagick) {
  console.log(`🪄 Using magick variant of imageResize...`);
  features.push("USE_MAGICK");
}

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
    LETTA_VERSION: JSON.stringify(version),
    BUILD_TIME: JSON.stringify(new Date().toISOString()),
    __USE_MAGICK__: useMagick ? "true" : "false",
  },
  // Load text files as strings (for markdown, etc.)
  loader: {
    ".md": "text",
    ".mdx": "text",
    ".txt": "text",
  },
  // Keep most native Node.js modules external to avoid bundling issues
  // But don't make `sharp` external, causes issues with global Bun-based installs
  // ref: #745, #1200
  external: ["ws", "@vscode/ripgrep", "node-pty"],
  features: features,
});

// Add shebang to output file
const outputPath = join(__dirname, "letta.js");
let content = readFileSync(outputPath, "utf-8");

// Remove any existing shebang first
if (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}

// Patch secrets requirement back in for node build
content = content.replace(
  `(()=>{throw new Error("Cannot require module "+"bun");})().secrets`,
  `globalThis.Bun.secrets`,
);

const withShebang = `#!/usr/bin/env node
${content}`;
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

// Copy bundled commands to commands/ directory for shipping
const bundledCommandsSrc = join(__dirname, "src/cli/commands/bundled");
const bundledCommandsDst = join(__dirname, "commands");

if (existsSync(bundledCommandsSrc)) {
  if (existsSync(bundledCommandsDst)) {
    rmSync(bundledCommandsDst, { recursive: true });
  }
  cpSync(bundledCommandsSrc, bundledCommandsDst, { recursive: true });
  console.log("📂 Copied bundled commands to commands/");
}

// Generate type declarations for wire types export
console.log("📝 Generating type declarations...");
await Bun.$`bunx tsc -p tsconfig.types.json`;
console.log("   Output: dist/types/protocol.d.ts");

console.log("✅ Build complete!");
console.log(`   Output: letta.js`);
console.log(`   Size: ${(Bun.file(outputPath).size / 1024).toFixed(0)}KB`);
