import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type InstallResult,
  installSkill,
  installSkillFromDirectory,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_BUNDLE_FILES,
  previewSkillDirectory,
  type SkillPreview,
} from "@/agent/skill-installer";

const execFile = promisify(execFileCallback);
const HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const CLAWHUB_API_BASE_URL = "https://clawhub.ai/api/v1";

const GITHUB_CATALOG_SOURCES = new Set([
  "anthropic",
  "github",
  "huggingface",
  "nvidia",
  "openai",
  "gstack",
  "claude-marketplace",
]);

export interface CatalogSkillReference {
  source: string;
  name: string;
  identifier?: string;
}

export interface CatalogSkillPreview extends SkillPreview {
  source: string;
  sourceUrl?: string;
}

interface DownloadedCatalogSkill {
  tmpDir: string;
  sourceDir: string;
  sourceLabel: string;
  sourceUrl?: string;
}

interface GitCatalogLocation {
  repoUrl: string;
  requestedPath?: string;
  searchName?: string;
  searchRoot?: string;
}

function validateCatalogReference(reference: CatalogSkillReference): void {
  if (!reference.name.trim() || reference.name.length > 256) {
    throw new Error("Catalog skill name is invalid.");
  }
  if (!reference.source.trim() || reference.source.length > 64) {
    throw new Error("Catalog skill source is invalid.");
  }
  if (reference.identifier && reference.identifier.length > 2048) {
    throw new Error("Catalog skill identifier is invalid.");
  }
}

function parseGitHubIdentifier(identifier: string): GitCatalogLocation | null {
  const parts = identifier.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...pathParts] = parts;
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  if (pathParts.some((part) => part === "." || part === "..")) return null;
  return {
    repoUrl: `https://github.com/${owner}/${repo}.git`,
    ...(pathParts.length > 0 ? { requestedPath: pathParts.join("/") } : {}),
  };
}

export function resolveGitCatalogLocation(
  reference: CatalogSkillReference,
): GitCatalogLocation | null {
  const source = reference.source.toLowerCase();
  if (source === "built-in") {
    return {
      repoUrl: HERMES_REPO_URL,
      searchName: reference.name,
      searchRoot: "skills",
    };
  }
  if (source === "optional" || source === "official") {
    return {
      repoUrl: HERMES_REPO_URL,
      searchName: reference.name,
      searchRoot: "optional-skills",
    };
  }
  if (source === "skills.sh") {
    const identifier = reference.identifier?.replace(/^skills-sh\//, "") ?? "";
    const location = parseGitHubIdentifier(identifier);
    if (!location) return null;
    return { ...location, searchName: reference.name };
  }
  if (source === "browse.sh" || source === "browse-sh") return null;
  if (GITHUB_CATALOG_SOURCES.has(source)) {
    const location = parseGitHubIdentifier(reference.identifier ?? "");
    if (!location) return null;
    return {
      ...location,
      ...(!location.requestedPath ? { searchName: reference.name } : {}),
    };
  }
  return null;
}

function candidateRank(path: string, requestedPath?: string): number {
  const skillDir = dirname(path);
  if (requestedPath && skillDir === requestedPath) return 0;
  if (requestedPath && skillDir.endsWith(`/${requestedPath}`)) return 1;
  if (skillDir.startsWith("skills/")) return 2;
  if (skillDir.startsWith(".agents/skills/")) return 3;
  if (skillDir.startsWith(".claude/skills/")) return 4;
  return 5 + skillDir.split("/").length;
}

export function findCatalogSkillPath(
  treePaths: string[],
  location: GitCatalogLocation,
): string {
  const requestedPath = location.requestedPath?.replace(/^\/+|\/+$/g, "");
  const searchName = location.searchName?.trim();
  const searchRoot = location.searchRoot?.replace(/^\/+|\/+$/g, "");
  const candidates = treePaths.filter((path) => {
    if (basename(path).toLowerCase() !== "skill.md") return false;
    if (
      searchRoot &&
      path !== searchRoot &&
      !path.startsWith(`${searchRoot}/`)
    ) {
      return false;
    }
    if (requestedPath) {
      const skillDir = dirname(path);
      return (
        skillDir === requestedPath || skillDir.endsWith(`/${requestedPath}`)
      );
    }
    return Boolean(searchName && basename(dirname(path)) === searchName);
  });

  candidates.sort(
    (left, right) =>
      candidateRank(left, requestedPath) -
        candidateRank(right, requestedPath) || left.localeCompare(right),
  );
  const selected = candidates[0];
  if (!selected) {
    throw new Error(
      `Could not find SKILL.md for ${searchName ?? requestedPath}.`,
    );
  }
  return dirname(selected);
}

function assertGitSkillTreeWithinLimits(output: string): void {
  let fileCount = 0;
  let totalBytes = 0;
  for (const line of output.split("\n").filter(Boolean)) {
    const match = /^(\d+)\s+blob\s+[0-9a-f]+\s+(\d+)\t/.exec(line);
    if (!match) continue;
    if (match[1] === "120000") {
      throw new Error("Catalog skill directories cannot contain symlinks.");
    }
    fileCount += 1;
    totalBytes += Number(match[2]);
  }
  if (fileCount > MAX_SKILL_BUNDLE_FILES) {
    throw new Error(
      `Catalog skill exceeds ${MAX_SKILL_BUNDLE_FILES} file limit.`,
    );
  }
  if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error(
      `Catalog skill exceeds ${MAX_SKILL_BUNDLE_BYTES} byte limit.`,
    );
  }
}

