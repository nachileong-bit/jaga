// src/core/clock.ts
// Clock interface and implementations.
// No code in src/core may call Date.now() directly — always go through Clock.

import type { Clock } from "./types.js";

/**
 * Real wall-clock time for production.
 */
export class RealClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
  nowMs(): number {
    return Date.now();
  }
}

/**
 * Simulated clock for demos and timeline tests.
 * Time is anchored to a start instant and advanced by days.
 * The time-machine slider in the web demo drives `advanceToDay`.
 */
export class SimulatedClock implements Clock {
  private startMs: number;
  private msPerDay = 86_400_000;
  private _currentDayMs: number;

  constructor(start: string | number = "2026-01-01T08:00:00.000Z") {
    this.startMs = new Date(start).getTime();
    this._currentDayMs = this.startMs;
  }

  /**
   * Advance the clock to `day` days after the start instant.
   * Day 0 = start day. Time within the day is preserved from start.
   */
  advanceToDay(day: number): void {
    this._currentDayMs = this.startMs + day * this.msPerDay;
  }

  /**
   * Set the clock to an exact ISO timestamp (for fine-grained control).
   */
  setTo(isoTimestamp: string): void {
    this._currentDayMs = new Date(isoTimestamp).getTime();
  }

  now(): string {
    return new Date(this._currentDayMs).toISOString();
  }

  nowMs(): number {
    return this._currentDayMs;
  }

  /**
   * Compute the number of full days between two ISO timestamps.
   */
  static daysBetween(fromIso: string, toIso: string): number {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    return Math.floor((to - from) / 86_400_000);
  }
}
