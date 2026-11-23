import { expect, test } from "bun:test";
import { parseTaskCloudOptions } from "./task-cloud-options";

test("cloud configuration requires an explicit cloud selector and maps GitHub refs", () => {
  const commit = "a".repeat(40);
  const cloud = {
    repositories: ["octocat/hello", `octocat/world@${commit}`],
    sandbox_size: "large",
  };
  expect(parseTaskCloudOptions(undefined, cloud)).toEqual({
    error: 'cloud requires computer: "cloud"',
  });
  expect(parseTaskCloudOptions("office-mac", cloud)).toHaveProperty("error");
  expect(
    parseTaskCloudOptions("cloud", { repositories: ["octocat/world@main"] }),
  ).toHaveProperty("error");
  expect(parseTaskCloudOptions("cloud", cloud)).toEqual({
    options: {
      githubRepositories: [
        { owner: "octocat", repo: "hello" },
        { owner: "octocat", repo: "world", commit },
      ],
      sandboxSize: "large",
    },
  });
});

test("accepts the legacy cloud selector for compatibility", () => {
  const cloud = { sandbox_size: "large" };
  expect(parseTaskCloudOptions("cloud-sandbox", cloud)).toEqual({
    options: { sandboxSize: "large" },
  });
});