async function cloneCatalogGitSkill(
  location: GitCatalogLocation,
): Promise<DownloadedCatalogSkill> {
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-catalog-skill-"));
  const repoDir = join(tmpDir, "repo");
  try {
    await execFile(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--no-checkout",
        location.repoUrl,
        repoDir,
      ],
      { timeout: 120_000 },
    );
    const { stdout } = await execFile(
      "git",
      ["-C", repoDir, "ls-tree", "-r", "--name-only", "HEAD"],
      { timeout: 30_000 },
    );
    const skillPath = findCatalogSkillPath(
      stdout.split("\n").filter(Boolean),
      location,
    );
    const tree = await execFile(
      "git",
      ["-C", repoDir, "ls-tree", "-rl", "HEAD", "--", skillPath],
      { timeout: 30_000 },
    );
    assertGitSkillTreeWithinLimits(tree.stdout);
    await execFile(
      "git",
      ["-C", repoDir, "sparse-checkout", "set", "--no-cone", skillPath],
      { timeout: 30_000 },
    );
    await execFile("git", ["-C", repoDir, "checkout"], { timeout: 60_000 });
    const sourceDir = join(repoDir, skillPath);
    if (!existsSync(join(sourceDir, "SKILL.md"))) {
      throw new Error(`Catalog skill did not contain SKILL.md: ${skillPath}`);
    }
    return {
      tmpDir,
      sourceDir,
      sourceLabel: location.repoUrl,
      sourceUrl: location.repoUrl.replace(/\.git$/, ""),
    };
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

async function createSingleFileSkill(params: {
  name: string;
  content: string;
  sourceLabel: string;
  sourceUrl?: string;
}): Promise<DownloadedCatalogSkill> {
  const tmpDir = mkdtempSync(join(tmpdir(), "letta-catalog-skill-"));
  const sourceDir = join(tmpDir, "skill");
  await mkdir(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "SKILL.md"), params.content, "utf8");
  return {
    tmpDir,
    sourceDir,
    sourceLabel: params.sourceLabel,
    sourceUrl: params.sourceUrl,
  };
}

async function downloadClawHubPreview(
  reference: CatalogSkillReference,
): Promise<DownloadedCatalogSkill> {
  const slug = reference.identifier ?? reference.name;
  const response = await fetch(
    `${CLAWHUB_API_BASE_URL}/skills/${encodeURIComponent(slug)}`,
  );
  if (!response.ok) {
    throw new Error(`ClawHub skill lookup failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    skill?: { description?: unknown; slug?: unknown };
  };
  if (typeof payload.skill?.description !== "string") {
    throw new Error("ClawHub skill did not include SKILL.md content.");
  }
  const resolvedSlug =
    typeof payload.skill.slug === "string" ? payload.skill.slug : slug;
  return createSingleFileSkill({
    name: resolvedSlug,
    content: payload.skill.description,
    sourceLabel: `clawhub/${resolvedSlug}`,
    sourceUrl: `https://clawhub.ai/skills/${encodeURIComponent(resolvedSlug)}`,
  });
}

function yamlString(value: unknown): string {
  return JSON.stringify(typeof value === "string" ? value : "");
}

