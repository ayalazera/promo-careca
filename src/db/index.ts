import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { DEFAULT_POST_TEMPLATE } from "../affiliateCatalog.js";

export type Deal = {
  id: number;
  external_id: string;
  source: string;
  title: string;
  description: string;
  category: string;
  price: number;
  old_price: number | null;
  currency: string;
  coupon: string | null;
  coupon_status: "none" | "pending" | "valid" | "invalid" | "expired";
  price_with_coupon: number | null;
  coupon_tested_at: string | null;
  coupon_alert_sent: number;
  image_url: string | null;
  product_url: string;
  affiliate_url: string;
  commission_pct: number | null;
  free_shipping: number;
  seller_id?: string | null;
  seller_name?: string | null;
  stock?: number | null;
  shipping_logistic?: string | null;
    official_store?: number;
    pdp_proof_path?: string | null;
  status: "queued" | "posted" | "skipped" | "failed" | "hold_coupon";
  created_at: string;
  posted_at: string | null;
};

export type WaGroup = {
  id: number;
  name: string;
  jid: string;
  categories: string;
  active: number;
  interval_minutes: number;
  last_posted_at: string | null;
  created_at: string;
  fleet_id: number | null;
  sequence_number: number | null;
  invite_link: string | null;
  participant_count: number;
  is_accepting: number;
  max_participants: number;
  sources: string;
  keywords: string;
  post_template: string;
  notes: string;
  watermark_handle: string;
  watermark_tagline: string;
  watermark_logo_path: string;
  promo_url: string;
  /** classic | neon | pulse | hearth | studio | auto */
  image_layout: string;
  day_limit: number;
  ml_list_id: string;
};

export type GroupFleet = {
  id: number;
  name_prefix: string;
  slug: string;
  categories: string;
  start_number: number;
  current_number: number;
  max_participants: number;
  watermark_handle: string;
  watermark_tagline: string;
  active: number;
  interval_minutes: number;
  created_at: string;
};

export type Setting = { key: string; value: string };

let db: Database.Database | null = null;

