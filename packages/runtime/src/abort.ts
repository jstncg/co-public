/** Bound callers even when DNS or an adapter cannot cancel its own work.
 * Late failures remain handled; callers must not commit after rejection. */
export function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Operation aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending.then((value) => {
      signal.removeEventListener("abort", abort); resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}
