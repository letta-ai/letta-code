export interface WhatsAppAttachmentPolicyConfig {
  /** Enables outbound policy checks. */
  attachmentFilter?: boolean;
  /** Extension-derived MIME allowlist. */
  attachmentMimeTypes?: string[];
  /** Phone identities or exact group JIDs. */
  attachmentAllowedRecipients?: string[];
  /** Allowed media source directories. */
  attachmentAllowedPaths?: string[];
  /** Allows directory descendants. */
  attachmentPathRecursive?: boolean;
}
