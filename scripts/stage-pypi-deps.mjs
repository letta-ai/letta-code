import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const app = resolve(process.argv[2]);
const roots = [
  "ws",
  "@vscode/ripgrep",
  "node-pty",
  "grammy",
  "@pierre/diffs",
  "@shikijs/langs",
  "sharp",
];

function locate(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    if (dir === dirname(dir))
      throw new Error(`Missing locked dependency ${name} from ${from}`);
  }
}
function compatible(pkg) {
  return (
    (!pkg.os || pkg.os.includes(process.platform)) &&
    (!pkg.cpu || pkg.cpu.includes(process.arch)) &&
    (!pkg.libc || pkg.libc.includes("glibc"))
  );
}
function copy(name, from, dest, ancestors = new Set()) {
  const source = locate(name, from);
  const pkg = JSON.parse(readFileSync(join(source, "package.json")));
  if (!compatible(pkg)) return;
  if (ancestors.has(source)) throw new Error(`Dependency cycle at ${source}`);
  const target = join(dest, "node_modules", name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === source ||
      !["node_modules", ".git"].includes(
        path.slice(source.length + 1).split(/[\\/]/)[0],
      ),
  });
  const chain = new Set([...ancestors, source]);
  const optional = pkg.optionalDependencies || {};
  for (const dependency of Object.keys({ ...pkg.dependencies, ...optional })) {
    try {
      locate(dependency, source);
    } catch (error) {
      if (dependency in optional) continue;
      throw error;
    }
    copy(dependency, source, target, chain);
  }
}
for (const name of roots) copy(name, root, app);

function licenses(dir, destination) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== ".bin")
      licenses(path, join(destination, entry.name));
    else if (
      entry.isFile() &&
      /^(licen[sc]e|copying|notice)([.-]|$)/i.test(entry.name)
    ) {
      mkdirSync(destination, { recursive: true });
      cpSync(path, join(destination, entry.name));
    }
  }
}
licenses(join(root, "node_modules"), join(app, "third-party-licenses"));
