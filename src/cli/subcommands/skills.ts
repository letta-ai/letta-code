import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { parseArgs, TextDecoder, TextEncoder } from "node:util";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { isLocalAgentId } from "@/agent/agent-id";
import {
  type InstallLocalManagedModPackageResult,
  installGitManagedModPackage,
  installLocalManagedModPackage,
  installNpmManagedModPackage,
  isLocalLettaModPackageDirectory,
  parseGitManagedModPackageInstallSpecifier,
} from "@/mods/package-installer";
import { resolveDefaultGlobalModsDirectory } from "@/mods/paths";
import { parseFrontmatter } from "@/utils/frontmatter";

const HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const HERMES_OPTIONAL_SKILLS_DIR = "optional-skills";
export const MAX_DIRECT_SKILL_FILE_BYTES = 1024 * 1024;

interface SkillSourceLocation {
  repoUrl: string;
  branch: string | null;
  subdir: string | null;
}

interface DirectSkillFileSourceLocation {
  url: string;
}

interface InstallResult {
  agentId: string;
  name: string;
  path: string;
  source: string;
  committed?: boolean;
  commitSha?: string;
}

interface SkillListItem {
  name: string;
  path: string;
  description?: string;
}

interface DeleteResult {
  agentId: string;
  name: string;
  path: string;
  deleted: true;
  committed?: boolean;
  commitSha?: string;
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

interface RunInstallOptions {
  globalModsDirectory?: string;
}

const CLAWHUB_API_BASE_URL = "https://clawhub.ai/api/v1";

let activeAgentPromptStatus: { stop: () => void } | null = null;

function printUsage(): void {
  console.log(
    `
Usage:
  letta install <thing> [--agent <id> | -n <agent name>] [--force]
  letta skills list [--agent <id> | -n <agent name>]
  letta skills delete <skill_name> --agent <id>

Sources:
  npm:<package>         npm mod package, e.g. npm:@letta-ai/mod-plan-mode
  git:github.com/o/r    GitHub mod package
  https://github.com/o/r GitHub mod package
  ./path/to/package     Local mod package with package.json#letta
  official/<path>         Hermes official optional skill, e.g. official/finance/stocks
  clawhub/<slug>          ClawHub registry skill, e.g. clawhub/nano-banana-pro
  clawhub:<slug>          ClawHub registry skill, optionally <slug>@<version>
  https://github.com/...  GitHub repository, tree URL, or SKILL.md blob URL
  https://.../SKILL.md    Direct external skill file URL
  owner/repo/path         GitHub repo/path shorthand

Options:
  --agent <id>            Install into this agent's memfs repository
  --agent-id <id>         Alias for --agent
  -n, --name <name>       Install into the agent with this exact name
  --force                 Replace an existing skill with the same name
`.trim(),
  );
}

const SKILLS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  "agent-id": { type: "string" },
  name: { type: "string", short: "n" },
  force: { type: "boolean" },
} as const;

function parseSkillsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: SKILLS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function isAgentId(value: string): boolean {
  return value.startsWith("agent-") || value.startsWith("agent_");
}

function getExplicitAgentId(
  values: ReturnType<typeof parseSkillsArgs>["values"],
): string | null {
  const explicitAgent = values.agent || values["agent-id"];
  return typeof explicitAgent === "string" && explicitAgent.trim()
    ? explicitAgent.trim()
    : null;
}

function paginatedItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  const items = (page as { items?: unknown }).items;
  return Array.isArray(items) ? (items as T[]) : [];
}

async function findAgentsByName(name: string): Promise<AgentState[]> {
  const { getBackend } = await import("@/backend");
  const backend = getBackend();
  const page = await backend.listAgents({
    query_text: name,
    limit: 100,
  } as never);
  const normalizedName = name.toLowerCase();
  return paginatedItems<AgentState>(page).filter(
    (agent) => agent.name?.toLowerCase() === normalizedName,
  );
}

async function resolveAgentByName(name: string): Promise<string> {
  const matches = await findAgentsByName(name);
  if (matches.length === 0) {
    throw new Error(`No agent found with name "${name}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple agents found with name "${name}". Pass --agent with an agent id instead.`,
    );
  }
  const id = matches[0]?.id;
  if (!id) throw new Error(`Agent "${name}" did not include an id.`);
  return id;
}

