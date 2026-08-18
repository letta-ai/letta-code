import {
  getLocalMemoryFormat,
  isProjectedMemoryPath,
  type LocalMemoryFormat,
} from "@/agent/memory-format";
import { getFileNodes, type TreeNode } from "@/agent/memory-scanner";
import { getBackend } from "@/backend";
import { getMemoryImageMimeType } from "@/utils/memory-images";

const MARKDOWN_LINK_REGEX = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

function isMarkdownMemoryPath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(".md");
}

export async function resolveProjectedMemoryFiles(
  agentId: string,
  treeNodes: TreeNode[],
  formatOverride?: LocalMemoryFormat,
): Promise<{ fileNodes: TreeNode[]; memoryFormat: LocalMemoryFormat }> {
  const memoryFormat =
    formatOverride ??
    getLocalMemoryFormat(
      (
        await getBackend().retrieveAgent(agentId, {
          include: ["agent.tags"],
        })
      ).tags,
    );
  const allFileNodes = getFileNodes(treeNodes);
  const allPaths = new Set(
    allFileNodes.map((node) => node.relativePath.replace(/\\/g, "/")),
  );
  const fileNodes = allFileNodes.filter(
    (node) =>
      (isMarkdownMemoryPath(node.relativePath) ||
        getMemoryImageMimeType(node.relativePath) !== null) &&
      isProjectedMemoryPath(node.relativePath, allPaths, memoryFormat),
  );
  return { fileNodes, memoryFormat };
}

export function getMarkdownMemoryLinkTargets(body: string): string[] {
  return [...body.matchAll(MARKDOWN_LINK_REGEX)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}
