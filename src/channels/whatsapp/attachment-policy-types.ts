export interface WhatsAppAttachmentPolicyConfig {
  attachmentFilter?: boolean;
  attachmentMimeTypes?: string[];
  attachmentAllowedRecipients?: string[];
  attachmentAllowedPaths?: string[];
  attachmentPathRecursive?: boolean;
}
