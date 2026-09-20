// tests/unit/clock.test.ts
import { describe, it, expect } from "vitest";
import { SimulatedClock, RealClock } from "../../src/core/clock.js";

describe("SimulatedClock", () => {
  it("starts at the given start time", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T08:00:00.000Z");
  });

  it("advances to a specific day", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.advanceToDay(3);
    expect(clock.now()).toBe("2026-01-04T08:00:00.000Z");
  });

  it("can be set to an exact timestamp", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    clock.setTo("2026-06-15T12:30:00.000Z");
    expect(clock.now()).toBe("2026-06-15T12:30:00.000Z");
  });

  it("nowMs returns epoch milliseconds", () => {
    const clock = new SimulatedClock("2026-01-01T08:00:00.000Z");
    expect(clock.nowMs()).toBe(new Date("2026-01-01T08:00:00.000Z").getTime());
  });

  it("daysBetween computes full days", () => {
    const days = SimulatedClock.daysBetween(
      "2026-01-01T08:00:00.000Z",
      "2026-01-15T08:00:00.000Z"
    );
    expect(days).toBe(14);
  });

  it("daysBetween floors partial days", () => {
    const days = SimulatedClock.daysBetween(
      "2026-01-01T08:00:00.000Z",
      "2026-01-15T20:00:00.000Z"
    );
    expect(days).toBe(14);
  });
});

describe("RealClock", () => {
  it("returns a valid ISO timestamp", () => {
    const clock = new RealClock();
    const now = clock.now();
    expect(() => new Date(now).toISOString()).not.toThrow();
  });

  it("nowMs is close to Date.now()", () => {
    const clock = new RealClock();
    const before = Date.now();
    const ms = clock.nowMs();
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});
