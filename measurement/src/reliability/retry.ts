// P2·6 Module 1 — retry/backoff with deterministic exponential delay.
//
// Why this exists: a full sweep fires many engine calls; transient failures (a 429 rate-limit,
// a 5xx, a dropped socket) are the common-case noise of any real API. Without a retry layer one
// blip aborts a whole (query, engine) run and silently dents coverage. `withRetry` absorbs exactly
// those transient classes and ONLY those — a 400/401/404 is a real, permanent defect and must
// surface immediately, not waste three exponential backoffs first.
//
// Two non-negotiables for testability (see the spec's "Pure / injectable"):
//   1. `sleep` is INJECTED. The default is the real `setTimeout`, but tests pass a recording fake
//      that resolves instantly so the backoff schedule is asserted deterministically and fast.
//   2. NO randomness / NO jitter. Delay for retry n is a pure function of (baseDelayMs, factor, n),
//      so [500, 1000, 2000] is reproducible. (Jitter would be nice in prod to avoid thundering
//      herds, but it would make the schedule untestable; the design chose determinism here.)

export interface RetryOpts {
  /** Max RETRIES after the first attempt. Default 3 → up to 4 attempts total. */
  maxRetries?: number;
  /** Delay before the FIRST retry, in ms. Default 500. */
  baseDelayMs?: number;
  /** Backoff multiplier. Default 2 → 500, 1000, 2000. */
  factor?: number;
  /** Optional per-delay ceiling. Each computed delay is clamped to at most this. */
  maxDelayMs?: number;
  /** Predicate: is this thrown value worth retrying? Default `defaultIsRetryable`. */
  isRetryable?: (e: unknown) => boolean;
  /** Injected sleep. Default real `setTimeout`. Tests pass an instant recording fake. */
  sleep?: (ms: number) => Promise<void>;
}

/** Real-clock sleep — the production default for `RetryOpts.sleep`. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default classifier for "transient, worth retrying".
 *
 * The OpenAI adapter throws `Error("OpenAI Responses API error 429: …")`, so the contract is a
 * word-boundary match on the HTTP status embedded in the message: `\b429\b` and any `\b5\d\d\b`.
 * Network-layer failures surface either as a message ("fetch failed") or a Node `error.code`
 * (ECONNRESET / ETIMEDOUT), so we inspect BOTH `message` and `code`.
 *
 * Permanent failures — 400 (bad request), 401 (auth), 404 (not found) — are deliberately NOT
 * retryable: retrying them just burns backoff and hides a real bug. Anything we can't read a
 * message/code off of (undefined, null, a bare string/number) is treated as non-retryable: if we
 * can't recognize it as transient, we surface it.
 */
export function defaultIsRetryable(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;

  const message = typeof (e as { message?: unknown }).message === "string"
    ? (e as { message: string }).message
    : "";
  const code = typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : "";
  const haystack = `${message} ${code}`;

  // 429 rate-limit or any 5xx server error embedded in the message/code.
  if (/\b429\b/.test(haystack)) return true;
  if (/\b5\d\d\b/.test(haystack)) return true;

  // Network-ish: dropped/timed-out sockets and fetch's opaque "fetch failed".
  if (/ECONNRESET|ETIMEDOUT/.test(haystack)) return true;
  if (/fetch failed/i.test(haystack)) return true;

  return false;
}

/**
 * Run `fn`, retrying transient failures with deterministic exponential backoff.
 *
 * On throw: if `isRetryable(e)` AND retries remain, `await sleep(delay)` then re-run `fn`; otherwise
 * rethrow the LAST error (the caller sees the actual failure, not a synthetic one). The delay before
 * retry `n` (0-based: first retry is n=0) is `min(maxDelayMs ?? ∞, baseDelayMs * factor**n)`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const factor = opts.factor ?? 2;
  const maxDelayMs = opts.maxDelayMs ?? Infinity;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? realSleep;

  // `attempt` is 0-based over total tries; retries remain while attempt < maxRetries.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retriesLeft = attempt < maxRetries;
      if (!retriesLeft || !isRetryable(e)) throw e;
      const delay = Math.min(maxDelayMs, baseDelayMs * factor ** attempt);
      await sleep(delay);
    }
  }
}
