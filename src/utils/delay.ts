/**
 * Delay utilities — extracted from existing scrapers
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Randomized delay: 100%-175% of base, never drops below the base.
 * Mimics natural browsing patterns to avoid detection.
 */
export function jitteredDelay(baseMs: number): Promise<void> {
  const min = baseMs;
  const max = Math.floor(baseMs * 1.75);
  const actual = min + Math.floor(Math.random() * (max - min));
  return sleep(actual);
}

/**
 * Pick a uniformly random delay from [minMs, maxMs], quantized to stepMs
 * increments (default 100ms = 0.1s). maxMs below minMs clamps to minMs.
 */
export function pickDelayInRange(minMs: number, maxMs: number, stepMs = 100): number {
  if (maxMs < minMs) maxMs = minMs;
  const steps = Math.floor((maxMs - minMs) / stepMs);
  return minMs + stepMs * Math.floor(Math.random() * (steps + 1));
}

/** Sleep for a random 0.1s-quantized duration within [minMs, maxMs]. */
export function rangeDelay(minMs: number, maxMs: number, stepMs = 100): Promise<void> {
  return sleep(pickDelayInRange(minMs, maxMs, stepMs));
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}
