/**
 * Seconds left, extrapolated locally from the last server-measured value. Callers pass
 * performance.now() readings (a monotonic clock), never Date.now(): the counter's wall clock may
 * be minutes off or jump, and only real elapsed time since the last poll is subtracted. The
 * server value is re-synced on every poll.
 */
export function remainingSeconds(serverSeconds: number, syncedAtMs: number, nowMs: number): number {
  const elapsed = Math.floor(Math.max(0, nowMs - syncedAtMs) / 1000);
  return Math.max(0, serverSeconds - elapsed);
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
