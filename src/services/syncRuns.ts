/**
 * Histórico persistente do Sync Hub: quando rodou e próxima execução.
 */
import { getDb, getSetting, getSettingNum, setSetting } from "../db/index.js";
import { formatBrDateTime } from "./timeBr.js";

export type SyncRunRow = {
  id: number;
  source: string;
  ok: number;
  listed: number;
  linked: number;
  inserted: number;
  list_added: number;
  error: string | null;
  detail: string | null;
  started_at: string;
  finished_at: string;
};

export function ensureSyncRunsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'hub',
      ok INTEGER NOT NULL DEFAULT 0,
      listed INTEGER NOT NULL DEFAULT 0,
      linked INTEGER NOT NULL DEFAULT 0,
      inserted INTEGER NOT NULL DEFAULT 0,
      list_added INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      detail TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_finished ON sync_runs(finished_at DESC);
  `);
}

export function recordSyncRun(input: {
  source?: string;
  ok: boolean;
  listed?: number;
  linked?: number;
  inserted?: number;
  listAdded?: number;
  error?: string | null;
  detail?: string | null;
  startedAt?: string | Date | null;
}): SyncRunRow {
  ensureSyncRunsTable();
  const started =
    input.startedAt instanceof Date
      ? input.startedAt.toISOString()
      : String(input.startedAt || new Date().toISOString());
  const finished = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO sync_runs
        (source, ok, listed, linked, inserted, list_added, error, detail, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(input.source || "hub").slice(0, 40),
      input.ok ? 1 : 0,
      Number(input.listed) || 0,
      Number(input.linked) || 0,
      Number(input.inserted) || 0,
      Number(input.listAdded) || 0,
      input.error ? String(input.error).slice(0, 400) : null,
      input.detail ? String(input.detail).slice(0, 500) : null,
      started.replace("T", " ").slice(0, 19),
      finished.replace("T", " ").slice(0, 19),
    );
  setSetting("ml_hub_last_sync_at", finished);
  setSetting("ml_hub_last_sync_ok", input.ok ? "1" : "0");
  return getDb()
    .prepare(`SELECT * FROM sync_runs WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as SyncRunRow;
}

export function listSyncRuns(limit = 20): SyncRunRow[] {
  ensureSyncRunsTable();
  return getDb()
    .prepare(
      `SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as SyncRunRow[];
}

export function syncScheduleSnapshot(): {
  lastAt: string | null;
  lastAtBr: string;
  lastOk: boolean | null;
  intervalMinutes: number;
  nextAt: string | null;
  nextAtBr: string;
  autoSync: boolean;
  runs: Array<
    SyncRunRow & {
      startedAtBr: string;
      finishedAtBr: string;
    }
  >;
} {
  ensureSyncRunsTable();
  const intervalMinutes = getSettingNum(
    "ml_hub_sync_interval_minutes",
    360,
    360,
    24 * 60,
  );
  const lastAt = getSetting("ml_hub_last_sync_at", "") || null;
  const lastOkRaw = getSetting("ml_hub_last_sync_ok", "");
  const lastOk =
    lastOkRaw === "" ? null : lastOkRaw === "1";
  let nextAt: string | null = null;
  if (lastAt) {
    const ms = Date.parse(lastAt);
    if (Number.isFinite(ms)) {
      nextAt = new Date(ms + intervalMinutes * 60_000).toISOString();
    }
  }
  const autoSync = getSetting("ml_hub_auto_sync", "0") === "1";
  const runs = listSyncRuns(15).map((r) => ({
    ...r,
    startedAtBr: formatBrDateTime(r.started_at),
    finishedAtBr: formatBrDateTime(r.finished_at),
  }));
  // Se nunca rodou, próxima = agora + intervalo (só informativo)
  if (!nextAt && autoSync) {
    nextAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  }
  return {
    lastAt,
    lastAtBr: lastAt ? formatBrDateTime(lastAt) : "ainda não executou",
    lastOk,
    intervalMinutes,
    nextAt,
    nextAtBr: nextAt ? formatBrDateTime(nextAt) : "— (auto desligado ou sem histórico)",
    autoSync,
    runs,
  };
}
