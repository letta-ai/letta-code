import { expect, test } from "bun:test";
import { createLinearClient } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notificationNode(id: string, createdAt: string) {
  return {
    __typename: "IssueNotification",
    id,
    type: "issueMention",
    createdAt,
    updatedAt: createdAt,
    issueId: `issue-${id}`,
    commentId: null,
    parentCommentId: null,
    actor: { id: "user-2", name: "cameron" },
    comment: null,
    issue: {
      id: `issue-${id}`,
      identifier: id.toUpperCase(),
      title: `Issue ${id}`,
      labels: { nodes: [] },
    },
  };
}

test("authenticates and parses the configured Linear viewer", async () => {
  const authorizations: Array<string | null> = [];
  const client = createLinearClient("lin-secret", async (_url, init) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return jsonResponse({
      data: {
        viewer: {
          id: "user-1",
          name: "agents",
          displayName: "agents",
          organization: { id: "org-1", name: "Letta" },
        },
      },
    });
  });

  await expect(client.getViewer()).resolves.toEqual({
    id: "user-1",
    name: "agents",
    displayName: "agents",
    organization: { id: "org-1", name: "Letta" },
  });
  expect(authorizations).toEqual(["lin-secret"]);
});

test("filters malformed and non-issue notification nodes", async () => {
  const client = createLinearClient("lin-secret", async () =>
    jsonResponse({
      data: {
        notifications: {
          nodes: [
            { __typename: "ProjectNotification", id: "project-1" },
            { __typename: "IssueNotification", id: "missing-issue" },
            {
              __typename: "IssueNotification",
              id: "notification-1",
              type: "issueCommentMention",
              createdAt: "2026-08-03T20:00:00.000Z",
              updatedAt: "2026-08-03T20:00:01.000Z",
              issueId: "issue-1",
              commentId: "comment-1",
              parentCommentId: null,
              actor: { id: "user-2", name: "cameron" },
              comment: { id: "comment-1", body: "@agents please help" },
              issue: {
                id: "issue-1",
                identifier: "LET-1",
                title: "Test issue",
                url: "https://linear.app/letta/issue/LET-1",
                state: { id: "state-1", name: "Todo", type: "unstarted" },
                labels: {
                  nodes: [
                    { id: "label-1", name: "channels" },
                    { id: null, name: "ignored" },
                  ],
                },
              },
            },
          ],
        },
      },
    }),
  );

  await expect(client.listIssueNotifications(100)).resolves.toEqual([
    expect.objectContaining({
      id: "notification-1",
      issueId: "issue-1",
      commentId: "comment-1",
      actor: { id: "user-2", name: "cameron", displayName: null },
      issue: expect.objectContaining({
        id: "issue-1",
        identifier: "LET-1",
        labels: [{ id: "label-1", name: "channels" }],
      }),
    }),
  ]);
});

test("paginates new notifications until the polling time boundary", async () => {
  const variables: unknown[] = [];
  const pages = [
    {
      data: {
        notifications: {
          nodes: [
            notificationNode("n-4", "2026-08-03T20:04:00.000Z"),
            notificationNode("n-3", "2026-08-03T20:03:00.000Z"),
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    },
    {
      data: {
        notifications: {
          nodes: [
            notificationNode("n-2", "2026-08-03T20:02:00.000Z"),
            notificationNode("old", "2026-08-03T19:59:00.000Z"),
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
        },
      },
    },
  ];
  const client = createLinearClient("lin-secret", async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { variables: unknown };
    variables.push(request.variables);
    const page = pages.shift();
    if (!page) throw new Error("Unexpected extra notification page");
    return jsonResponse(page);
  });

  const notifications = await client.listIssueNotifications(2, undefined, {
    createdAfter: "2026-08-03T20:00:00.000Z",
  });

  expect(notifications.map((notification) => notification.id)).toEqual([
    "n-4",
    "n-3",
    "n-2",
  ]);
  expect(variables).toEqual([
    { first: 2, after: null },
    { first: 2, after: "cursor-1" },
  ]);
});

test("stops pagination at the polling initialization time", async () => {
  let requests = 0;
  const client = createLinearClient("lin-secret", async () => {
    requests += 1;
    return jsonResponse({
      data: {
        notifications: {
          nodes: [
            notificationNode("new", "2026-08-03T20:01:00.000Z"),
            notificationNode("old", "2026-08-03T20:00:00.000Z"),
          ],
          pageInfo: { hasNextPage: true, endCursor: "unused" },
        },
      },
    });
  });

  const notifications = await client.listIssueNotifications(100, undefined, {
    createdAfter: "2026-08-03T20:00:30.000Z",
  });

  expect(notifications.map((notification) => notification.id)).toEqual(["new"]);
  expect(requests).toBe(1);
});

test("returns unseen history behind an independently persisted notification", async () => {
  const client = createLinearClient("lin-secret", async () =>
    jsonResponse({
      data: {
        notifications: {
          nodes: [
            notificationNode("persisted-newer", "2026-08-03T20:02:00.000Z"),
            notificationNode("unseen-older", "2026-08-03T20:01:00.000Z"),
            notificationNode("checkpoint", "2026-08-03T19:59:00.000Z"),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  );

  const notifications = await client.listIssueNotifications(100, undefined, {
    createdAfter: "2026-08-03T20:00:00.000Z",
  });

  expect(notifications.map((notification) => notification.id)).toEqual([
    "persisted-newer",
    "unseen-older",
  ]);
});

test("creates a threaded Linear comment", async () => {
  let variables: unknown;
  const client = createLinearClient("lin-secret", async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { variables?: unknown };
    variables = body.variables;
    return jsonResponse({
      data: {
        commentCreate: {
          success: true,
          comment: { id: "comment-2", url: "https://linear.app/comment-2" },
        },
      },
    });
  });

  await expect(
    client.createComment({
      issueId: "issue-1",
      body: "Response",
      parentId: "comment-root",
    }),
  ).resolves.toEqual({
    id: "comment-2",
    url: "https://linear.app/comment-2",
  });
  expect(variables).toEqual({
    input: {
      issueId: "issue-1",
      body: "Response",
      parentId: "comment-root",
    },
  });
});

test("redacts the API key from Linear and network errors", async () => {
  const graphqlClient = createLinearClient("lin-secret", async () =>
    jsonResponse({ errors: [{ message: "Credential lin-secret is invalid" }] }),
  );
  await expect(graphqlClient.getViewer()).rejects.toThrow(
    "Credential [REDACTED] is invalid",
  );

  const networkClient = createLinearClient("lin-secret", async () => {
    throw new Error("request with lin-secret failed");
  });
  await expect(networkClient.getViewer()).rejects.toThrow(
    "request with [REDACTED] failed",
  );
});
