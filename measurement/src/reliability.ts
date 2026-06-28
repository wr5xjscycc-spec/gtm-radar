export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
};

export interface RetryResult<T> {
  result: T | null;
  error: Error | null;
  attempts: number;
  success: boolean;
}

export interface IsolationResult<T> {
  results: Map<string, T | null>;
  errors: Map<string, Error>;
  partial: boolean;
}

/**
 * Execute a function with exponential backoff retry.
 *
 * Retries on ANY error (rate-limit, transient, network).
 * After maxRetries attempts, returns the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
): Promise<RetryResult<T>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, error: null, attempts: attempt + 1, success: true };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < options.maxRetries) {
        const delay = options.baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  return {
    result: null,
    error: lastError,
    attempts: options.maxRetries + 1,
    success: false,
  };
}

/**
 * Run multiple engine operations with isolation — a failure in one does
 * not block the others.
 *
 * Each engine key is called independently. Results and errors are
 * collected separately. `partial` is true if some succeeded and some failed.
 */
export async function isolateEngines<T>(
  engines: string[],
  runner: (engine: string) => Promise<T>,
): Promise<IsolationResult<T>> {
  const results = new Map<string, T | null>();
  const errors = new Map<string, Error>();
  let succeeded = 0;
  let failed = 0;

  for (const engine of engines) {
    try {
      const result = await runner(engine);
      results.set(engine, result);
      succeeded++;
    } catch (err) {
      results.set(engine, null);
      errors.set(engine, err instanceof Error ? err : new Error(String(err)));
      failed++;
    }
  }

  return {
    results,
    errors,
    partial: succeeded > 0 && failed > 0,
  };
}
