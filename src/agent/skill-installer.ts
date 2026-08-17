import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { isLocalAgentId } from "@/agent/agent-id";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import { parseFrontmatter } from "@/utils/frontmatter";

const HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const HERMES_OPTIONAL_SKILLS_DIR = "optional-skills";
export const MAX_DIRECT_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_FILES = 1000;

interface SkillSourceLocation {
  repoUrl: string;
  branch: string | null;
  subdir: string | null;
}

interface DirectSkillFileSourceLocation {
  url: string;
}

interface SkillMemorySyncResult {
  status: MemoryPostTurnSyncResult["status"];
  summary: string;
}

type SkillMemorySyncFn = (
  agentId: string,
  options: { memoryDir?: string },
) => Promise<MemoryPostTurnSyncResult>;

export interface InstallResult {
  agentId: string;
  name: string;
  path: string;
  source: string;
  committed?: boolean;
  commitSha?: string;
  memorySync?: SkillMemorySyncResult;
}

export interface SkillPreview {
  name: string;
  description?: string;
  skillMd: string;
}

interface SkillListItem {
  name: string;
  path: string;
  description?: string;
}

export interface DeleteResult {
  agentId: string;
  name: string;
  path: string;
  deleted: true;
  committed?: boolean;
  commitSha?: string;
  memorySync?: SkillMemorySyncResult;
}

interface ClawHubSourceLocation {
  slug: string;
  version: string | null;
}

type ResolvedSkillSource =
  | { type: "git"; location: SkillSourceLocation }
  | { type: "direct-file"; location: DirectSkillFileSourceLocation }
  | { type: "clawhub"; location: ClawHubSourceLocation };

type FetchSkillFile = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const CLAWHUB_API_BASE_URL = "https://clawhub.ai/api/v1";
function parseAbsoluteUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isLocalhostHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function parseGitHubSpecifier(
  input: string,
): SkillSourceLocation | null {
  const trimmed = input.trim();
  const url = parseAbsoluteUrl(trimmed);

  if (
    url &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname.toLowerCase() === "github.com"
  ) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repoWithSuffix] = parts;
    const repo = repoWithSuffix?.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const marker = parts[2];
    if ((marker === "tree" || marker === "blob") && parts.length >= 4) {
      const treePath = parts.slice(3).join("/");
      return {
        repoUrl,
        branch: null,
        subdir: marker === "blob" ? dirname(treePath) : treePath,
      };
    }
    return { repoUrl, branch: null, subdir: null };
  }

  if (url) return null;

  const shorthand = trimmed.split("/").filter(Boolean);
  if (shorthand.length >= 3 && shorthand[0] !== "official") {
    return {
      repoUrl: `https://github.com/${shorthand[0]}/${shorthand[1]}.git`,
      branch: null,
      subdir: shorthand.slice(2).join("/"),
    };
  }

  if (shorthand.length === 2 && shorthand[0] !== "official") {
    return {
      repoUrl: `https://github.com/${shorthand[0]}/${shorthand[1]}.git`,
      branch: null,
      subdir: null,
    };
  }

  return null;
}

export function parseDirectSkillFileUrlSpecifier(
  input: string,
): DirectSkillFileSourceLocation | null {
  const url = parseAbsoluteUrl(input.trim());
  if (!url) return null;
  if (url.username || url.password) return null;
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLocalhostHostname(url.hostname))
  ) {
    return null;
  }
  if (basename(url.pathname).toLowerCase() !== "skill.md") return null;
  return { url: url.toString() };
}

export function parseClawHubSpecifier(
  input: string,
): ClawHubSourceLocation | null {
  const trimmed = input.trim();
  let identifier: string | null = null;

  if (trimmed.startsWith("clawhub:")) {
    identifier = trimmed.slice("clawhub:".length);
  } else if (trimmed.startsWith("clawhub/")) {
    identifier = trimmed.slice("clawhub/".length);
  } else if (
    trimmed.startsWith("https://clawhub.ai/") ||
    trimmed.startsWith("http://clawhub.ai/")
  ) {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const skillIndex = parts.indexOf("skills");
    const skillSlug = parts[skillIndex + 1];
    if (skillIndex >= 0 && skillSlug) {
      identifier = skillSlug;
    } else {
      identifier = parts.at(-1) ?? null;
    }
    const version = url.searchParams.get("version");
    if (identifier && version) identifier = `${identifier}@${version}`;
  }

  if (!identifier) return null;
  const cleaned = identifier.replace(/^\/+|\/+$/g, "");
  const finalSegment = cleaned.split("/").filter(Boolean).at(-1);
  if (!finalSegment) return null;

  const atIndex = finalSegment.lastIndexOf("@");
  const slug = atIndex >= 0 ? finalSegment.slice(0, atIndex) : finalSegment;
  const version = atIndex >= 0 ? finalSegment.slice(atIndex + 1) : null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) return null;
  if (version !== null && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
    return null;
  }
  return { slug, version: version || null };
}

