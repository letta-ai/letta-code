export const GITHUB_PULL_REQUEST_QUERY = `
query(
  $owner: String!
  $name: String!
  $number: Int!
  $commentsAfter: String
  $reviewsAfter: String
  $threadsAfter: String
  $contextsAfter: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      state
      isDraft
      merged
      updatedAt
      headRefOid
      mergeable
      mergeStateStatus
      reviewDecision
      comments(first: 100, after: $commentsAfter) {
        nodes { id author { login } body url createdAt updatedAt }
        pageInfo { hasNextPage endCursor }
      }
      reviews(first: 100, after: $reviewsAfter) {
        nodes { id author { login } body url state submittedAt updatedAt commit { oid } }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: 100, after: $threadsAfter) {
        totalCount
        nodes {
          id
          isResolved
          comments(last: 100) {
            nodes {
              id
              author { login }
              body
              url
              createdAt
              updatedAt
              path
              line
              originalLine
              outdated
              commit { oid }
            }
            pageInfo { hasPreviousPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100, after: $contextsAfter) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                  }
                  ... on StatusContext {
                    id
                    context
                    state
                    targetUrl
                    description
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  }
}`;

export const GITHUB_PULL_REQUEST_METADATA_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      isDraft
      merged
      updatedAt
      headRefOid
      mergeable
      mergeStateStatus
      reviewDecision
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id
          isResolved
          comments(last: 1) {
            nodes { id updatedAt outdated }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                  }
                  ... on StatusContext {
                    id
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export const GITHUB_REVIEW_THREAD_QUERY = `
query($id: ID!, $before: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id
      comments(last: 100, before: $before) {
        nodes {
          id
          author { login }
          body
          url
          createdAt
          updatedAt
          path
          line
          originalLine
          outdated
          commit { oid }
        }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;