async function promptForAgent(statusMessage: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing agent id. Pass --agent <id> or -n <agent name>.");
  }

  const { Box, render } = await import("ink");
  const Spinner = (await import("ink-spinner")).default;
  const React = await import("react");
  const { AgentSelector } = await import("@/cli/components/AgentSelector");
  const { Text } = await import("@/cli/components/Text");

  return new Promise<string>((resolveAgent, rejectAgent) => {
    let settled = false;
    const statusView = React.createElement(
      Box,
      { paddingX: 1, paddingY: 1 },
      React.createElement(
        Text,
        null,
        React.createElement(Spinner, { type: "dots" }),
        ` ${statusMessage}`,
      ),
    );
    const instance = render(
      React.createElement(AgentSelector, {
        currentAgentId:
          process.env.LETTA_AGENT_ID || process.env.AGENT_ID || "",
        command: "letta skills",
        title: "Select an agent",
        showNewTab: false,
        allowDelete: false,
        allowPinActions: false,
        onSelect: (agentId: string) => {
          if (settled) return;
          settled = true;
          instance.rerender(statusView);
          activeAgentPromptStatus = {
            stop: () => {
              instance.unmount();
              instance.clear?.();
              if (activeAgentPromptStatus?.stop) {
                activeAgentPromptStatus = null;
              }
            },
          };
          setTimeout(() => resolveAgent(agentId), 0);
        },
        onCancel: () => {
          if (settled) return;
          settled = true;
          instance.unmount();
          instance.clear?.();
          rejectAgent(new Error("Agent selection cancelled."));
        },
      }),
    );
  });
}

async function resolveAgentId(
  values: ReturnType<typeof parseSkillsArgs>["values"],
  promptStatusMessage = "Working...",
): Promise<string> {
  const explicitAgent = getExplicitAgentId(values);
  if (explicitAgent) return explicitAgent;

  if (typeof values.name === "string" && values.name.trim()) {
    const nameOrId = values.name.trim();
    if (isAgentId(nameOrId)) return nameOrId;
    return resolveAgentByName(nameOrId);
  }

  const envAgent = process.env.LETTA_AGENT_ID || process.env.AGENT_ID;
  if (envAgent?.trim()) return envAgent.trim();

  return promptForAgent(promptStatusMessage);
}

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

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength)) {
      assertDirectSkillFileSize(parsedLength, maxBytes);
    }
  }

  if (!response.body) {
    const text = await response.text();
    assertDirectSkillFileSize(
      new TextEncoder().encode(text).byteLength,
      maxBytes,
    );
    return text;
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
  return new TextDecoder().decode(body);
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
  writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

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

function getSkillName(sourceDir: string): string {
  const skillMd = readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  const { frontmatter } = parseFrontmatter(skillMd);
  const frontmatterName = frontmatter.name;
  const name =
    typeof frontmatterName === "string" && frontmatterName.trim()
      ? frontmatterName
      : basename(sourceDir);
  return sanitizeSkillName(name);
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
      if (typeof frontmatter.name === "string" && frontmatter.name.trim()) {
        name = frontmatter.name.trim();
      }
      if (
        typeof frontmatter.description === "string" &&
        frontmatter.description.trim()
      ) {
        description = frontmatter.description.trim();
      }
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

async function installSkill(
  specifier: string,
  agentId: string,
  force: boolean,
): Promise<InstallResult> {
  const source = resolveSkillSourceSpecifier(specifier);
  if (!source) {
    throw new Error(`Unsupported skill source: ${specifier}`);
  }

  const memoryDir = await getAgentMemoryDir(agentId);
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
    const result = await installSkillDirectory({ sourceDir, memoryDir, force });
    const commit = await commitSkillMemoryChange({
      agentId,
      memoryDir,
      skillName: result.name,
      reason: `chore(skills): install ${result.name}`,
    });
    return {
      agentId,
      source: specifier,
      ...result,
      committed: commit.committed,
      commitSha: commit.sha,
    };
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
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
}): Promise<{ committed: boolean; sha?: string }> {
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

  return { committed: result.committed, sha: result.sha };
}

async function listSkills(agentId: string): Promise<{
  agentId: string;
  skills: SkillListItem[];
}> {
  const memoryDir = await getAgentMemoryDir(agentId);
  const skills = await listSkillDirectories({ memoryDir });
  return { agentId, skills };
}

async function deleteSkill(
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
  };
}

async function initializeAndResolveAgent(
  values: ReturnType<typeof parseSkillsArgs>["values"],
  promptStatusMessage?: string,
): Promise<string> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
  return resolveAgentId(values, promptStatusMessage);
}

function stopAgentPromptStatus(): void {
  activeAgentPromptStatus?.stop();
  activeAgentPromptStatus = null;
}

function hasInstallAgentScope(
  values: ReturnType<typeof parseSkillsArgs>["values"],
): boolean {
  return Boolean(values.agent || values["agent-id"] || values.name);
}