function parseOfficialSpecifier(input: string): SkillSourceLocation | null {
  if (!input.startsWith("official/")) return null;
  const relativePath = input
    .slice("official/".length)
    .replace(/^\/+|\/+$/g, "");
  if (!relativePath || relativePath.includes("..")) return null;
  return {
    repoUrl: HERMES_REPO_URL,
    branch: null,
    subdir: `${HERMES_OPTIONAL_SKILLS_DIR}/${relativePath}`,
  };
}

function resolveSkillSourceSpecifier(
  input: string,
): ResolvedSkillSource | null {
  const clawHubSource = parseClawHubSpecifier(input);
  if (clawHubSource) {
    return { type: "clawhub", location: clawHubSource };
  }

  const gitSource =
    parseOfficialSpecifier(input) ?? parseGitHubSpecifier(input);
  if (gitSource) {
    return { type: "git", location: gitSource };
  }

  const directFileSource = parseDirectSkillFileUrlSpecifier(input);
  if (directFileSource) {
    return { type: "direct-file", location: directFileSource };
  }

  return null;
}

async function execFile(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
) {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFileCb)(command, args, options);
}

async function resolveBranchAndSubdir(
  location: SkillSourceLocation,
): Promise<SkillSourceLocation> {
  if (!location.subdir) return location;

  const { stdout } = await execFile(
    "git",
    ["ls-remote", "--heads", location.repoUrl],
    {
      timeout: 60_000,
    },
  );
  const branches = stdout
    .split("\n")
    .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => Boolean(branch))
    .sort((a, b) => b.length - a.length);

  for (const branch of branches) {
    if (location.subdir === branch) {
      return { ...location, branch, subdir: null };
    }
    if (location.subdir.startsWith(`${branch}/`)) {
      return {
        ...location,
        branch,
        subdir: location.subdir.slice(branch.length + 1),
      };
    }
  }

  return location;
}

async function cloneSkillSource(
  location: SkillSourceLocation,
): Promise<{ tmpDir: string; sourceDir: string }> {
  const resolvedLocation = await resolveBranchAndSubdir(location);
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-skill-install-"));
  const args = ["clone", "--depth", "1"];
  if (resolvedLocation.branch) {
    args.push("--branch", resolvedLocation.branch);
  }
  args.push(resolvedLocation.repoUrl, tmpDir);
  await execFile("git", args, { timeout: 120_000 });

  const sourceDir = resolvedLocation.subdir
    ? join(tmpDir, resolvedLocation.subdir)
    : tmpDir;
  return { tmpDir, sourceDir };
}

function assertDirectSkillFileSize(
  receivedBytes: number,
  maxBytes: number,
): void {
  if (receivedBytes > maxBytes) {
    throw new Error(`Direct skill file exceeds ${maxBytes} byte limit.`);
  }
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength)) {
      assertDirectSkillFileSize(parsedLength, maxBytes);
    }
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    assertDirectSkillFileSize(body.byteLength, maxBytes);
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        assertDirectSkillFileSize(receivedBytes, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(
    await readResponseBytesWithLimit(response, maxBytes),
  );
}

export async function downloadDirectSkillFileSource(
  location: DirectSkillFileSourceLocation,
  options: { fetchImpl?: FetchSkillFile } = {},
): Promise<{ tmpDir: string; sourceDir: string }> {
  const response = await (options.fetchImpl ?? fetch)(location.url);
  if (!response.ok) {
    throw new Error(
      `Direct skill file download failed for ${location.url}: ${response.status}`,
    );
  }

  const skillText = await readResponseTextWithLimit(
    response,
    MAX_DIRECT_SKILL_FILE_BYTES,
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-direct-skill-"));
  try {
    const sourceDir = join(tmpDir, "skill");
    await mkdir(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), skillText, "utf8");
    return { tmpDir, sourceDir };
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.json();
}

async function resolveClawHubVersion(
  location: ClawHubSourceLocation,
): Promise<string> {
  if (location.version) return location.version;

  const skillData = await fetchJson(
    `${CLAWHUB_API_BASE_URL}/skills/${encodeURIComponent(location.slug)}`,
  );
  if (!skillData || typeof skillData !== "object") {
    throw new Error(`ClawHub skill not found: ${location.slug}`);
  }

  const data = skillData as {
    latestVersion?: { version?: unknown };
    skill?: { latestVersion?: { version?: unknown }; tags?: unknown };
    tags?: unknown;
  };
  const latestVersion = data.latestVersion ?? data.skill?.latestVersion;
  if (typeof latestVersion?.version === "string" && latestVersion.version) {
    return latestVersion.version;
  }

  const tags = data.skill?.tags ?? data.tags;
  if (
    tags &&
    typeof tags === "object" &&
    typeof (tags as { latest?: unknown }).latest === "string"
  ) {
    return (tags as { latest: string }).latest;
  }

  throw new Error(
    `Could not resolve latest ClawHub version for ${location.slug}`,
  );
}

function assertSafeZipMember(name: string): void {
  const normalized = name.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.length === 0 ||
    parts.some((part) => part === "..") ||
    /^[A-Za-z]:$/.test(parts[0] ?? "")
  ) {
    throw new Error(`Unsafe path in ClawHub ZIP: ${name}`);
  }
}

