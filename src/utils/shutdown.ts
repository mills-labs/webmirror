/**
 * Cooperative shutdown handler.
 *
 * First SIGINT/SIGTERM only sets a flag — loops observe isShuttingDown()
 * and wind down; finally-blocks save state; the process exits normally.
 * Second signal runs registered emergency-save callbacks (newest first)
 * and force-exits with code 130.
 */

let shuttingDown = false;
let installed = false;
let callbacks: Array<() => void> = [];

/**
 * Install the signal handlers. Idempotent — registers one SIGINT and one
 * SIGTERM process listener ever, no matter how often it is called.
 */
export function initShutdown(): void {
  if (installed) return;
  installed = true;

  const handler = () => {
    if (shuttingDown) {
      // Second signal: emergency-save (newest first, errors swallowed), then force quit.
      for (let i = callbacks.length - 1; i >= 0; i--) {
        try { callbacks[i](); } catch { /* best effort */ }
      }
      process.exit(130);
    }
    shuttingDown = true;
    console.log('\n  Winding down — press Ctrl+C again to force quit.');
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Register an emergency-save callback and return its unregister function.
 * Callbacks run ONLY on the second (force) signal — normal wind-down is
 * cooperative via isShuttingDown().
 */
export function onShutdown(cb: () => void): () => void {
  callbacks.push(cb);
  return () => {
    const idx = callbacks.indexOf(cb);
    if (idx >= 0) callbacks.splice(idx, 1);
  };
}

/**
 * Clear only the wind-down flag for a fresh run scope, leaving registered
 * callbacks untouched. Lets a long-lived host process call the run entry
 * again after a cooperative wind-down; without this the module-global flag
 * stays true and every subsequent run's loop guard would no-op immediately.
 */
export function resetShutdownFlag(): void {
  shuttingDown = false;
}

/**
 * Clear the flag and all registered callbacks (tests only).
 */
export function resetShutdown(): void {
  shuttingDown = false;
  callbacks = [];
}