function printManagedModPackageInstallResult(
  result: InstallLocalManagedModPackageResult,
  options: { includeDetails?: boolean } = {},
): void {
  console.log(
    "Warning: mods are trusted local code and can execute on startup.",
  );
  if (options.includeDetails) {
    console.log(`Source: ${result.source}`);
    if (result.repository) {
      console.log(`Repository: ${result.repository}`);
    }
    if (result.capabilities.length > 0) {
      console.log(`Capabilities: ${result.capabilities.join(", ")}`);
    }
  }
  console.log(`Installed ${result.source}@${result.version}`);
  console.log("Run /reload in active sessions for changes to take effect.");
}

async function runInstall(
  argv: string[],
  options: RunInstallOptions = {},
): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  const [specifier] = parsed.positionals;
  if (parsed.values.help || !specifier || specifier === "help") {
    printUsage();
    return 0;
  }

  if (parsed.positionals.length > 1) {
    console.error(`Unexpected argument: ${parsed.positionals[1]}`);
    printUsage();
    return 1;
  }

  if (specifier.startsWith("npm:")) {
    if (hasInstallAgentScope(parsed.values)) {
      console.error("Agent-scoped mod package install is not supported yet.");
      return 1;
    }
    if (parsed.values.force) {
      console.error("--force is only supported for skill installs.");
      return 1;
    }
    try {
      const result = await installNpmManagedModPackage({
        modsRoot:
          options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory(),
        specifier,
      });
      printManagedModPackageInstallResult(result, { includeDetails: true });
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  let gitPackageSpecifier: ReturnType<
    typeof parseGitManagedModPackageInstallSpecifier
  >;
  try {
    gitPackageSpecifier = parseGitManagedModPackageInstallSpecifier(specifier);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (gitPackageSpecifier) {
    if (hasInstallAgentScope(parsed.values)) {
      console.error("Agent-scoped mod package install is not supported yet.");
      return 1;
    }
    if (parsed.values.force) {
      console.error("--force is only supported for skill installs.");
      return 1;
    }
    try {
      const result = await installGitManagedModPackage({
        modsRoot:
          options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory(),
        specifier,
      });
      printManagedModPackageInstallResult(result, { includeDetails: true });
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const maybeLocalPath = resolve(specifier);
  if (isLocalLettaModPackageDirectory(maybeLocalPath)) {
    if (hasInstallAgentScope(parsed.values)) {
      console.error("Agent-scoped mod package install is not supported yet.");
      return 1;
    }
    try {
      const result = installLocalManagedModPackage({
        modsRoot:
          options.globalModsDirectory ?? resolveDefaultGlobalModsDirectory(),
        packageDirectory: maybeLocalPath,
      });
      printManagedModPackageInstallResult(result);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const agentId = await initializeAndResolveAgent(
      parsed.values,
      `Installing ${specifier}...`,
    );
    const result = await installSkill(
      specifier,
      agentId,
      Boolean(parsed.values.force),
    );
    stopAgentPromptStatus();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stopAgentPromptStatus();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runInstallSubcommand(
  argv: string[],
  options: RunInstallOptions = {},
): Promise<number> {
  return runInstall(argv, options);
}

async function runList(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  if (parsed.values.help) {
    printUsage();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(`Unexpected argument: ${parsed.positionals[0]}`);
    printUsage();
    return 1;
  }

  try {
    const agentId = await initializeAndResolveAgent(
      parsed.values,
      "Loading skills...",
    );
    const result = await listSkills(agentId);
    stopAgentPromptStatus();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stopAgentPromptStatus();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runDelete(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseSkillsArgs>;
  try {
    parsed = parseSkillsArgs(argv);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    return 1;
  }

  const [skillName] = parsed.positionals;
  if (parsed.values.help || !skillName || skillName === "help") {
    printUsage();
    return 0;
  }
  if (parsed.positionals.length > 1) {
    console.error(`Unexpected argument: ${parsed.positionals[1]}`);
    printUsage();
    return 1;
  }

  const agentId = getExplicitAgentId(parsed.values);
  if (!agentId) {
    console.error(
      "Deleting a skill requires an explicit agent id. Re-run with --agent <id> or --agent-id <id>.",
    );
    return 1;
  }

  if (skillName.includes("/")) {
    console.error(
      `Invalid installed skill name "${skillName}". Delete expects the installed directory name, e.g. "meme-generation", not a source specifier like "official/creative/meme-generation".`,
    );
    return 1;
  }

  try {
    const { settingsManager } = await import("@/settings-manager");
    await settingsManager.initialize();
    const result = await deleteSkill(skillName, agentId);
    stopAgentPromptStatus();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stopAgentPromptStatus();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runSkillsSubcommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case "install":
      return runInstall(rest);
    case "list":
      return runList(rest);
    case "delete":
    case "remove":
    case "rm":
      return runDelete(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return 0;
    default:
      console.error(`Unknown action: ${action}`);
      printUsage();
      return 1;
  }
}
