/** A platform-verified user mention within channel message text. */
export interface ChannelUserMention {
  /** Inclusive JavaScript string offset into the owning text. */
  start: number;
  /** Exclusive JavaScript string offset into the owning text. */
  end: number;
  /** Stable platform user identifier. */
  userId: string;
  /** Human-readable, sanitized platform display name. */
  displayName: string;
}
