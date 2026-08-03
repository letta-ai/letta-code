export interface LinearPerson {
  id: string;
  name?: string | null;
  displayName?: string | null;
}

export interface LinearViewer extends LinearPerson {
  organization?: {
    id: string;
    name: string;
  } | null;
}

export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
  description?: string | null;
  priorityLabel?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  updatedAt?: string | null;
  state?: {
    id: string;
    name: string;
    type?: string | null;
  } | null;
  assignee?: LinearPerson | null;
  delegate?: LinearPerson | null;
  project?: {
    id: string;
    name: string;
    url?: string | null;
  } | null;
  labels: Array<{ id: string; name: string }>;
}

export interface LinearIssueNotification {
  id: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  issueId: string;
  commentId: string | null;
  parentCommentId: string | null;
  actor: LinearPerson | null;
  comment: { id: string; body: string } | null;
  issue: LinearIssueSnapshot;
}

export interface LinearCreatedComment {
  id: string;
  url?: string | null;
}

export interface LinearNotificationBoundary {
  createdAfter: string;
}

export interface LinearClient {
  getViewer(signal?: AbortSignal): Promise<LinearViewer>;
  listIssueNotifications(
    pageSize: number,
    signal?: AbortSignal,
    boundary?: LinearNotificationBoundary,
  ): Promise<LinearIssueNotification[]>;
  createComment(
    input: { issueId: string; body: string; parentId?: string },
    signal?: AbortSignal,
  ): Promise<LinearCreatedComment>;
}
