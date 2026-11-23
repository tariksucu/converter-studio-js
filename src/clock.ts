/**
 * Time, in one place so that tests can make waiting instant. Not part of the public API.
 *
 * @module
 */

/** The clock and the pauses the client uses. */
export const clock: {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {
  now: (): number => performance.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason as Error);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