async function downloadClawHubSkillSource(
  location: ClawHubSourceLocation,
): Promise<{ tmpDir: string; sourceDir: string }> {
  const version = await resolveClawHubVersion(location);
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-clawhub-skill-"));
  const zipPath = join(tmpDir, "skill.zip");
  const sourceDir = join(tmpDir, "skill");
  await mkdir(sourceDir, { recursive: true });

  const url = new URL(`${CLAWHUB_API_BASE_URL}/download`);
  url.searchParams.set("slug", location.slug);
  url.searchParams.set("version", version);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `ClawHub download failed for ${location.slug}@${version}: ${response.status}`,
    );
  }
  writeFileSync(
    zipPath,
    await readResponseBytesWithLimit(response, MAX_SKILL_BUNDLE_BYTES),
  );

  const { stdout } = await execFile("unzip", ["-Z1", zipPath], {
    timeout: 30_000,
  });
  const members = stdout.split("\n").filter(Boolean);
  if (members.length === 0) {
    throw new Error(
      `ClawHub download was empty for ${location.slug}@${version}`,
    );
  }
  members.forEach(assertSafeZipMember);

  const { stdout: detailedListing } = await execFile(
    "unzip",
    ["-Z", "-l", zipPath],
    { timeout: 30_000 },
  );
  const entries = detailedListing
    .split("\n")
    .filter((line) => /^[dl-][rwx-]{9}\s/.test(line));
  if (entries.length > MAX_SKILL_BUNDLE_FILES) {
    throw new Error(
      `ClawHub skill exceeds ${MAX_SKILL_BUNDLE_FILES} file limit.`,
    );
  }
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const fields = entry.trim().split(/\s+/);
    if (fields[0]?.startsWith("l")) {
      throw new Error("ClawHub skill ZIP cannot contain symlinks.");
    }
    uncompressedBytes += Number(fields[3] ?? 0);
  }
  if (uncompressedBytes > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error(
      `ClawHub skill exceeds ${MAX_SKILL_BUNDLE_BYTES} uncompressed byte limit.`,
    );
  }

  await execFile("unzip", ["-q", zipPath, "-d", sourceDir], {
    timeout: 30_000,
  });

  return { tmpDir, sourceDir };
}

function assertInside(parent: string, child: string): void {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  if (
    childPath !== parentPath &&
    !childPath.startsWith(`${parentPath}${sep}`)
  ) {
    throw new Error(`Resolved path is outside target directory: ${child}`);
  }
}

function sanitizeSkillName(name: string): string {
  const trimmed = name.trim();
  if (
    !/^[A-Za-z0-9._-]+$/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new Error(`Invalid skill name "${name}".`);
  }
  return trimmed;
}

export function assertSafeSkillDirectory(sourceDir: string): void {
  const root = resolve(sourceDir);
  const pending = [root];
  let fileCount = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill directories cannot contain symlinks: ${path}`);
      }
      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Unsupported file type in skill directory: ${path}`);
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_SKILL_BUNDLE_FILES) {
        throw new Error(
          `Skill directory exceeds ${MAX_SKILL_BUNDLE_FILES} file limit.`,
        );
      }
      if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
        throw new Error(
          `Skill directory exceeds ${MAX_SKILL_BUNDLE_BYTES} byte limit.`,
        );
      }
    }
  }

  const skillMdPath = join(root, "SKILL.md");
  const skillMdStat = lstatSync(skillMdPath);
  if (!skillMdStat.isFile() || skillMdStat.size > MAX_DIRECT_SKILL_FILE_BYTES) {
    throw new Error(
      `SKILL.md must be a regular file at or below ${MAX_DIRECT_SKILL_FILE_BYTES} bytes.`,
    );
  }
}

