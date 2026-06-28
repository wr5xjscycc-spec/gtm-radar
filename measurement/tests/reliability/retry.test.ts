// Tests for Module 1 — retry/backoff (`src/reliability/retry.ts`).
//
// STRICT TDD: this file is written before the module exists (red), then we implement to green.
// NO real clock: every test injects a `sleep` that records its `ms` arg and resolves instantly,
// so we assert the EXACT backoff schedule deterministically (no jitter, no Math.random).

import { describe, it, expect } from "vitest";
import { withRetry, defaultIsRetryable, type RetryOpts } from "../../src/reliability/retry";

/**
 * A fake `sleep` that records every requested delay (in order) and resolves immediately.
 * Lets us assert the precise backoff schedule without burning real time.
 */
function recordingSleep() {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { calls, sleep };
}

/** Build an `fn` that throws the given errors (in order) then returns `value` forever after. */
function failsNTimesThenSucceeds(errors: unknown[], value: unknown) {
  let i = 0;
  return async () => {
    if (i < errors.length) {
      const e = errors[i++];
      throw e;
    }
    return value;
  };
}

describe("withRetry", () => {
  it("success on first try → 0 sleeps, returns value", async () => {
    const { calls, sleep } = recordingSleep();
    const fn = async () => "ok";
    const out = await withRetry(fn, { sleep });
    expect(out).toBe("ok");
    expect(calls).toEqual([]);
  });

  it("throws 429 twice then succeeds → 2 sleeps [500,1000], returns value", async () => {
    const { calls, sleep } = recordingSleep();
    const fn = failsNTimesThenSucceeds(
      [new Error("OpenAI Responses API error 429: rate limited"), new Error("429 again")],
      "recovered",
    );
    const out = await withRetry(fn, { sleep });
    expect(out).toBe("recovered");
    expect(calls).toEqual([500, 1000]);
  });

  it("always-429 → rethrows after maxRetries, sleeps [500,1000,2000] (3 sleeps at default)", async () => {
    const { calls, sleep } = recordingSleep();
    const lastErr = new Error("OpenAI Responses API error 429: hard down");
    const errs = [new Error("429 a"), new Error("429 b"), new Error("429 c"), lastErr];
    const fn = failsNTimesThenSucceeds(errs, "never");
    await expect(withRetry(fn, { sleep })).rejects.toThrow(lastErr);
    expect(calls).toEqual([500, 1000, 2000]);
  });

  it("non-retryable error (400) → throws immediately, 0 sleeps", async () => {
    const { calls, sleep } = recordingSleep();
    const err = new Error("400 bad request");
    const fn = failsNTimesThenSucceeds([err], "never");
    await expect(withRetry(fn, { sleep })).rejects.toThrow(err);
    expect(calls).toEqual([]);
  });

  it("maxDelayMs caps the schedule", async () => {
    const { calls, sleep } = recordingSleep();
    // base 500, factor 2 → 500,1000,2000 ... capped at 900 → 500,900,900
    const fn = failsNTimesThenSucceeds(
      [new Error("429"), new Error("429"), new Error("429"), new Error("429")],
      "x",
    );
    await expect(withRetry(fn, { sleep, maxDelayMs: 900 })).rejects.toThrow();
    expect(calls).toEqual([500, 900, 900]);
  });

  it("custom factor and baseDelayMs honored", async () => {
    const { calls, sleep } = recordingSleep();
    // base 100, factor 3 → 100,300,900
    const fn = failsNTimesThenSucceeds(
      [new Error("429"), new Error("429"), new Error("429"), new Error("429")],
      "x",
    );
    await expect(withRetry(fn, { sleep, baseDelayMs: 100, factor: 3 })).rejects.toThrow();
    expect(calls).toEqual([100, 300, 900]);
  });

  it("maxRetries:0 → no retries, single attempt, 0 sleeps", async () => {
    const { calls, sleep } = recordingSleep();
    const err = new Error("429");
    const fn = failsNTimesThenSucceeds([err], "never");
    await expect(withRetry(fn, { sleep, maxRetries: 0 })).rejects.toThrow(err);
    expect(calls).toEqual([]);
  });

  it("custom isRetryable overrides the default", async () => {
    const { calls, sleep } = recordingSleep();
    // Treat a normally-non-retryable 400 as retryable; recover after one retry.
    const fn = failsNTimesThenSucceeds([new Error("400 bad request")], "ok");
    const isRetryable = (e: unknown) => /\b400\b/.test((e as Error).message);
    const out = await withRetry(fn, { sleep, isRetryable });
    expect(out).toBe("ok");
    expect(calls).toEqual([500]);
  });
});

describe("defaultIsRetryable", () => {
  it("429 / 5xx / network-ish → true", () => {
    expect(defaultIsRetryable(new Error("OpenAI Responses API error 429: rate limited"))).toBe(true);
    expect(defaultIsRetryable(new Error("OpenAI Responses API error 500: oops"))).toBe(true);
    expect(defaultIsRetryable(new Error("503 Service Unavailable"))).toBe(true);
    expect(defaultIsRetryable(new Error("fetch failed"))).toBe(true);
    expect(defaultIsRetryable(new Error("read ECONNRESET"))).toBe(true);
    expect(defaultIsRetryable(new Error("connect ETIMEDOUT"))).toBe(true);
  });

  it("matches code property as well as message", () => {
    expect(defaultIsRetryable({ code: "ECONNRESET" })).toBe(true);
    expect(defaultIsRetryable({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("400 / 401 / 404 → false", () => {
    expect(defaultIsRetryable(new Error("400 bad request"))).toBe(false);
    expect(defaultIsRetryable(new Error("401 Unauthorized"))).toBe(false);
    expect(defaultIsRetryable(new Error("404 Not Found"))).toBe(false);
  });

  it("non-error / undefined → false", () => {
    expect(defaultIsRetryable(undefined)).toBe(false);
    expect(defaultIsRetryable(null)).toBe(false);
    expect(defaultIsRetryable("just a string")).toBe(false);
    expect(defaultIsRetryable(42)).toBe(false);
  });
});

// Keep the unused type import meaningful in case a future test references it.
const _typeProbe: RetryOpts = {};
void _typeProbe;
