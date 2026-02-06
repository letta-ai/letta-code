import type { Buffers } from "../cli/helpers/accumulator";

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  stepCount: number;
}

export type UsageStatsDelta = UsageStats;

export interface SessionStatsSnapshot {
  sessionStartMs: number;
  totalWallMs: number;
  totalApiMs: number;
  usage: UsageStats;
}

export interface TrajectoryStatsSnapshot {
  trajectoryStartMs: number;
  wallMs: number;
  workMs: number;
  apiMs: number;
  localMs: number;
  stepCount: number;
  tokens: number;
}

export class SessionStats {
  private sessionStartMs: number;
  private totalApiMs: number;
  private usage: UsageStats;
  private lastUsageSnapshot: UsageStats;
  private trajectoryStartMs: number | null;
  private trajectoryApiMs: number;
  private trajectoryLocalMs: number;
  private trajectoryWallMs: number;
  private trajectoryStepCount: number;
  private trajectoryTokens: number;

  constructor() {
    this.sessionStartMs = performance.now();
    this.totalApiMs = 0;
    this.usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      stepCount: 0,
    };
    this.lastUsageSnapshot = { ...this.usage };
    this.trajectoryStartMs = null;
    this.trajectoryApiMs = 0;
    this.trajectoryLocalMs = 0;
    this.trajectoryWallMs = 0;
    this.trajectoryStepCount = 0;
    this.trajectoryTokens = 0;
  }

  endTurn(apiDurationMs: number): void {
    this.totalApiMs += apiDurationMs;
  }

  updateUsageFromBuffers(buffers: Buffers): UsageStatsDelta {
    const nextUsage = { ...buffers.usage };
    const prevUsage = this.lastUsageSnapshot;

    const delta: UsageStatsDelta = {
      promptTokens: Math.max(
        0,
        nextUsage.promptTokens - prevUsage.promptTokens,
      ),
      completionTokens: Math.max(
        0,
        nextUsage.completionTokens - prevUsage.completionTokens,
      ),
      totalTokens: Math.max(0, nextUsage.totalTokens - prevUsage.totalTokens),
      cachedTokens: Math.max(
        0,
        nextUsage.cachedTokens - prevUsage.cachedTokens,
      ),
      reasoningTokens: Math.max(
        0,
        nextUsage.reasoningTokens - prevUsage.reasoningTokens,
      ),
      stepCount: Math.max(0, nextUsage.stepCount - prevUsage.stepCount),
    };

    this.usage = nextUsage;
    this.lastUsageSnapshot = nextUsage;
    return delta;
  }

  startTrajectory(): void {
    if (this.trajectoryStartMs === null) {
      this.trajectoryStartMs = performance.now();
    }
  }

  accumulateTrajectory(options: {
    apiDurationMs?: number;
    localToolMs?: number;
    wallMs?: number;
    usageDelta?: UsageStatsDelta;
    tokenDelta?: number;
  }): void {
    this.startTrajectory();

    if (options.apiDurationMs) {
      this.trajectoryApiMs += options.apiDurationMs;
    }
    if (options.localToolMs) {
      this.trajectoryLocalMs += options.localToolMs;
    }
    if (options.wallMs) {
      this.trajectoryWallMs += options.wallMs;
    }
    if (options.usageDelta) {
      this.trajectoryStepCount += options.usageDelta.stepCount;
    }
    if (options.tokenDelta) {
      this.trajectoryTokens += options.tokenDelta;
    }
  }

  getTrajectorySnapshot(): TrajectoryStatsSnapshot | null {
    if (this.trajectoryStartMs === null) return null;
    const workMs = this.trajectoryApiMs + this.trajectoryLocalMs;
    return {
      trajectoryStartMs: this.trajectoryStartMs,
      wallMs: this.trajectoryWallMs,
      workMs,
      apiMs: this.trajectoryApiMs,
      localMs: this.trajectoryLocalMs,
      stepCount: this.trajectoryStepCount,
      tokens: this.trajectoryTokens,
    };
  }

  endTrajectory(): TrajectoryStatsSnapshot | null {
    const snapshot = this.getTrajectorySnapshot();
    this.resetTrajectory();
    return snapshot;
  }

  resetTrajectory(): void {
    this.trajectoryStartMs = null;
    this.trajectoryApiMs = 0;
    this.trajectoryLocalMs = 0;
    this.trajectoryWallMs = 0;
    this.trajectoryStepCount = 0;
    this.trajectoryTokens = 0;
  }

  getSnapshot(): SessionStatsSnapshot {
    const now = performance.now();
    return {
      sessionStartMs: this.sessionStartMs,
      totalWallMs: now - this.sessionStartMs,
      totalApiMs: this.totalApiMs,
      usage: { ...this.usage },
    };
  }

  reset(): void {
    this.sessionStartMs = performance.now();
    this.totalApiMs = 0;
    this.usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      stepCount: 0,
    };
    this.lastUsageSnapshot = { ...this.usage };
    this.resetTrajectory();
  }
}
