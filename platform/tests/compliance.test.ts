import { describe, it, expect } from "vitest";
import {
  canTransition,
  slotExpired,
  isAllowedCadence,
  customerExperimentView,
  dueNudge,
} from "../src/compliance";

describe("awaiting-publish gate — no 'running' without a publish event", () => {
  it("blocks designing/awaiting -> running without publish", () => {
    expect(canTransition("awaiting_publish", "running", { hasPublishEvent: false })).toBe(false);
    expect(canTransition("designing", "running", { hasPublishEvent: true })).toBe(false); // must go via awaiting
  });
  it("allows awaiting -> running ONLY with a publish event", () => {
    expect(canTransition("awaiting_publish", "running", { hasPublishEvent: true })).toBe(true);
  });
  it("allows the rest of the legal path + expiry", () => {
    expect(canTransition("designing", "awaiting_publish", { hasPublishEvent: false })).toBe(true);
    expect(canTransition("awaiting_publish", "expired", { hasPublishEvent: false })).toBe(true);
    expect(canTransition("running", "complete", { hasPublishEvent: true })).toBe(true);
    expect(canTransition("complete", "running", { hasPublishEvent: true })).toBe(false);
  });
});

describe("14-day slot expiry", () => {
  const t0 = 1_000_000_000_000;
  it("not expired before 14 days, expired at/after", () => {
    expect(slotExpired(t0, t0 + 13 * 86400_000)).toBe(false);
    expect(slotExpired(t0, t0 + 14 * 86400_000)).toBe(true);
  });
});

describe("cadence guard — monthly baseline, never weekly multi-engine", () => {
  it("bans weekly multi-engine", () => {
    expect(isAllowedCadence({ everyDays: 7, engines: 3 })).toBe(false);
    expect(isAllowedCadence({ everyDays: 1, engines: 2 })).toBe(false);
  });
  it("allows monthly baseline", () => {
    expect(isAllowedCadence({ everyDays: 30, engines: 1 })).toBe(true);
    expect(isAllowedCadence({ everyDays: 30, engines: 3 })).toBe(true);
  });
  it("rejects sub-monthly even single-engine (baseline is monthly)", () => {
    expect(isAllowedCadence({ everyDays: 14, engines: 1 })).toBe(false);
  });
});

describe("Hawthorne — control is invisible to the customer", () => {
  it("strips control_page from the customer view", () => {
    const view = customerExperimentView({
      status: "running",
      pairs: [{ treatment_page: "https://acme.com/a", control_page: "https://acme.com/b" }],
    });
    expect(view.pairs[0]).toEqual({ treatment_page: "https://acme.com/a" });
    expect((view.pairs[0] as any).control_page).toBeUndefined();
  });
});

describe("email nudges", () => {
  it("publish-pending while awaiting, result-ready when complete w/ lift", () => {
    expect(dueNudge({ status: "awaiting_publish" })).toBe("publish_pending");
    expect(dueNudge({ status: "complete", hasLiftResult: true })).toBe("result_ready");
    expect(dueNudge({ status: "complete", hasLiftResult: false })).toBe(null);
    expect(dueNudge({ status: "running" })).toBe(null);
  });
});
