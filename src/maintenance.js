// Housekeeping at start and hourly: prune the results store (always) and this
// server's own exports (only when export_retention_days > 0).
import { pruneExports } from './export.js';
import { pruneResults } from './results.js';

export const MAINTENANCE_INTERVAL_MS = 3600e3;

export async function runMaintenance(ctx, { now = Date.now(), platform = process.platform } = {}) {
  const { config, resultsDir } = ctx;
  const stateDir = ctx.stateDir?.path ?? ctx.stateDir;
  const results = await pruneResults(resultsDir, { retentionDays: config.results_retention_days, maxMb: config.results_max_mb, now });
  const exports = await pruneExports(stateDir, { retentionDays: config.export_retention_days, now, platform });
  return { results, exports };
}

// Returns a stop function. Errors are logged to stderr, never thrown.
export function startMaintenance(ctx, log = (m) => console.error(m)) {
  const tick = () =>
    runMaintenance(ctx).then(
      (r) => {
        const n = r.results.deleted.length + r.exports.deleted.length;
        if (n) log(`cheap-eyes: cleanup removed ${r.results.deleted.length} result(s), ${r.exports.deleted.length} export(s)`);
      },
      (e) => log(`cheap-eyes: cleanup failed: ${e?.message ?? e}`),
    );
  tick();
  const timer = setInterval(tick, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