function normalizeFrontmatterString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed.trim() : trimmed;
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'").trim();
  }
  return trimmed || undefined;
}

function getSkillName(sourceDir: string): string {
  const skillMd = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  const { frontmatter } = parseFrontmatter(skillMd);
  const name =
    normalizeFrontmatterString(frontmatter.name) ?? basename(sourceDir);
  return sanitizeSkillName(name);
}

export function previewSkillDirectory(sourceDir: string): SkillPreview {
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error("No SKILL.md found in the skill directory.");
  }
  assertSafeSkillDirectory(sourceDir);

  const skillMd = readFileSync(skillMdPath, "utf8");
  const { frontmatter } = parseFrontmatter(skillMd);
  const description = normalizeFrontmatterString(frontmatter.description);
  return {
    name: getSkillName(sourceDir),
    ...(description ? { description } : {}),
    skillMd,
  };
}

export async function installSkillDirectory(params: {
  sourceDir: string;
  memoryDir: string;
  force?: boolean;
}): Promise<{ name: string; path: string }> {
  const sourceDir = resolve(params.sourceDir);
  const memoryDir = resolve(params.memoryDir);
  const skillMdPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error("No SKILL.md found in the skill directory.");
  }
  if (!statSync(sourceDir).isDirectory()) {
    throw new Error(`Skill source is not a directory: ${sourceDir}`);
  }
  assertSafeSkillDirectory(sourceDir);

  const name = getSkillName(sourceDir);
  const skillsDir = join(memoryDir, "skills");
  const targetPath = join(skillsDir, name);
  assertInside(skillsDir, targetPath);

  if (existsSync(targetPath)) {
    if (!params.force) {
      throw new Error(
        `Skill "${name}" already exists at ${targetPath}. Re-run with --force to replace it.`,
      );
    }
    rmSync(targetPath, { recursive: true, force: true });
  }

  await mkdir(skillsDir, { recursive: true });
  cpSync(sourceDir, targetPath, {
    recursive: true,
    filter: (source) => basename(source) !== ".git",
  });
  return { name, path: normalize(targetPath) };
}

