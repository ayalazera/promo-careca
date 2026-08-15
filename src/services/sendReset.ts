/**
 * Reset de envios locais (post_logs / status posted / cadência de grupo).
 * Não desfaz mensagens já entregues no WhatsApp — só libera a fila de novo.
 */
import { getDb, getSetting, logAntiBan, setSetting } from "../db/index.js";
import { clearPause, clearWaveCooldown } from "./antiBan.js";
import { BR_TZ } from "./timeBr.js";

export type SendResetScope = "today" | "all" | "group" | "last24h";

export type SendResetResult = {
  ok: true;
  scope: SendResetScope;
  groupId: number | null;
  deletedLogs: number;
  requeuedDeals: number;
  clearedGroupCadence: number;
  clearedCouponAnnouncements: number;
  clearedWaveCooldown: boolean;
  clearedPause: boolean;
  sinceIso: string | null;
};

/** Início do dia civil em Brasília, formato SQLite UTC (`YYYY-MM-DD HH:MM:SS`). */
export function brazilTodayStartUtcIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BR_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  const guess = new Date(`${y}-${m}-${d}T03:00:00.000Z`);
  for (let delta = -5; delta <= 5; delta++) {
    const t = new Date(guess.getTime() + delta * 3600_000);
    const label = new Intl.DateTimeFormat("en-CA", {
      timeZone: BR_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(t);
    const day = `${label.find((p) => p.type === "year")?.value}-${label.find((p) => p.type === "month")?.value}-${label.find((p) => p.type === "day")?.value}`;
    const hour = Number(label.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(label.find((p) => p.type === "minute")?.value || 0);
    if (day === `${y}-${m}-${d}` && hour === 0 && minute === 0) {
      return t.toISOString().replace("T", " ").slice(0, 19);
    }
  }
  return guess.toISOString().replace("T", " ").slice(0, 19);
}

function normalizeSqliteTs(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/\.\d+Z?$/, "")
    .replace(/Z$/, "")
    .slice(0, 19);
}

function tableExists(name: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name) as { x?: number } | undefined;
  return Boolean(row);
}

