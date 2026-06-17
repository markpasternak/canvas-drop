import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";

/** Canvas usage stats (D24): view stats + a 30-day sparkline (every canvas), plus
 *  primitive op counts / storage / AI totals (backend-on canvases). The single
 *  implementation behind the management `GET /:id/usage` route and the MCP
 *  `get_canvas_usage` tool, so the metric set + sparkline window can't diverge. */
export async function fetchCanvasUsage(
  deps: { usage: UsageEventsRepository; files: FilesRepository; aiUsage: AiUsageRepository },
  canvasId: string,
) {
  const now = Date.now();
  // The 30-day window sits well inside the 90-day usage_events retention, so the
  // series never truncates.
  const sparklineSince = now - 30 * 24 * 60 * 60 * 1000;
  const [counts, fileBytes, fileCount, ai, views, viewsByDay] = await Promise.all([
    deps.usage.countByType(canvasId, null),
    deps.files.totalBytes(canvasId),
    deps.files.countFiles(canvasId),
    deps.aiUsage.canvasTotals(canvasId),
    deps.usage.viewStats(canvasId),
    deps.usage.viewsByDay(canvasId, sparklineSince, now),
  ]);
  return {
    totalViews: views.totalViews,
    uniqueViewers: views.uniqueViewers,
    lastViewedAt: views.lastViewedAt,
    viewsByDay,
    kvOps: counts.kv_op ?? 0,
    fileOps: counts.file_op ?? 0,
    fileCount,
    fileBytes,
    aiCalls: ai.calls,
    aiTokens: ai.inputTokens + ai.outputTokens,
    aiCostUsd: ai.costUsd,
    realtimeConnects: counts.rt_connect ?? 0,
  };
}
