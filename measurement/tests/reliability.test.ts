import { describe, it, expect, vi } from "vitest";
import { withRetry, isolateEngines } from "../src/reliability";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result.success).toBe(true);
    expect(result.result).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds eventually", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result.success).toBe(true);
    expect(result.result).toBe("recovered");
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries exhausted", async () => {
    const err = new Error("persistent failure");
    const fn = vi.fn().mockRejectedValue(err);

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
    expect(result.success).toBe(false);
    expect(result.result).toBeNull();
    expect(result.error?.message).toBe("persistent failure");
    expect(result.attempts).toBe(3);
  });

  it("uses exponential backoff delay", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const delays: number[] = [];

    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: any, ms: any, ...args: any[]) => {
        delays.push(ms);
        return originalSetTimeout(fn, 1, ...args) as unknown as number;
      },
    );

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });

    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);

    vi.restoreAllMocks();
  });

  it("handles non-Error thrown values", async () => {
    const fn = vi.fn().mockRejectedValue("string error");
    const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 10 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe("string error");
  });

  it("handles synchronous throws in async wrapper", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("sync-like error"));
    const result = await withRetry(fn, { maxRetries: 0, baseDelayMs: 10 });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
  });
});

describe("isolateEngines", () => {
  const successRunner = async (engine: string) => `${engine}_result`;
  const errorRunner = async (_engine: string) => {
    throw new Error("engine down");
  };

  it("collects all results when all succeed", async () => {
    const result = await isolateEngines(["openai", "perplexity"], successRunner);
    expect(result.results.get("openai")).toBe("openai_result");
    expect(result.results.get("perplexity")).toBe("perplexity_result");
    expect(result.errors.size).toBe(0);
    expect(result.partial).toBe(false);
  });

  it("isolates failures — one failing does not block others", async () => {
    const runner = async (engine: string) => {
      if (engine === "openai") throw new Error("API failure");
      return `${engine}_ok`;
    };

    const result = await isolateEngines(
      ["openai", "perplexity", "gemini"],
      runner,
    );

    expect(result.results.get("openai")).toBeNull();
    expect(result.results.get("perplexity")).toBe("perplexity_ok");
    expect(result.results.get("gemini")).toBe("gemini_ok");
    expect(result.errors.has("openai")).toBe(true);
    expect(result.errors.has("perplexity")).toBe(false);
    expect(result.partial).toBe(true);
  });

  it("reports all errors when all fail", async () => {
    const result = await isolateEngines(["openai", "perplexity"], errorRunner);
    expect(result.results.get("openai")).toBeNull();
    expect(result.results.get("perplexity")).toBeNull();
    expect(result.errors.size).toBe(2);
    expect(result.partial).toBe(false);
  });

  it("handles empty engine list", async () => {
    const result = await isolateEngines([], successRunner);
    expect(result.results.size).toBe(0);
    expect(result.errors.size).toBe(0);
    expect(result.partial).toBe(false);
  });
});