function ensureResetBackup(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS send_reset_log_backup (
      batch_id TEXT NOT NULL,
      id INTEGER,
      deal_id INTEGER,
      group_id INTEGER,
      message_hash TEXT,
      ok INTEGER,
      reason TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS send_reset_deal_backup (
      batch_id TEXT NOT NULL,
      deal_id INTEGER,
      status TEXT,
      posted_at TEXT
    );
  `);
}

function snapshotResetBatch(opts: {
  scope: SendResetScope;
  groupId: number | null;
  since: string | null;
}): string {
  ensureResetBackup();
  const db = getDb();
  const batchId = new Date().toISOString();
  db.exec(`DELETE FROM send_reset_log_backup`);
  db.exec(`DELETE FROM send_reset_deal_backup`);
  if ((opts.scope === "today" || opts.scope === "last24h") && opts.since) {
    if (opts.groupId) {
      db.prepare(
        `INSERT INTO send_reset_log_backup
         SELECT ?, id, deal_id, group_id, message_hash, ok, reason, created_at
         FROM post_logs WHERE created_at >= ? AND group_id = ?`,
      ).run(batchId, opts.since, opts.groupId);
    } else {
      db.prepare(
        `INSERT INTO send_reset_log_backup
         SELECT ?, id, deal_id, group_id, message_hash, ok, reason, created_at
         FROM post_logs WHERE created_at >= ?`,
      ).run(batchId, opts.since);
    }
  } else if (opts.scope === "group" && opts.groupId) {
    db.prepare(
      `INSERT INTO send_reset_log_backup
       SELECT ?, id, deal_id, group_id, message_hash, ok, reason, created_at
       FROM post_logs WHERE group_id = ?`,
    ).run(batchId, opts.groupId);
  } else {
    db.prepare(
      `INSERT INTO send_reset_log_backup
       SELECT ?, id, deal_id, group_id, message_hash, ok, reason, created_at
       FROM post_logs`,
    ).run(batchId);
  }
  db.prepare(
    `INSERT INTO send_reset_deal_backup
     SELECT ?, d.id, d.status, d.posted_at
     FROM deals d
     WHERE d.id IN (SELECT DISTINCT deal_id FROM send_reset_log_backup WHERE deal_id IS NOT NULL)
        OR (d.status = 'posted' AND ? = 'all')`,
  ).run(batchId, opts.scope);
  setSetting("last_send_reset_batch", batchId);
  return batchId;
}

export function undoLastSendReset(): {
  ok: boolean;
  restoredLogs: number;
  restoredDeals: number;
  error?: string;
} {
  ensureResetBackup();
  const db = getDb();
  const batchId = getSetting("last_send_reset_batch", "");
  if (!batchId) {
    return { ok: false, restoredLogs: 0, restoredDeals: 0, error: "Nenhum reset para desfazer" };
  }
  const logs = db
    .prepare(`SELECT * FROM send_reset_log_backup WHERE batch_id = ?`)
    .all(batchId) as Array<{
    id: number;
    deal_id: number | null;
    group_id: number | null;
    message_hash: string | null;
    ok: number;
    reason: string | null;
    created_at: string;
  }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO post_logs (id, deal_id, group_id, message_hash, ok, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let restoredLogs = 0;
  for (const r of logs) {
    restoredLogs += insert.run(
      r.id,
      r.deal_id,
      r.group_id,
      r.message_hash,
      r.ok,
      r.reason,
      r.created_at,
    ).changes;
  }
  const deals = db
    .prepare(`SELECT * FROM send_reset_deal_backup WHERE batch_id = ?`)
    .all(batchId) as Array<{
    deal_id: number;
    status: string;
    posted_at: string | null;
  }>;
  let restoredDeals = 0;
  const upd = db.prepare(
    `UPDATE deals SET status = ?, posted_at = ? WHERE id = ?`,
  );
  for (const d of deals) {
    restoredDeals += upd.run(d.status, d.posted_at, d.deal_id).changes;
  }
  setSetting("last_send_reset_batch", "");
  logAntiBan("send_reset_undo", `logs=${restoredLogs} deals=${restoredDeals}`);
  return { ok: true, restoredLogs, restoredDeals };
}

export function previewSendReset(opts: {
  scope: SendResetScope;
  groupId?: number | null;
}): {
  scope: SendResetScope;
  groupId: number | null;
  sinceIso: string | null;
  okLogs: number;
  failLogs: number;
  postedDealsAffected: number;
  couponAnnouncements: number;
} {
  const db = getDb();
  const groupId = opts.groupId != null ? Number(opts.groupId) : null;
  const sinceIso =
    opts.scope === "today"
      ? brazilTodayStartUtcIso()
      : opts.scope === "last24h"
        ? new Date(Date.now() - 24 * 3600_000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19)
        : null;
  const since = sinceIso ? normalizeSqliteTs(sinceIso) : null;

  let okLogs = 0;
  let failLogs = 0;
  let postedDealsAffected = 0;
  let couponAnnouncements = 0;

  if ((opts.scope === "today" || opts.scope === "last24h") && since) {
    if (groupId) {
      okLogs = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 1 AND created_at >= ? AND group_id = ?`,
          )
          .get(since, groupId) as { c: number }
      ).c;
      failLogs = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 0 AND created_at >= ? AND group_id = ?`,
          )
          .get(since, groupId) as { c: number }
      ).c;
      postedDealsAffected = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT d.id) AS c FROM deals d
             WHERE d.status = 'posted'
               AND (
                 d.posted_at >= ?
                 OR d.id IN (
                   SELECT deal_id FROM post_logs
                   WHERE ok = 1 AND created_at >= ? AND group_id = ? AND deal_id IS NOT NULL
                 )
               )`,
          )
          .get(since, since, groupId) as { c: number }
      ).c;
    } else {
      okLogs = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 1 AND created_at >= ?`,
          )
          .get(since) as { c: number }
      ).c;
      failLogs = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 0 AND created_at >= ?`,
          )
          .get(since) as { c: number }
      ).c;
      postedDealsAffected = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM deals
             WHERE status = 'posted'
               AND (
                 posted_at >= ?
                 OR id IN (
                   SELECT DISTINCT deal_id FROM post_logs
                   WHERE ok = 1 AND created_at >= ? AND deal_id IS NOT NULL
                 )
               )`,
          )
          .get(since, since) as { c: number }
      ).c;
    }
  } else if (opts.scope === "group" && groupId) {
    okLogs = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 1 AND group_id = ?`,
        )
        .get(groupId) as { c: number }
    ).c;
    failLogs = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM post_logs WHERE ok = 0 AND group_id = ?`,
        )
        .get(groupId) as { c: number }
    ).c;
    postedDealsAffected = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT d.id) AS c FROM deals d
           INNER JOIN post_logs p ON p.deal_id = d.id AND p.ok = 1 AND p.group_id = ?
           WHERE d.status = 'posted'`,
        )
        .get(groupId) as { c: number }
    ).c;
  } else {
    okLogs = (
      db.prepare(`SELECT COUNT(*) AS c FROM post_logs WHERE ok = 1`).get() as {
        c: number;
      }
    ).c;
    failLogs = (
      db.prepare(`SELECT COUNT(*) AS c FROM post_logs WHERE ok = 0`).get() as {
        c: number;
      }
    ).c;
    postedDealsAffected = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM deals WHERE status = 'posted'`)
        .get() as { c: number }
    ).c;
  }

  if (tableExists("coupon_announcements")) {
    if ((opts.scope === "today" || opts.scope === "last24h") && since) {
      couponAnnouncements = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM coupon_announcements WHERE created_at >= ?`,
          )
          .get(since) as { c: number }
      ).c;
    } else if (opts.scope === "group" && groupId) {
      couponAnnouncements = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM coupon_announcements WHERE group_id = ?`,
          )
          .get(groupId) as { c: number }
      ).c;
    } else {
      couponAnnouncements = (
        db.prepare(`SELECT COUNT(*) AS c FROM coupon_announcements`).get() as {
          c: number;
        }
      ).c;
    }
  }

  return {
    scope: opts.scope,
    groupId: opts.scope === "group" ? groupId : null,
    sinceIso,
    okLogs,
    failLogs,
    postedDealsAffected,
    couponAnnouncements,
  };
}

export function resetSends(opts: {
  scope: SendResetScope;
  groupId?: number | null;
  /** Também limpa pausa anti-ban e cooldown de onda */
  clearCadence?: boolean;
  /** Reabre deals posted → queued */
  requeuePosted?: boolean;
  /** Apaga avisos de cupom já marcados (para poder anunciar de novo) */
  clearCouponAnnouncements?: boolean;
}): SendResetResult {
  const db = getDb();
  const scope = opts.scope;
  const groupId = opts.groupId != null ? Number(opts.groupId) : null;
  if (scope === "group" && !groupId) {
    throw new Error("Informe groupId para resetar um grupo");
  }

  const sinceIso =
    scope === "today"
      ? brazilTodayStartUtcIso()
      : scope === "last24h"
        ? new Date(Date.now() - 24 * 3600_000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19)
        : null;
  const since = sinceIso ? normalizeSqliteTs(sinceIso) : null;
  const requeue = opts.requeuePosted !== false;
  const clearCoupon = opts.clearCouponAnnouncements !== false;
  const clearCadence = opts.clearCadence !== false;

  snapshotResetBatch({ scope, groupId, since });

  const dealIds = new Set<number>();
  let deletedLogs = 0;

  if ((scope === "today" || scope === "last24h") && since) {
    if (groupId) {
      for (const r of db
        .prepare(
          `SELECT DISTINCT deal_id AS id FROM post_logs
           WHERE created_at >= ? AND group_id = ? AND deal_id IS NOT NULL`,
        )
        .all(since, groupId) as Array<{ id: number }>) {
        dealIds.add(r.id);
      }
      deletedLogs = db
        .prepare(
          `DELETE FROM post_logs WHERE created_at >= ? AND group_id = ?`,
        )
        .run(since, groupId).changes;
    } else {
      for (const r of db
        .prepare(
          `SELECT DISTINCT deal_id AS id FROM post_logs
           WHERE created_at >= ? AND deal_id IS NOT NULL`,
        )
        .all(since) as Array<{ id: number }>) {
        dealIds.add(r.id);
      }
      deletedLogs = db
        .prepare(`DELETE FROM post_logs WHERE created_at >= ?`)
        .run(since).changes;
    }
  } else if (scope === "group" && groupId) {
    for (const r of db
      .prepare(
        `SELECT DISTINCT deal_id AS id FROM post_logs
         WHERE group_id = ? AND deal_id IS NOT NULL`,
      )
      .all(groupId) as Array<{ id: number }>) {
      dealIds.add(r.id);
    }
    deletedLogs = db
      .prepare(`DELETE FROM post_logs WHERE group_id = ?`)
      .run(groupId).changes;
  } else {
    for (const r of db
      .prepare(
        `SELECT DISTINCT deal_id AS id FROM post_logs WHERE deal_id IS NOT NULL`,
      )
      .all() as Array<{ id: number }>) {
      dealIds.add(r.id);
    }
    deletedLogs = db.prepare(`DELETE FROM post_logs`).run().changes;
  }

  let requeuedDeals = 0;
  if (requeue) {
    if (scope === "all") {
      requeuedDeals = db
        .prepare(
          `UPDATE deals SET status = 'queued', posted_at = NULL
           WHERE status = 'posted'`,
        )
        .run().changes;
    } else if ((scope === "today" || scope === "last24h") && since) {
      const ids = [...dealIds];
      if (ids.length) {
        requeuedDeals = db
          .prepare(
            `UPDATE deals SET status = 'queued', posted_at = NULL
             WHERE status = 'posted'
               AND (
                 posted_at >= ?
                 OR id IN (${ids.map(() => "?").join(",")})
               )`,
          )
          .run(since, ...ids).changes;
      } else {
        requeuedDeals = db
          .prepare(
            `UPDATE deals SET status = 'queued', posted_at = NULL
             WHERE status = 'posted' AND posted_at >= ?`,
          )
          .run(since).changes;
      }
    } else if (scope === "group") {
      for (const id of dealIds) {
        const still = db
          .prepare(
            `SELECT COUNT(*) AS c FROM post_logs WHERE deal_id = ? AND ok = 1`,
          )
          .get(id) as { c: number };
        if (still.c === 0) {
          requeuedDeals += db
            .prepare(
              `UPDATE deals SET status = 'queued', posted_at = NULL
               WHERE id = ? AND status = 'posted'`,
            )
            .run(id).changes;
        }
      }
    }
  }

  let clearedCouponAnnouncements = 0;
  if (clearCoupon && tableExists("coupon_announcements")) {
    if ((scope === "today" || scope === "last24h") && since) {
      clearedCouponAnnouncements = db
        .prepare(`DELETE FROM coupon_announcements WHERE created_at >= ?`)
        .run(since).changes;
    } else if (scope === "group" && groupId) {
      clearedCouponAnnouncements = db
        .prepare(`DELETE FROM coupon_announcements WHERE group_id = ?`)
        .run(groupId).changes;
    } else if (scope === "all") {
      clearedCouponAnnouncements = db
        .prepare(`DELETE FROM coupon_announcements`)
        .run().changes;
    }
  }

  let clearedGroupCadence = 0;
  if (clearCadence) {
    if (scope === "group" && groupId) {
      clearedGroupCadence = db
        .prepare(`UPDATE wa_groups SET last_posted_at = NULL WHERE id = ?`)
        .run(groupId).changes;
    } else {
      clearedGroupCadence = db
        .prepare(`UPDATE wa_groups SET last_posted_at = NULL WHERE active = 1`)
        .run().changes;
    }
    clearWaveCooldown();
    clearPause();
  }

  logAntiBan(
    "send_reset",
    `scope=${scope} group=${groupId ?? "-"} logs=${deletedLogs} requeued=${requeuedDeals}`,
  );
  setSetting("last_send_reset_at", new Date().toISOString());

  return {
    ok: true,
    scope,
    groupId: scope === "group" ? groupId : null,
    deletedLogs,
    requeuedDeals,
    clearedGroupCadence,
    clearedCouponAnnouncements,
    clearedWaveCooldown: clearCadence,
    clearedPause: clearCadence,
    sinceIso,
  };
}
