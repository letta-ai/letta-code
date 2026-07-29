import { describe, expect, test } from "bun:test";
import { parseGithubRepositoryRemote } from "./git-context";

describe("parseGithubRepositoryRemote", () => {
  test("parses GitHub HTTPS and SSH remotes", () => {
    expect(
      parseGithubRepositoryRemote("https://github.com/letta-ai/letta-code.git"),
    ).toEqual({ owner: "letta-ai", repo: "letta-code" });
    expect(
      parseGithubRepositoryRemote("git@github.com:letta-ai/letta-code.git"),
    ).toEqual({ owner: "letta-ai", repo: "letta-code" });
    expect(
      parseGithubRepositoryRemote(
        "ssh://git@github.com/letta-ai/letta-code.git",
      ),
    ).toEqual({ owner: "letta-ai", repo: "letta-code" });
  });

  test("rejects non-GitHub remotes", () => {
    expect(
      parseGithubRepositoryRemote("https://gitlab.com/letta-ai/letta-code.git"),
    ).toBeNull();
  });
});
