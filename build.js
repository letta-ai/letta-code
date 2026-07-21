#!/usr/bin/env bun

/**
 * Build script for Letta Code CLI
 * Bundles TypeScript source into a single JavaScript file
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function walkFiles(root) {
  const entries = readdirSync(root);
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkFiles(path));
      continue;
    }
    files.push(path);
  }
  return files;
}

function toDeclarationSpecifier(fromFile, targetRoot, aliasPath) {
  const targetPath = join(targetRoot, aliasPath);
  const relativePath = relative(dirname(fromFile), targetPath).replaceAll(
    "\\",
    "/",
  );
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function rewriteDeclarationAliases(typesRoot) {
  for (const file of walkFiles(typesRoot)) {
    if (!file.endsWith(".d.ts")) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    const rewritten = source.replace(
      /(["'])@\/([^"']+)\1/g,
      (_match, quote, aliasPath) =>
        `${quote}${toDeclarationSpecifier(file, typesRoot, aliasPath)}${quote}`,
    );
    if (rewritten !== source) {
      writeFileSync(file, rewritten);
    }
  }
}

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
  // Keep most native Node.js modules external to avoid bundling issues.
  // grammY must stay external too: bundling its node-fetch/abort-controller
  // stack into letta.js breaks Telegram startup because node-fetch rejects the
  // bundled AbortSignal class during bot.init().
  // But don't make `sharp` external, causes issues with global Bun-based installs
  // ref: #745, #1200
  external: ["ws", "@vscode/ripgrep", "node-pty", "grammy"],
  features: features,
});

// Add shebang to output file
const outputPath = join(__dirname, "letta.js");
let content = readFileSync(outputPath, "utf-8");

// Remove any existing shebang first
if (content.startsWith("#!")) {
  content = content.slice(content.indexOf("\n") + 1);
}

const withShebang = `#!/usr/bin/env node
${content}`;
await Bun.write(outputPath, withShebang);

// Make executable
if (process.platform !== "win32") {
  await Bun.$`chmod +x letta.js`;
}

await Bun.build({
  entrypoints: ["./src/app-server-client.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "app-server-client.js",
  },
});

// Browser-safe agent creation presets (personalities, prompts, tags) for
// surfaces that create Letta Code agents through Core (e.g. the chat web app).
await Bun.build({
  entrypoints: ["./src/agent-presets.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "agent-presets.js",
  },
  loader: {
    ".md": "text",
    ".mdx": "text",
    ".txt": "text",
  },
});

await Bun.build({
  entrypoints: ["./src/channels-public.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "channels-public.js",
  },
});

await Bun.build({
  entrypoints: ["./src/channels-slack.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  naming: {
    entry: "channels-slack.js",
  },
});

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

// Generate type declarations for wire types export
console.log("📝 Generating type declarations...");
await Bun.$`bunx tsc -p tsconfig.types.json`;
rewriteDeclarationAliases(join(__dirname, "dist/types"));
console.log("   Output: dist/types/protocol.d.ts");

console.log("✅ Build complete!");
console.log(`   Output: letta.js`);
console.log("   Output: dist/app-server-client.js");
console.log(`   Size: ${(Bun.file(outputPath).size / 1024).toFixed(0)}KB`);