function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      price REAL NOT NULL,
      old_price REAL,
      currency TEXT NOT NULL DEFAULT 'BRL',
      coupon TEXT,
      coupon_status TEXT NOT NULL DEFAULT 'none',
      price_with_coupon REAL,
      coupon_tested_at TEXT,
      image_url TEXT,
      product_url TEXT NOT NULL,
      affiliate_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      posted_at TEXT,
      UNIQUE(source, external_id)
    );

    CREATE TABLE IF NOT EXISTS group_fleets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_prefix TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      categories TEXT NOT NULL DEFAULT 'geral',
      start_number INTEGER NOT NULL DEFAULT 1,
      current_number INTEGER NOT NULL DEFAULT 1,
      max_participants INTEGER NOT NULL DEFAULT 950,
      watermark_handle TEXT NOT NULL DEFAULT '@promocoes',
      watermark_tagline TEXT NOT NULL DEFAULT 'O melhor grupo de promoções',
      active INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT ${config.defaultIntervalMinutes},
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wa_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      jid TEXT NOT NULL UNIQUE,
      categories TEXT NOT NULL DEFAULT 'geral',
      active INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT ${config.defaultIntervalMinutes},
      last_posted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fleet_id INTEGER,
      sequence_number INTEGER,
      invite_link TEXT,
      participant_count INTEGER NOT NULL DEFAULT 1,
      is_accepting INTEGER NOT NULL DEFAULT 1,
      max_participants INTEGER NOT NULL DEFAULT 950,
      FOREIGN KEY(fleet_id) REFERENCES group_fleets(id)
    );

    CREATE TABLE IF NOT EXISTS post_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER,
      group_id INTEGER,
      message_hash TEXT,
      ok INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(deal_id) REFERENCES deals(id),
      FOREIGN KEY(group_id) REFERENCES wa_groups(id)
    );

    CREATE TABLE IF NOT EXISTS antiban_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coupon_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER,
      item_id TEXT,
      coupon TEXT NOT NULL,
      ok INTEGER NOT NULL,
      original_price REAL,
      final_price REAL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ml_list_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id TEXT,
      item_id TEXT,
      action TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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

  addColumnIfMissing(db, "deals", "coupon_status", "coupon_status TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(db, "deals", "price_with_coupon", "price_with_coupon REAL");
  addColumnIfMissing(db, "deals", "coupon_tested_at", "coupon_tested_at TEXT");
  addColumnIfMissing(db, "deals", "coupon_alert_sent", "coupon_alert_sent INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "deals", "commission_pct", "commission_pct REAL");
  addColumnIfMissing(db, "deals", "free_shipping", "free_shipping INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "deals", "seller_id", "seller_id TEXT");
  addColumnIfMissing(db, "deals", "seller_name", "seller_name TEXT");
  addColumnIfMissing(db, "deals", "stock", "stock INTEGER");
  addColumnIfMissing(db, "deals", "shipping_logistic", "shipping_logistic TEXT");
  addColumnIfMissing(db, "deals", "official_store", "official_store INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "deals", "pdp_proof_path", "pdp_proof_path TEXT");
  addColumnIfMissing(db, "wa_groups", "day_limit", "day_limit INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "wa_groups", "ml_list_id", "ml_list_id TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "post_logs", "wa_key", "wa_key TEXT");
  addColumnIfMissing(db, "post_logs", "headline_variant", "headline_variant TEXT");
  addColumnIfMissing(db, "wa_groups", "fleet_id", "fleet_id INTEGER");
  addColumnIfMissing(db, "wa_groups", "sequence_number", "sequence_number INTEGER");
  addColumnIfMissing(db, "wa_groups", "invite_link", "invite_link TEXT");
  addColumnIfMissing(db, "wa_groups", "participant_count", "participant_count INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "wa_groups", "is_accepting", "is_accepting INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "wa_groups", "max_participants", "max_participants INTEGER NOT NULL DEFAULT 950");
  addColumnIfMissing(db, "wa_groups", "sources", "sources TEXT NOT NULL DEFAULT 'mercadolivre'");
  addColumnIfMissing(db, "wa_groups", "keywords", "keywords TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "wa_groups", "post_template", "post_template TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "wa_groups", "notes", "notes TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "wa_groups", "watermark_handle", "watermark_handle TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "wa_groups", "watermark_tagline", "watermark_tagline TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "wa_groups", "watermark_logo_path", "watermark_logo_path TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "wa_groups", "promo_url", "promo_url TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(
    db,
    "wa_groups",
    "image_layout",
    "image_layout TEXT NOT NULL DEFAULT 'auto'",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS post_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const defaults: Array<[string, string]> = [
    ["scheduler_enabled", "1"],
    ["fetch_interval_minutes", "25"],
    ["demo_mode", config.demoMode ? "1" : "0"],
    ["account_started_at", new Date().toISOString()],
    ["paused_until", ""],
    ["last_wave_at", ""],
    ["wave_count", "0"],
    ["brand_handle", "@carecavip"],
    ["brand_tagline", "O melhor grupo de promoções da internet"],
    ["brand_group_name", "Careca VIP"],
    ["require_coupon_test", "1"],
    ["public_base_url", `http://localhost:${config.port}`],
    ["coupon_revalidate_minutes", "25"],
    ["enabled_sources", "mercadolivre"],
    ["ml_hub_min_commission", "10"],
    ["ml_hub_sync_limit", "24"],
    ["ml_hub_auto_sync", "0"],
    ["ml_hub_sync_interval_minutes", "360"],
    ["ml_hub_link_delay_ms", "9000"],
    ["ml_api_gap_ms", "1500"],
    ["ml_input_code_gap_ms", "20000"],
    ["ml_rate_limit_cool_min", "35"],
    ["coupon_live_cache_min", "25"],
    ["ml_hub_link_aggressive", "0"],
    ["ml_hub_enrich_coupons_on_sync", "0"],
    ["harvest_max_coupons", "10"],
    ["harvest_max_items", "14"],
    ["harvest_mint_links", "20"],
    ["sync_quota_tcg", "8"],
    ["sync_quota_electronics", "8"],
    ["ml_list_push_products", "0"],
    ["auto_publish_on_coupon_valid", "0"],
    ["ml_hub_supplement_catalog", "0"],
    ["ml_hub_import_list", "0"],
    ["ml_hub_electronics_only", "0"],
    ["ml_hub_prioritize_electronics", "0"],
    ["ml_list_push_max_per_sync", "6"],
    ["ml_list_auto_push", "1"],
    ["ml_list_auto_push_interval_minutes", "50"],
    ["ml_list_prune_enabled", "1"],
    ["ml_list_prune_times_per_day", "2"],
    ["ml_list_prune_last_at", ""],
    ["send_weekday_start", "09:30"],
    ["send_weekday_end", "21:30"],
    ["send_weekend_start", "10:00"],
    ["send_weekend_end", "20:00"],
    ["send_weekday_day_limit", "90"],
    ["send_weekend_day_limit", "70"],
    ["send_weekday_hour_limit", "16"],
    ["send_weekend_hour_limit", "12"],
    ["send_sunday_day_limit", "45"],
    ["post_max_groups_per_wave", "1"],
    ["post_inter_group_delay_sec", "60"],
    ["cadence_warmup", "0"],
    ["maintenance_mode", "0"],
    ["lunch_silence", "0"],
    ["post_hashtag", "0"],
    ["post_flash_peak", "1"],
    ["holiday_silence", "1"],
    ["tcg_official_only", "0"],
    ["require_meli_la", "1"],
    ["tcg_day_limit", "45"],
    ["electronics_day_limit", "55"],
    ["achadinhos_day_limit", "90"],
    ["warmup_week1_cap", "40"],
    ["cadence_interval_min_sec", "240"],
    ["cadence_interval_max_sec", "480"],
    ["cadence_interval_locked", "1"],
    ["stock_warn_max", "8"],
    ["price_rise_skip_pct", "15"],
    ["reprint_min_price", "180"],
    ["reprint_min_discount_pct", "8"],
    ["lunch_start", "12:00"],
    ["lunch_end", "13:30"],
    ["http_block_pause_after", "3"],
    ["ml_list_target_tcg", "40"],
    ["ml_list_target_games", "24"],
    ["ml_list_target_casa", "24"],
    ["ml_list_target_eletronicos", "36"],
    ["ml_list_target_geral", "48"],
    ["repost_cooldown_days", "5"],
    ["fashion_hourly_cap", "3"],
    ["queue_refill_below", "15"],
    ["moda_coupon_rotate", "SEMPREMODA,MODANOMELI,OFFMELI"],
    ["electronics_coupon_prefer", "ECONOMIAML,TECHEMCASA"],
    ["tcg_coupon_prefer", "BRINQUEDOS,LIVROS"],
  ];

  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  for (const [k, v] of defaults) insertSetting.run(k, v);

  if (getSetting("ml_list_prune_bumped", "") !== "1") {
    const cur = getSetting("ml_list_prune_times_per_day", "1");
    if (cur === "1") {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run("ml_list_prune_times_per_day", "2");
    }
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run("ml_list_prune_bumped", "1");
  }

  // Cadência ML conservadora: só INSERT OR IGNORE nos defaults acima.
  // NÃO forçar electronics_only / push=0 a cada boot (apagava preferências do usuário).
  const upsertSetting = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  // Soft caps: Sync ≤24 createLinks (humano) com delay ≥6.5s; nunca rajada tipo extensão
  const syncLimit = Number(getSetting("ml_hub_sync_limit", "24")) || 24;
  if (!Number.isFinite(syncLimit) || syncLimit < 1) {
    upsertSetting.run("ml_hub_sync_limit", "24");
  } else if (syncLimit > 24) {
    upsertSetting.run("ml_hub_sync_limit", "24");
  }
  // bump único: bases antigas travadas em ≤8
  if (getSetting("volume_bump_v1", "") !== "1") {
    const cur = Number(getSetting("ml_hub_sync_limit", "24")) || 24;
    if (cur < 16) upsertSetting.run("ml_hub_sync_limit", "24");
    upsertSetting.run("harvest_max_coupons", getSetting("harvest_max_coupons", "10") || "10");
    upsertSetting.run("harvest_max_items", getSetting("harvest_max_items", "14") || "14");
    upsertSetting.run("harvest_mint_links", getSetting("harvest_mint_links", "20") || "20");
    upsertSetting.run("volume_bump_v1", "1");
  }
  const linkDelay = Number(getSetting("ml_hub_link_delay_ms", "9000")) || 9000;
  if (linkDelay < 8000) upsertSetting.run("ml_hub_link_delay_ms", "9000");
  if (getSetting("ml_pace_bump_v1", "") !== "1") {
    upsertSetting.run("ml_hub_link_delay_ms", "9000");
    upsertSetting.run("ml_api_gap_ms", "1500");
    upsertSetting.run("coupon_revalidate_minutes", "25");
    upsertSetting.run("ml_pace_bump_v1", "1");
  }
  const syncInterval =
    Number(getSetting("ml_hub_sync_interval_minutes", "360")) || 360;
  if (syncInterval < 360) {
    upsertSetting.run("ml_hub_sync_interval_minutes", "360");
  }
  // bump único: trava ritmo humano vs flood de extensão Chrome
  if (getSetting("human_pace_lock_v1", "") !== "1") {
    upsertSetting.run("ml_hub_sync_interval_minutes", "360");
    upsertSetting.run("ml_hub_sync_limit", "24");
    upsertSetting.run("cadence_interval_min_sec", "240");
    upsertSetting.run("cadence_interval_max_sec", "480");
    upsertSetting.run("cadence_interval_locked", "1");
    upsertSetting.run("post_max_groups_per_wave", "1");
    upsertSetting.run("post_inter_group_delay_sec", "60");
    upsertSetting.run("ml_hub_link_aggressive", "0");
    getDb()
      .prepare(
        `UPDATE wa_groups SET interval_minutes = 5 WHERE active = 1 AND (interval_minutes IS NULL OR interval_minutes < 4 OR interval_minutes > 10)`,
      )
      .run();
    upsertSetting.run("human_pace_lock_v1", "1");
  }
  const pushMax = Number(getSetting("ml_list_push_max_per_sync", "6")) || 6;
  // Defaults antigos (2–3) deixavam TCG/Games com 1–2 itens nas listas
  if (pushMax < 4) upsertSetting.run("ml_list_push_max_per_sync", "6");
  else if (pushMax > 24) upsertSetting.run("ml_list_push_max_per_sync", "20");
  upsertSetting.run("ml_hub_link_aggressive", "0");
  // enrich no sync continua off (requests); harvest separado enche cupons
  upsertSetting.run("ml_hub_enrich_coupons_on_sync", "0");
  // Remover flags mortas que enviesavam tudo para eletrônicos
  if (getSetting("ml_hub_electronics_only", "") === "1") {
    upsertSetting.run("ml_hub_electronics_only", "0");
  }
  if (getSetting("ml_hub_prioritize_electronics", "") === "1") {
    upsertSetting.run("ml_hub_prioritize_electronics", "0");
  }
  // tabela official_stores é criada/seed sob demanda em mlOfficialStores.ts
  // Corrige nome curto legado "Careca VIP" → nome real da lista
  const oldName = db
    .prepare(`SELECT value FROM settings WHERE key = 'ml_social_list_name'`)
    .get() as { value?: string } | undefined;
  if (
    !oldName?.value ||
    /^careca vip$/i.test(oldName.value) ||
    /^ir para/i.test(oldName.value)
  ) {
    upsertSetting.run("ml_social_list_name", "Careca VIP Eletrônicos");
  }

  // Grupo Eletrônicos: tech puro (sem eletrodomésticos misturados na fila).
  try {
    db.prepare(
      `UPDATE wa_groups
       SET categories = 'eletronicos,celulares,informatica'
       WHERE id = 5
         AND (
           categories LIKE '%eletrodomesticos%'
           OR categories LIKE '%geral%'
           OR categories LIKE '%games%'
         )`,
    ).run();
  } catch {
    /* ignore */
  }
  const oldPush = db
    .prepare(`SELECT value FROM settings WHERE key = 'ml_list_push_electronics'`)
    .get() as { value?: string } | undefined;
  if (oldPush?.value != null) {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('ml_list_push_products', ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(oldPush.value);
  }

  const tplCount = db.prepare("SELECT COUNT(*) AS c FROM post_templates").get() as {
    c: number;
  };
  if (tplCount.c === 0) {
    db.prepare(
      `INSERT INTO post_templates (name, body) VALUES (?, ?), (?, ?)`,
    ).run(
      "Canal clássico (anexo)",
      DEFAULT_POST_TEMPLATE,
      "Curto e direto",
      `*{{title}}*\n\n~{{old_price}}~ → *{{price}}*\n{{coupon_line}}\n{{link}}`,
    );
  }

  return db;
}

export function getSetting(key: string, fallback = ""): string {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as Setting | undefined;
  return row?.value ?? fallback;
}

export function getSettingNum(
  key: string,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const n = Number(getSetting(key, String(fallback)));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function logAntiBan(eventType: string, detail: string): void {
  getDb()
    .prepare(
      "INSERT INTO antiban_events (event_type, detail) VALUES (?, ?)",
    )
    .run(eventType, detail);
}

export function countSendsSince(
  isoFrom: string,
  opts?: { groupId?: number },
): number {
  if (opts?.groupId != null) {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM post_logs
         WHERE ok = 1 AND group_id = ? AND created_at >= ?`,
      )
      .get(opts.groupId, isoFrom) as { c: number };
    return row.c;
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM post_logs
       WHERE ok = 1 AND created_at >= ?`,
    )
    .get(isoFrom) as { c: number };
  return row.c;
}
