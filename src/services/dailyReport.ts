import { getDb } from "../db/index.js";
import { isoSinceBrazilMidnight } from "./timeBr.js";

export function dailySendReport(): {
  sent: number;
  blocked: number;
  byReason: Array<{ reason: string; n: number }>;
} {
  const since = isoSinceBrazilMidnight();
  const sent = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 1 AND created_at >= ?`,
      )
      .get(since) as { c: number }
  ).c;
  const blocked = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 0 AND created_at >= ?`,
      )
      .get(since) as { c: number }
  ).c;
  const byReason = getDb()
    .prepare(
      `SELECT COALESCE(reason, '—') AS reason, COUNT(*) AS n
       FROM post_logs
       WHERE ok = 0 AND created_at >= ?
       GROUP BY reason
       ORDER BY n DESC
       LIMIT 8`,
    )
    .all(since) as Array<{ reason: string; n: number }>;
  return { sent, blocked, byReason };
}