async function downloadLobeHubSkill(
  reference: CatalogSkillReference,
): Promise<DownloadedCatalogSkill> {
  const identifier = (reference.identifier ?? reference.name).replace(
    /^lobehub\//,
    "",
  );
  const response = await fetch(
    `https://chat-agents.lobehub.com/${encodeURIComponent(identifier)}.json`,
  );
  if (!response.ok) {
    throw new Error(`LobeHub skill lookup failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    identifier?: unknown;
    meta?: {
      title?: unknown;
      description?: unknown;
      tags?: unknown;
    };
    config?: { systemRole?: unknown };
  };
  const name =
    typeof payload.identifier === "string" ? payload.identifier : identifier;
  const title =
    typeof payload.meta?.title === "string" ? payload.meta.title : name;
  const description =
    typeof payload.meta?.description === "string"
      ? payload.meta.description
      : "";
  const tags = Array.isArray(payload.meta?.tags)
    ? payload.meta.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const instructions =
    typeof payload.config?.systemRole === "string"
      ? payload.config.systemRole
      : "(No instructions defined)";
  const content = [
    "---",
    `name: ${name}`,
    `description: ${yamlString(description.slice(0, 500))}`,
    "metadata:",
    "  lobehub:",
    "    source: lobehub",
    `    tags: ${JSON.stringify(tags)}`,
    "---",
    "",
    `# ${title}`,
    "",
    description,
    "",
    "## Instructions",
    "",
    instructions,
    "",
  ].join("\n");
  return createSingleFileSkill({
    name,
    content,
    sourceLabel: `lobehub/${identifier}`,
    sourceUrl: `https://lobehub.com/agent/${encodeURIComponent(identifier)}`,
  });
}

async function downloadBrowseShSkill(
  reference: CatalogSkillReference,
): Promise<DownloadedCatalogSkill> {
  const slug = (reference.identifier ?? reference.name).replace(
    /^browse-sh\//,
    "",
  );
  const detailResponse = await fetch(`https://browse.sh/api/skills/${slug}`);
  if (!detailResponse.ok) {
    throw new Error(`browse.sh skill lookup failed: ${detailResponse.status}`);
  }
  const detail = (await detailResponse.json()) as {
    skillMdUrl?: unknown;
    sourceUrl?: unknown;
  };
  if (
    typeof detail.skillMdUrl !== "string" ||
    !detail.skillMdUrl.startsWith("https://")
  ) {
    throw new Error("browse.sh skill did not include a SKILL.md URL.");
  }
  const skillResponse = await fetch(detail.skillMdUrl);
  if (!skillResponse.ok) {
    throw new Error(`browse.sh skill download failed: ${skillResponse.status}`);
  }
  return createSingleFileSkill({
    name: reference.name,
    content: await skillResponse.text(),
    sourceLabel: `browse-sh/${slug}`,
    sourceUrl:
      typeof detail.sourceUrl === "string"
        ? detail.sourceUrl
        : `https://browse.sh/${slug}`,
  });
}

async function downloadCatalogSkill(
  reference: CatalogSkillReference,
): Promise<DownloadedCatalogSkill> {
  validateCatalogReference(reference);
  const source = reference.source.toLowerCase();
  if (source === "clawhub") {
    return downloadClawHubPreview(reference);
  }
  if (source === "lobehub") {
    return downloadLobeHubSkill(reference);
  }
  if (source === "browse.sh" || source === "browse-sh") {
    return downloadBrowseShSkill(reference);
  }
  const location = resolveGitCatalogLocation(reference);
  if (!location) {
    throw new Error(`Unsupported catalog source: ${reference.source}`);
  }
  return cloneCatalogGitSkill(location);
}

export async function previewCatalogSkill(
  reference: CatalogSkillReference,
): Promise<CatalogSkillPreview> {
  const downloaded = await downloadCatalogSkill(reference);
  try {
    return {
      ...previewSkillDirectory(downloaded.sourceDir),
      source: reference.source,
      sourceUrl: downloaded.sourceUrl,
    };
  } finally {
    rmSync(downloaded.tmpDir, { recursive: true, force: true });
  }
}

export async function installCatalogSkill(params: {
  reference: CatalogSkillReference;
  agentId: string;
  force?: boolean;
}): Promise<InstallResult> {
  validateCatalogReference(params.reference);
  if (params.reference.source.toLowerCase() === "clawhub") {
    const slug = params.reference.identifier ?? params.reference.name;
    return installSkill(
      `clawhub/${slug}`,
      params.agentId,
      Boolean(params.force),
    );
  }

  const downloaded = await downloadCatalogSkill(params.reference);
  try {
    return await installSkillFromDirectory({
      sourceDir: downloaded.sourceDir,
      agentId: params.agentId,
      source: downloaded.sourceLabel,
      force: params.force,
    });
  } finally {
    rmSync(downloaded.tmpDir, { recursive: true, force: true });
  }
}
