import { describe, expect, test } from "bun:test";
import ImageGenerationSkill from "./SKILL.md";

describe("image-generation skill", () => {
  test("uses the runtime Letta base URL and token", () => {
    expect(ImageGenerationSkill).toContain("$" + "{LETTA_BASE_URL%/}");
    expect(ImageGenerationSkill).toContain("$env:LETTA_BASE_URL.TrimEnd('/')");
    expect(ImageGenerationSkill).toContain(
      "Authorization: Bearer $LETTA_API_KEY",
    );
    expect(ImageGenerationSkill).toContain("Do not hardcode");
  });

  test("explains cross-platform profile image placement", () => {
    expect(ImageGenerationSkill).toContain("Agent profile images");
    expect(ImageGenerationSkill).toContain("$MEMORY_DIR/profile.png");
    expect(ImageGenerationSkill).toContain(
      "Join-Path $env:MEMORY_DIR 'profile.png'",
    );
    expect(ImageGenerationSkill).toContain(
      "Read/Write tool paths like\nliteral `$MEMORY_DIR/profile.png`",
    );
  });
});
