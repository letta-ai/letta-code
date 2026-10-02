import path from "node:path";
import * as ts from "typescript";
import { isTypeScriptModFileExtension } from "@/mods/file-extensions";

/**
 * Extension for the cache copy of a mod that the engine actually imports.
 *
 * The engine imports the cache copy through `import()`, so the extension decides
 * the module format. A `.mjs` copy is always ESM, which strips `require()` and
 * `module.exports` from a CommonJS mod, so Node fails on the first `require()`
 * call instead of resolving it. A `.cjs` copy keeps CommonJS semantics, so
 * `require()` resolves builtins and bare packages from `<mod-cache>/node_modules`
 * the same way it does for any other CommonJS file on disk.
 */
export type ModCacheEntryExtension = ".cjs" | ".mjs";

/**
 * Detects the CommonJS export surface: a `require(...)` call, or an assignment
 * to `module.exports` / `exports.<name>`.
 */
function usesCommonJsModuleSyntax(sourceFile: ts.SourceFile): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      found = true;
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      (node.left.expression.text === "module" ||
        node.left.expression.text === "exports")
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Picks the cache extension for one mod.
 *
 * Transpiled TypeScript and explicit `.mjs` mods are ESM by construction. A
 * `.js` mod is ambiguous: Node reads a bare `.js` file as CommonJS unless a
 * sibling `package.json` says otherwise, so the source decides. Real
 * `import`/`export` syntax stays ESM, a CommonJS export surface becomes `.cjs`,
 * and a script with no module syntax keeps the previous `.mjs` behavior.
 */
export function resolveModCacheExtension(
  modPath: string,
  importableSource: string,
): ModCacheEntryExtension {
  const fileExtension = path.extname(modPath);
  if (isTypeScriptModFileExtension(fileExtension) || fileExtension === ".mjs") {
    return ".mjs";
  }

  const sourceFile = ts.createSourceFile(
    modPath,
    importableSource,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );

  if (ts.isExternalModule(sourceFile)) return ".mjs";

  return usesCommonJsModuleSyntax(sourceFile) ? ".cjs" : ".mjs";
}