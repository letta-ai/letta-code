/** Bounded diagnostic volume, including rotating blockers and abandoned requests. */
export class BusyRecoveryBudget {
  private incidents = new Map<
    string,
    {
      phases: Set<string>;
      progress: number;
      snapshots: number;
      terminal: number;
    }
  >();
  private aliases = new Map<string, string>();
  private windowStarted = 0;
  private windowCount = 0;

  allow(
    phase: string,
    fields: { otid?: string; blockerRunId?: string; conversationId?: string },
    now = Date.now(),
  ): boolean {
    const requestKey = fields.otid
      ? JSON.stringify([fields.conversationId, fields.otid])
      : undefined;
    const blockerKey = fields.blockerRunId;
    const key =
      requestKey ??
      (blockerKey
        ? (this.aliases.get(blockerKey) ?? blockerKey)
        : (fields.conversationId ?? "unknown"));
    if (requestKey && blockerKey) {
      this.aliases.set(blockerKey, requestKey);
      if (this.aliases.size > 128)
        this.aliases.delete(this.aliases.keys().next().value ?? "");
    }
    const incident = this.incidents.get(key) ?? {
      phases: new Set<string>(),
      progress: 0,
      snapshots: 0,
      terminal: 0,
    };
    this.incidents.set(key, incident);
    if (this.incidents.size > 128)
      this.incidents.delete(this.incidents.keys().next().value ?? "");
    const terminal = [
      "stream_eof",
      "stream_failed",
      "stream_cancelled",
      "stream_closed",
      "poll_timed_out",
      "cancelled",
    ].includes(phase);
    const snapshot = phase === "stream_progress" || phase === "stream_waiting";
    if (
      incident.phases.has(phase) ||
      (terminal
        ? incident.terminal >= 2
        : snapshot
          ? incident.snapshots >= 2
          : incident.progress >= 8)
    )
      return false;
    // A process-wide ceiling also bounds churn beyond the retained incident set.
    if (now - this.windowStarted >= 120000) {
      this.windowStarted = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= (terminal ? 80 : snapshot ? 70 : 60)) return false;
    incident.phases.add(phase);
    if (terminal) incident.terminal += 1;
    else if (snapshot) incident.snapshots += 1;
    else incident.progress += 1;
    this.windowCount += 1;
    return true;
  }
}
