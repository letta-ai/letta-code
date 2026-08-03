import { isRecord } from "@/utils/type-guards";
import type {
  LinearClient,
  LinearCreatedComment,
  LinearIssueNotification,
  LinearIssueSnapshot,
  LinearNotificationBoundary,
  LinearPerson,
  LinearViewer,
} from "./types";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const MAX_ERROR_MESSAGE_LENGTH = 500;

const VIEWER_QUERY = `
query LinearChannelViewer {
  viewer { id name displayName organization { id name } }
}`;

const NOTIFICATIONS_QUERY = `
query LinearChannelNotifications($first: Int!, $after: String) {
  notifications(first: $first, after: $after) {
    nodes {
      __typename
      id
      type
      createdAt
      updatedAt
      ... on IssueNotification {
        issueId
        commentId
        parentCommentId
        actor { id name displayName }
        comment { id body }
        issue {
          id
          identifier
          title
          url
          description
          priorityLabel
          dueDate
          estimate
          updatedAt
          state { id name type }
          assignee { id name displayName }
          delegate { id name displayName }
          project { id name url }
          labels(first: 50) { nodes { id name } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const COMMENT_MUTATION = `
mutation LinearChannelCreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`;

type LinearFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record[key]);
  if (!value) throw new Error(`Linear response is missing ${key}.`);
  return value;
}

function parsePerson(value: unknown): LinearPerson | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    name: optionalString(value.name),
    displayName: optionalString(value.displayName),
  };
}

function parseViewer(value: unknown): LinearViewer {
  if (!isRecord(value)) throw new Error("Linear viewer response is invalid.");
  const person = parsePerson(value);
  if (!person) throw new Error("Linear viewer response is missing an ID.");
  const organization = isRecord(value.organization)
    ? {
        id: requiredString(value.organization, "id"),
        name: requiredString(value.organization, "name"),
      }
    : null;
  return { ...person, organization };
}

function parseIssue(value: unknown): LinearIssueSnapshot | null {
  if (!isRecord(value)) return null;
  const id = optionalString(value.id);
  const identifier = optionalString(value.identifier);
  const title = optionalString(value.title);
  if (!id || !identifier || !title) return null;

  const state = isRecord(value.state)
    ? {
        id: requiredString(value.state, "id"),
        name: requiredString(value.state, "name"),
        type: optionalString(value.state.type),
      }
    : null;
  const project = isRecord(value.project)
    ? {
        id: requiredString(value.project, "id"),
        name: requiredString(value.project, "name"),
        url: optionalString(value.project.url),
      }
    : null;
  const labels =
    isRecord(value.labels) && Array.isArray(value.labels.nodes)
      ? value.labels.nodes.flatMap((label) => {
          if (!isRecord(label)) return [];
          const labelId = optionalString(label.id);
          const name = optionalString(label.name);
          return labelId && name ? [{ id: labelId, name }] : [];
        })
      : [];

  return {
    id,
    identifier,
    title,
    url: optionalString(value.url),
    description: optionalString(value.description),
    priorityLabel: optionalString(value.priorityLabel),
    dueDate: optionalString(value.dueDate),
    estimate: typeof value.estimate === "number" ? value.estimate : null,
    updatedAt: optionalString(value.updatedAt),
    state,
    assignee: parsePerson(value.assignee),
    delegate: parsePerson(value.delegate),
    project,
    labels,
  };
}

function parseNotification(value: unknown): LinearIssueNotification | null {
  if (
    !isRecord(value) ||
    value.__typename !== "IssueNotification" ||
    typeof value.id !== "string" ||
    typeof value.issueId !== "string"
  ) {
    return null;
  }
  const issue = parseIssue(value.issue);
  if (!issue) return null;
  const comment = isRecord(value.comment)
    ? {
        id: requiredString(value.comment, "id"),
        body: requiredString(value.comment, "body"),
      }
    : null;
  const createdAt = optionalString(value.createdAt) ?? new Date().toISOString();
  return {
    id: value.id,
    type: optionalString(value.type) ?? "issueActivity",
    createdAt,
    updatedAt: optionalString(value.updatedAt) ?? createdAt,
    issueId: value.issueId,
    commentId: optionalString(value.commentId),
    parentCommentId: optionalString(value.parentCommentId),
    actor: parsePerson(value.actor),
    comment,
    issue,
  };
}

function reachesNotificationBoundary(
  notification: LinearIssueNotification,
  boundary: LinearNotificationBoundary,
): boolean {
  const createdAt = Date.parse(notification.createdAt);
  const initializedAt = Date.parse(boundary.createdAfter);
  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(initializedAt) &&
    createdAt <= initializedAt
  );
}

function formatGraphqlErrors(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const messages = errors
    .flatMap((error) =>
      isRecord(error) && typeof error.message === "string"
        ? [error.message]
        : [],
    )
    .slice(0, 3)
    .join("; ");
  if (!messages) return null;
  return messages.length <= MAX_ERROR_MESSAGE_LENGTH
    ? messages
    : `${messages.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

export function createLinearClient(
  apiKey: string,
  fetchImpl: LinearFetch = fetch,
): LinearClient {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) throw new Error("Linear API key is required.");

  function redactApiKey(message: string): string {
    return message.split(normalizedApiKey).join("[REDACTED]");
  }

  async function graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(LINEAR_API_URL, {
        method: "POST",
        headers: {
          Authorization: normalizedApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal,
      });
    } catch (error) {
      throw new Error(
        redactApiKey(error instanceof Error ? error.message : String(error)),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Linear returned an invalid response (HTTP ${response.status}).`,
      );
    }
    if (!isRecord(body)) {
      throw new Error(
        `Linear returned an invalid response (HTTP ${response.status}).`,
      );
    }
    const detail = formatGraphqlErrors(body.errors);
    if (!response.ok || detail) {
      throw new Error(
        detail
          ? redactApiKey(detail)
          : `Linear GraphQL request failed with HTTP ${response.status}.`,
      );
    }
    if (!isRecord(body.data)) {
      throw new Error("Linear GraphQL response did not include data.");
    }
    return body.data;
  }

  return {
    async getViewer(signal) {
      const data = await graphql(VIEWER_QUERY, {}, signal);
      return parseViewer(data.viewer);
    },

    async listIssueNotifications(pageSize, signal, boundary) {
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) {
        throw new Error("Linear notification page size must be from 1 to 250.");
      }
      const notifications: LinearIssueNotification[] = [];
      const visitedCursors = new Set<string>();
      let after: string | null = null;

      while (true) {
        const data = await graphql(
          NOTIFICATIONS_QUERY,
          { first: pageSize, after },
          signal,
        );
        if (
          !isRecord(data.notifications) ||
          !Array.isArray(data.notifications.nodes)
        ) {
          throw new Error("Linear notification response is invalid.");
        }
        for (const node of data.notifications.nodes) {
          const notification = parseNotification(node);
          if (!notification) continue;
          if (boundary && reachesNotificationBoundary(notification, boundary)) {
            return notifications;
          }
          notifications.push(notification);
        }

        if (!boundary) return notifications;
        const pageInfo = data.notifications.pageInfo;
        if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true) {
          return notifications;
        }
        const endCursor = optionalString(pageInfo.endCursor);
        if (!endCursor || visitedCursors.has(endCursor)) {
          throw new Error("Linear notification pagination did not advance.");
        }
        visitedCursors.add(endCursor);
        after = endCursor;
      }
    },

    async createComment(input, signal): Promise<LinearCreatedComment> {
      const data = await graphql(COMMENT_MUTATION, { input }, signal);
      if (
        !isRecord(data.commentCreate) ||
        data.commentCreate.success !== true ||
        !isRecord(data.commentCreate.comment) ||
        typeof data.commentCreate.comment.id !== "string"
      ) {
        throw new Error("Linear did not create the channel reply.");
      }
      return {
        id: data.commentCreate.comment.id,
        url: optionalString(data.commentCreate.comment.url),
      };
    },
  };
}
