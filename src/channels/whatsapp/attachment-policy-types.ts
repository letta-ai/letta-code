export interface WhatsAppAttachmentPolicyConfig {
  attachmentFilter?: boolean;
  /** Extension-derived MIME allowlist. */
  attachmentMimeTypes?: string[];
  /** Phone identities or exact group JIDs. */
  attachmentAllowedRecipients?: string[];
  attachmentAllowedPaths?: string[];
  attachmentPathRecursive?: boolean;
}