export async function listSkillDirectories(params: {
  memoryDir: string;
}): Promise<SkillListItem[]> {
  const memoryDir = resolve(params.memoryDir);
  const skillsDir = join(memoryDir, "skills");
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillListItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    let name = entry.name;
    let description: string | undefined;
    try {
      const skillMd = readFileSync(skillMdPath, "utf8");
      const { frontmatter } = parseFrontmatter(skillMd);
      name = normalizeFrontmatterString(frontmatter.name) ?? name;
      description = normalizeFrontmatterString(frontmatter.description);
    } catch {
      // Keep listing valid skill directories even if their frontmatter is malformed.
    }

    skills.push({ name, path: normalize(skillDir), description });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteSkillDirectory(params: {
  memoryDir: string;
  name: string;
}): Promise<{ name: string; path: string }> {
  const memoryDir = resolve(params.memoryDir);
  const skillsDir = join(memoryDir, "skills");
  const name = sanitizeSkillName(params.name);
  const targetPath = join(skillsDir, name);
  assertInside(skillsDir, targetPath);

  if (!existsSync(targetPath)) {
    throw new Error(`Skill "${name}" is not installed at ${targetPath}.`);
  }
  if (!statSync(targetPath).isDirectory()) {
    throw new Error(`Skill path is not a directory: ${targetPath}`);
  }

  rmSync(targetPath, { recursive: true, force: true });
  return { name, path: normalize(targetPath) };
}

async function loadSkillMemorySyncFn(): Promise<SkillMemorySyncFn> {
  const { syncPendingMemoryCommitsAfterTurn } = await import(
    "@/agent/memory-git"
  );
  return syncPendingMemoryCommitsAfterTurn;
}

export async function syncCommittedRemoteSkillMemoryChange(params: {
  agentId: string;
  memoryDir: string;
  committed: boolean;
  syncFn?: SkillMemorySyncFn;
}): Promise<SkillMemorySyncResult | undefined> {
  if (!params.committed || isLocalAgentId(params.agentId)) {
    return undefined;
  }

  try {
    const syncFn = params.syncFn ?? (await loadSkillMemorySyncFn());
    const result = await syncFn(params.agentId, {
      memoryDir: params.memoryDir,
    });
    return { status: result.status, summary: result.summary };
  } catch (error) {
    return {
      status: "push_failed",
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installSkill(
  specifier: string,
  agentId: string,
  force: boolean,
): Promise<InstallResult> {
  const source = resolveSkillSourceSpecifier(specifier);
  if (!source) {
    throw new Error(`Unsupported skill source: ${specifier}`);
  }

  let tmpDir: string | null = null;
  try {
    let downloaded: { tmpDir: string; sourceDir: string };
    if (source.type === "git") {
      downloaded = await cloneSkillSource(source.location);
    } else if (source.type === "direct-file") {
      downloaded = await downloadDirectSkillFileSource(source.location);
    } else {
      downloaded = await downloadClawHubSkillSource(source.location);
    }
    tmpDir = downloaded.tmpDir;
    const sourceDir = resolve(downloaded.sourceDir);
    assertInside(tmpDir, sourceDir);
    if (!existsSync(sourceDir)) {
      const missingPath =
        source.type === "git"
          ? (source.location.subdir ?? ".")
          : source.type === "direct-file"
            ? source.location.url
            : source.location.slug;
      throw new Error(`Skill path not found: ${missingPath}`);
    }
    return installSkillFromDirectory({
      sourceDir,
      agentId,
      source: specifier,
      force,
    });
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function installSkillFromDirectory(params: {
  sourceDir: string;
  agentId: string;
  source: string;
  force?: boolean;
}): Promise<InstallResult> {
  const memoryDir = await getAgentMemoryDir(params.agentId);
  const result = await installSkillDirectory({
    sourceDir: params.sourceDir,
    memoryDir,
    force: params.force,
  });
  const commit = await commitSkillMemoryChange({
    agentId: params.agentId,
    memoryDir,
    skillName: result.name,
    reason: `chore(skills): install ${result.name}`,
  });
  return {
    agentId: params.agentId,
    source: params.source,
    ...result,
    committed: commit.committed,
    commitSha: commit.sha,
    memorySync: commit.memorySync,
  };
}

async function getAgentMemoryDir(agentId: string): Promise<string> {
  if (isLocalAgentId(agentId)) {
    const { getLocalBackendMemoryFilesystemRoot } = await import(
      "@/backend/local/paths"
    );
    const { initializeLocalMemoryRepo } = await import("@/agent/memory-git");
    const memoryDir = getLocalBackendMemoryFilesystemRoot(agentId);
    await initializeLocalMemoryRepo({ memoryDir, agentId, files: [] });
    return memoryDir;
  }

  const { ensureLocalMemfsCheckout, getScopedMemoryFilesystemRoot } =
    await import("@/agent/memory-filesystem");
  await ensureLocalMemfsCheckout(agentId);
  return getScopedMemoryFilesystemRoot(agentId);
}

async function commitSkillMemoryChange(params: {
  agentId: string;
  memoryDir: string;
  skillName: string;
  reason: string;
}): Promise<{
  committed: boolean;
  sha?: string;
  memorySync?: SkillMemorySyncResult;
}> {
  const { commitMemoryWrite } = await import("@/agent/memory-git");
  const { getBackend } = await import("@/backend");

  let authorName = "Letta Code";
  try {
    const agent = await getBackend().retrieveAgent(params.agentId);
    if (agent.name?.trim()) {
      authorName = agent.name.trim();
    }
  } catch {
    // Best effort only; committing should not depend on fetching display name.
  }

  const result = await commitMemoryWrite({
    memoryDir: params.memoryDir,
    pathspecs: [`skills/${params.skillName}`],
    reason: params.reason,
    author: {
      agentId: params.agentId,
      authorName,
      authorEmail: `${params.agentId}@letta.com`,
    },
    syncMode: isLocalAgentId(params.agentId) ? "local" : "remote",
  });
  const memorySync = await syncCommittedRemoteSkillMemoryChange({
    agentId: params.agentId,
    memoryDir: params.memoryDir,
    committed: result.committed,
  });

  return { committed: result.committed, sha: result.sha, memorySync };
}

export async function listSkills(agentId: string): Promise<{
  agentId: string;
  skills: SkillListItem[];
}> {
  const memoryDir = await getAgentMemoryDir(agentId);
  const skills = await listSkillDirectories({ memoryDir });
  return { agentId, skills };
}

export async function deleteSkill(
  skillName: string,
  agentId: string,
): Promise<DeleteResult> {
  const memoryDir = await getAgentMemoryDir(agentId);
  const result = await deleteSkillDirectory({ memoryDir, name: skillName });
  const commit = await commitSkillMemoryChange({
    agentId,
    memoryDir,
    skillName: result.name,
    reason: `chore(skills): delete ${result.name}`,
  });
  return {
    agentId,
    deleted: true,
    ...result,
    committed: commit.committed,
    commitSha: commit.sha,
    memorySync: commit.memorySync,
  };
}
