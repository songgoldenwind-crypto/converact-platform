/**
 * Shared HTTP I/O retry — exponential backoff for 5xx / network errors.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryIoStatus(statusCode: number): boolean {
  return statusCode === 0 || statusCode >= 500;
}

export async function sendWithIoRetries<T extends { success: boolean; statusCode: number }>(
  send: () => Promise<T>,
  retryCount: number,
  shouldRetry: (result: T) => boolean = (r) => shouldRetryIoStatus(r.statusCode)
): Promise<T> {
  const capped = Math.max(0, Math.min(retryCount, 5));
  let result = await send();
  for (let attempt = 0; attempt < capped && shouldRetry(result); attempt++) {
    await sleep(Math.min(1000 * 2 ** attempt, 8000));
    result = await send();
  }
  return result;
}
