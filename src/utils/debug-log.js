/**
 * Lightweight debug logger -- logs only when MERCURY_DEBUG is set.
 * Replaces 100+ bare catch {} blocks with traceable error reporting.
 */
const _debugEnabled = !!(process.env.MERCURY_DEBUG || process.env.DEBUG);

export function debugLog(context, err) {
  if (_debugEnabled) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    const stack = err instanceof Error ? `\n  ${err.stack?.split("\n")[1]?.trim() || ""}` : "";
    process.stderr.write(`[mercury:debug] ${context}: ${msg}${stack}\n`);
  }
}

export function isDebugEnabled() {
  return _debugEnabled;
}
