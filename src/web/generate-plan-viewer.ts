/**
 * Plan Viewer Generator
 *
 * Creates a self-contained HTML file that renders a plan's markdown content
 * in the browser, reusing the Memory Palace's visual language. Writes to
 * ~/.letta/viewers/ and opens in the default browser.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import planViewerTemplate from "./plan-viewer-template.txt";
import type { PlanViewerData } from "./types";

const VIEWERS_DIR = join(homedir(), ".letta", "viewers");

export interface GeneratePlanResult {
  filePath: string;
  opened: boolean;
}

export async function generateAndOpenPlanViewer(
  planContent: string,
  planFilePath: string,
  options?: { agentName?: string },
): Promise<GeneratePlanResult> {
  const data: PlanViewerData = {
    agent: { name: options?.agentName ?? "" },
    planContent,
    planFilePath,
    generatedAt: new Date().toISOString(),
  };

  // Safely embed JSON - escape < to \u003c to prevent </script> injection
  const jsonPayload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = planViewerTemplate.replace(
    "<!--LETTA_PLAN_DATA_PLACEHOLDER-->",
    () => jsonPayload,
  );

  // Write to ~/.letta/viewers/ with owner-only permissions
  if (!existsSync(VIEWERS_DIR)) {
    mkdirSync(VIEWERS_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(VIEWERS_DIR, 0o700);
  } catch {}

  const filePath = join(VIEWERS_DIR, "plan.html");
  writeFileSync(filePath, html);
  chmodSync(filePath, 0o600);

  // Open in browser (skip inside tmux)
  const isTmux = Boolean(process.env.TMUX);
  if (!isTmux) {
    try {
      const { default: openUrl } = await import("open");
      await openUrl(filePath, { wait: false });
    } catch {
      throw new Error(`Could not open browser. Run: open ${filePath}`);
    }
  }

  return { filePath, opened: !isTmux };
}
