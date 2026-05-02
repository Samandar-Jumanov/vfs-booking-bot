export interface RetryOptions {
  maxAttempts: number;
  backoffMs: number;
  factor: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  backoffMs: 1000,
  factor: 2,
};

/**
 * Executes `fn` up to `maxAttempts` times with exponential backoff.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      opts.onRetry?.(attempt, err);

      if (attempt < opts.maxAttempts) {
        const delay = opts.backoffMs * Math.pow(opts.factor, attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
