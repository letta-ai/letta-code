import type { Buffers } from "../cli/helpers/accumulator";

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  stepCount: number;
}

export interface SessionStatsSnapshot {
  sessionStartMs: number;
  totalWallMs: number;
  totalApiMs: number;
  usage: UsageStats;
}

export class SessionStats {
  private sessionStartMs: number;
  private totalApiMs: number;
  private usage: UsageStats;

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
  }

  endTurn(apiDurationMs: number): void {
    this.totalApiMs += apiDurationMs;
  }

  updateUsageFromBuffers(buffers: Buffers): void {
    this.usage = { ...buffers.usage };
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
  }
}
