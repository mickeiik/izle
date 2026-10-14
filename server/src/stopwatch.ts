/** Starts timing; the returned function gives the milliseconds since then, rounded (the `ms` of logs and reports). */
export function stopwatch(): () => number {
  const started = performance.now();
  return () => Math.round(performance.now() - started);
}
