// Logging and error containment: a failure in one part of the outline is
// logged once and degrades that part, never the page.
export const LOG = '[Claude Outline]';

const warned = new Set<string>();

export function warnOnce(key: string, err?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(LOG, key, err);
}

/** Runs fn; on an exception, warns once under `label` and returns the fallback. */
export function safe<T>(label: string, fn: () => T, fallback: T): T;
export function safe<T>(label: string, fn: () => T): T | undefined;
export function safe<T>(label: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}
