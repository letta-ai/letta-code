import { describe, expect, it } from "bun:test";
import {
  isSkillCatalogInstallCommand,
  isSkillCatalogPreviewCommand,
} from "@/websocket/listener/skill-protocol-inbound";

describe("skill catalog protocol", () => {
  it("accepts preview and install requests from the skills page", () => {
    expect(
      isSkillCatalogPreviewCommand({
        type: "skill_catalog_preview",
        request_id: "preview-1",
        skill: {
          source: "skills.sh",
          name: "100m-leads",
          identifier: "skills-sh/getagentseal/founder-playbook/100m-leads",
        },
      }),
    ).toBe(true);
    expect(
      isSkillCatalogInstallCommand({
        type: "skill_catalog_install",
        request_id: "install-1",
        agent_id: "agent-123",
        skill: {
          source: "ClawHub",
          name: "Apple Design",
          identifier: "apple-design",
        },
      }),
    ).toBe(true);
  });

  it("rejects catalog requests without a source or target agent", () => {
    expect(
      isSkillCatalogPreviewCommand({
        type: "skill_catalog_preview",
        request_id: "preview-1",
        skill: { name: "missing-source" },
      }),
    ).toBe(false);
    expect(
      isSkillCatalogInstallCommand({
        type: "skill_catalog_install",
        request_id: "install-1",
        skill: { source: "ClawHub", name: "apple-design" },
      }),
    ).toBe(false);
  });
});
