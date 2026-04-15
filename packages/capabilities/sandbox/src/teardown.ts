/**
 * Shared teardown state for serializing elevate/de-elevate transitions.
 * Prevents race conditions when re-elevating while the container is
 * still shutting down from a previous de-elevation.
 */

let teardownPromise: Promise<void> | null = null;

/** Get the current teardown promise (if any). */
export function getTeardownPromise(): Promise<void> | null {
  return teardownPromise;
}

/** Set the teardown promise (called by de_elevate). */
export function setTeardownPromise(promise: Promise<void>): void {
  teardownPromise = promise;
  // Auto-clear when done
  promise.finally(() => {
    if (teardownPromise === promise) {
      teardownPromise = null;
    }
  });
}

/** Clear the teardown promise. */
export function clearTeardownPromise(): void {
  teardownPromise = null;
}
