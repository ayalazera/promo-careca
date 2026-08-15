/**
 * Cupons do Mercado Livre (página /cupons — smart-coupons).
 *
 * API oficial OAuth só cobre campanhas do vendedor (seller-promotions /
 * SELLER_COUPON_CAMPAIGN). O feed público de cupons do comprador usa a API
 * interna autenticada por sessão: GET /cupons/api/main-data/*
 *
 * Fluxo:
 * 1) Sync catálogo (landing + verticais + páginas filtered)
 * 2) Match melhor cupom por categoria/título/preço
 * 3) Validar na lista do cupom (lista.mercadolivre + coupon_campaign_id)
 * 4) Gravar no deal e revalidar preço
 */
import { getMercadoLivreCreds } from "./credentialVault.js";
import { getDb, getSetting, logAntiBan, setSetting } from "../db/index.js";
import { applyCouponTestToDeal } from "./couponTester.js";
import { couponAllowedForDealCategory, couponCodesMatch } from "./couponCategories.js";
import {
  formatCouponQtyDescBit,
  minUnitsForCouponMin,
  quoteCouponCart,
  scrubCouponDescTips,
} from "./couponPricing.js";

function hubSessionReady(): boolean {
  const c = getMercadoLivreCreds();
  return Boolean(c.hubCookie && c.hubCsrf && (c.hubTag || c.affiliateTag));
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const BASE = "https://www.mercadolivre.com.br/cupons/api";

/** Categoria app → chave vertical da página de cupons */
const CATEGORY_VERTICAL: Record<string, string[]> = {
  eletronicos: ["ce_vertical", "price", "percentage"],
  celulares: ["ce_vertical", "price", "percentage"],
  informatica: ["ce_vertical", "price", "percentage"],
  games: ["et_vertical", "ce_vertical", "percentage"],
  casa: ["hi_vertical", "percentage"],
  eletrodomesticos: ["hi_vertical", "percentage"],
  moda: ["fa_vertical", "percentage"],
  beleza: ["bh_vertical", "percentage"],
  tcg: ["tb_vertical", "et_vertical", "percentage"],
  brinquedos: ["tb_vertical", "percentage"],
  bebes: ["tb_vertical", "percentage"],
  esportes: ["as_vertical", "percentage"],
  alimentos: ["cpg_vertical", "percentage"],
  veiculos: ["acc_vertical", "percentage"],
  geral: ["percentage", "price", "ce_vertical", "hi_vertical"],
};

export type MlCoupon = {
  campaignId: string;
  code: string | null;
  title: string;
  subtitle: string | null;
  status: string;
  discountType: "percent" | "fixed" | "unknown";
  discountValue: number;
  minAmount: number | null;
  capAmount: number | null;
  listUrl: string | null;
  expiresAt: string | null;
  startsAt: string | null;
  sampleTitles: string[];
  verticalHint: string | null;
  rawScoreBonus: number;
  testedOk?: number | null;
  testedAt?: string | null;
  testedDetail?: string | null;
  lastAnnouncedStatus?: string | null;
  lastAnnouncedAt?: string | null;
};

function couponHeaders(): HeadersInit {
  const c = getMercadoLivreCreds();
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "User-Agent": UA,
    Origin: "https://www.mercadolivre.com.br",
    Referer: "https://www.mercadolivre.com.br/cupons",
    Cookie: c.hubCookie || "",
    "x-csrf-token": c.hubCsrf || "",
    "Content-Type": "application/json",
  };
}

function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).replace(/\./g, "").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Código que o comprador digita no ML (OFFMELI, ECONOMIAML…).
 * NÃO são códigos: "25%OFF", "40% OFF", "R$20OFF" — isso é só o título da campanha.
 */
export function isDigitableCouponCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.trim().toUpperCase().replace(/\s+/g, "");
  if (c.length < 3 || c.length > 40) return false;
  // rótulos inventados a partir do % da campanha
  if (/^\d+%?OFF$/.test(c)) return false;
  if (/^R\$?\d+OFF$/.test(c)) return false;
  if (/^\d+%$/.test(c)) return false;
  if (c.includes("=")) return false;
  // precisa começar com letra (códigos ML reais)
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(c);
}

/** Palavras / marcas do título que NÃO são cupom digitável. */
const TITLE_CODE_NOISE = new Set([
  "CUPOM",
  "OFF",
  "BRAND",
  "TROCA",
  "FACIL",
  "FÁCIL",
  "INTERNACIONAL",
  "MERCADOLIVRE",
  "LIQUIDA",
  "AQUI",
  "REVISAO",
  "REVISÃO",
  "OLEO",
  "ÓLEO",
  "MODA",
  "CASA",
  "PRODUTOS",
  "SELECIONADOS",
  "ITENS",
  "SMARTPHONES",
  "ELETRONICOS",
  "ELETRÔNICOS",
  "BELEZA",
  "FRETE",
  "GRATIS",
  "GRÁTIS",
  "OFERTA",
  "OFERTAS",
  "FASHION",
  "STANLEY",
  "RENAULT",
  "PHILIPS",
  "CAPACETE",
  "BASICS",
  "CELULAR",
  "NOTEBOOK",
  "PRODUTO",
  "DESCONTO",
  "PROMO",
  "EM",
  "NO",
  "NA",
  "DE",
  "PARA",
  "COM",
  "ATE",
  "ATÉ",
  "MIN",
]);

/**
 * Extrai código digitável do título só em padrão explícito:
 * “20% OFF com PREFERIDO”, “15% OFF com LIBROS1208”.
 * Não usa “OFF MARCA” / “em MARCA” — gera falsos positivos (FASHION, STANLEY…).
 */
export function extractCouponCodeFromTitle(
  title: string | null | undefined,
): string | null {
  const t = String(title || "").trim();
  if (!t) return null;
  const m = t.match(/\b(?:com|with)\s+([A-Z][A-Z0-9_]{4,30})\b/i);
  if (!m?.[1]) return null;
  const cand = String(m[1]).trim().toUpperCase().replace(/\s+/g, "");
  if (!isDigitableCouponCode(cand)) return null;
  if (TITLE_CODE_NOISE.has(cand)) return null;
  // Códigos ML reais: ≥6 chars, ou misturam número (LIBROS1208)
  if (cand.length < 6 && !/\d/.test(cand)) return null;
  return cand;
}

/** Remove códigos gravados por extração antiga (marca no título ≠ “com CODE”). */
export function scrubFalsePositiveCouponCodes(): number {
  ensureCouponsTable();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT campaign_id, code, title FROM ml_coupons
       WHERE code IS NOT NULL AND TRIM(code) != ''`,
    )
    .all() as Array<{ campaign_id: string; code: string; title: string }>;
  const upd = db.prepare(
    `UPDATE ml_coupons SET code = NULL, updated_at = datetime('now') WHERE campaign_id = ?`,
  );
  let n = 0;
  for (const r of rows) {
    const code = String(r.code || "").toUpperCase().trim();
    if (!code) continue;
    const title = String(r.title || "");
    const explicit = new RegExp(`\\b(?:com|with)\\s+${code}\\b`, "i").test(
      title,
    );
    if (explicit) continue;
    // Mantém códigos colados após OFF só se parecerem campanha (longos / com dígito / MELI…)
    const glued = new RegExp(
      `(?:%\\s*OFF|R\\$\\s*[\\d.,]+\\s*OFF)\\s+${code}\\b`,
      "i",
    ).test(title);
    const looksCampaign =
      code.length >= 10 ||
      /\d/.test(code) ||
      /MELI|CUPOM|PROMO|OFF|HOUSE|BRINDE|COMPRA|QUERO|SEMPRE|APROVEITA|CORRE|ECONOMIA|LIBROS|JOGOS/i.test(
        code,
      );
    if (glued && looksCampaign) continue;
    if (
      TITLE_CODE_NOISE.has(code) ||
      !looksCampaign ||
      (!/\d/.test(code) && code.length <= 8)
    ) {
      upd.run(r.campaign_id);
      n++;
    }
  }
  if (n) {
    logAntiBan("ml_coupons_scrub_codes", `cleared=${n}`);
  }
  return n;
}

function isShareableCode(code: string | null | undefined): boolean {
  return isDigitableCouponCode(code);
}

export function parseCouponFromApiCard(
  raw: Record<string, unknown>,
  verticalHint: string | null = null,
): MlCoupon | null {
  return parseCoupon(raw, verticalHint);
}

function parseCoupon(raw: Record<string, unknown>, verticalHint: string | null = null): MlCoupon | null {
  const campaignId = String(raw.campaignId || raw.campaign_id || "").trim();
  if (!campaignId) return null;

  const titleObj = (raw.title || {}) as { text?: string; accessibility?: { title?: { fractionalAmount?: string; label?: string } } };
  const title = String(titleObj.text || "").trim();
  if (!title) return null;

  const status = String((raw.status as { id?: string } | undefined)?.id || "UNKNOWN").toUpperCase();
  const rawCode = String(raw.code || raw.inputCode || "").trim();
  const fromField = isShareableCode(rawCode) ? rawCode.toUpperCase() : null;
  const fromTitle = extractCouponCodeFromTitle(title);
  const code = fromField || fromTitle;

  const amount = (raw.amount || {}) as {
    minAmount?: string;
    capAmount?: string;
    accessibility?: {
      minAmount?: { fractionalAmount?: string };
      capAmount?: { fractionalAmount?: string };
    };
  };
  const minAmount =
    parseMoney(amount.accessibility?.minAmount?.fractionalAmount) ??
    parseMoney(amount.minAmount);
  const capAmount =
    parseMoney(amount.accessibility?.capAmount?.fractionalAmount) ??
    parseMoney(amount.capAmount);

  const frac = Number(titleObj.accessibility?.title?.fractionalAmount || NaN);
  let discountType: MlCoupon["discountType"] = "unknown";
  let discountValue = 0;

  const pctMatch = title.match(/(\d+(?:[.,]\d+)?)\s*%\s*OFF/i);
  const fixedMatch = title.match(/R\$\s*([\d.]+(?:,\d+)?)\s*OFF/i);
  if (pctMatch) {
    discountType = "percent";
    discountValue = Number(pctMatch[1].replace(",", "."));
  } else if (fixedMatch || (/OFF/i.test(title) && Number.isFinite(frac) && !/%/.test(title))) {
    discountType = "fixed";
    discountValue = Number.isFinite(frac)
      ? frac
      : parseMoney(fixedMatch?.[1] || "") || 0;
  } else if (Number.isFinite(frac) && frac > 0 && frac <= 90) {
    discountType = "percent";
    discountValue = frac;
  }

  const action = (raw.action || {}) as { value?: string };
  const listUrl = action.value ? String(action.value) : null;

  const future = (raw.futureCouponInfo || {}) as {
    expiration_date?: string;
    start_date?: string;
  };

  const items = Array.isArray(raw.items) ? raw.items : [];
  const sampleTitles = items
    .map((it) => String((it as { altText?: string }).altText || "").trim())
    .filter(Boolean)
    .slice(0, 8);

  const subtitle = String(
    (raw.initialSubtitle as { text?: string } | undefined)?.text || "",
  ).trim() || null;

  return {
    campaignId,
    code,
    title,
    subtitle,
    status,
    discountType,
    discountValue,
    minAmount,
    capAmount,
    listUrl,
    expiresAt: future.expiration_date || null,
    startsAt: future.start_date || null,
    sampleTitles,
    verticalHint,
    rawScoreBonus: code && fromTitle && !fromField ? 1 : 0,
  };
}

async function fetchJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    headers: couponHeaders(),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function ensureCouponsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ml_coupons (
      campaign_id TEXT PRIMARY KEY,
      code TEXT,
      title TEXT NOT NULL,
      subtitle TEXT,
      status TEXT NOT NULL,
      discount_type TEXT NOT NULL,
      discount_value REAL NOT NULL DEFAULT 0,
      min_amount REAL,
      cap_amount REAL,
      list_url TEXT,
      expires_at TEXT,
      starts_at TEXT,
      sample_titles TEXT,
      vertical_hint TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const cols = getDb()
    .prepare(`PRAGMA table_info(ml_coupons)`)
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  const add = (name: string, ddl: string) => {
    if (have.has(name)) return;
    getDb().exec(`ALTER TABLE ml_coupons ADD COLUMN ${ddl}`);
  };
  add("tested_ok", "tested_ok INTEGER");
  add("tested_at", "tested_at TEXT");
  add("tested_detail", "tested_detail TEXT");
  add("last_announced_status", "last_announced_status TEXT");
  add("last_announced_at", "last_announced_at TEXT");
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS deal_coupon_matches (
      deal_id INTEGER PRIMARY KEY,
      campaign_id TEXT,
      code TEXT,
      title TEXT,
      score REAL,
      validated INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function upsertCouponRow(c: MlCoupon): void {
  ensureCouponsTable();
  getDb()
    .prepare(
      `INSERT INTO ml_coupons (
         campaign_id, code, title, subtitle, status, discount_type, discount_value,
         min_amount, cap_amount, list_url, expires_at, starts_at, sample_titles,
         vertical_hint, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(campaign_id) DO UPDATE SET
         code = COALESCE(excluded.code, ml_coupons.code),
         title = excluded.title,
         subtitle = excluded.subtitle,
         status = excluded.status,
         discount_type = excluded.discount_type,
         discount_value = excluded.discount_value,
         min_amount = excluded.min_amount,
         cap_amount = excluded.cap_amount,
         list_url = COALESCE(excluded.list_url, ml_coupons.list_url),
         expires_at = excluded.expires_at,
         starts_at = excluded.starts_at,
         sample_titles = excluded.sample_titles,
         vertical_hint = COALESCE(excluded.vertical_hint, ml_coupons.vertical_hint),
         updated_at = datetime('now')`,
    )
    .run(
      c.campaignId,
      c.code,
      c.title,
      c.subtitle,
      c.status,
      c.discountType,
      c.discountValue,
      c.minAmount,
      c.capAmount,
      c.listUrl,
      c.expiresAt,
      c.startsAt,
      JSON.stringify(c.sampleTitles),
      c.verticalHint,
    );
}

export async function fetchCouponsFiltered(opts: {
  page?: number;
  key?: string | null;
  allCoupons?: boolean;
}): Promise<{
  coupons: MlCoupon[];
  totalPages: number;
  total: number;
  sessionExpired?: boolean;
}> {
  const page = opts.page || 1;
  let url: string;
  if (opts.key) {
    const k = opts.key;
    url = `${BASE}/main-data/filtered?page=${page}&keys=${encodeURIComponent(k)}&${encodeURIComponent(k)}=true&source_page=view_more_grouping`;
  } else if (opts.allCoupons) {
    url = `${BASE}/main-data/filtered?page=${page}&origin=coupons&all_coupons=true`;
  } else {
    url = `${BASE}/main-data/landing`;
  }

  const { status, json } = await fetchJson(url);
  if (status === 301 || status === 302 || status === 401 || status === 403) {
    return { coupons: [], totalPages: 0, total: 0, sessionExpired: true };
  }
  if (status !== 200 || !json) {
    return { coupons: [], totalPages: 0, total: 0 };
  }

  const rawList: unknown[] = [];
  if (Array.isArray(json.coupons)) rawList.push(...json.coupons);
  if (Array.isArray(json.groupings)) {
    for (const g of json.groupings) {
      const key = String(g.key || "");
      for (const c of g.coupons || []) {
        const parsed = parseCoupon(c, key || null);
        if (parsed) {
          parsed.rawScoreBonus = key === "percentage" || key === "price" ? 2 : 1;
          rawList.push({ __parsed: parsed });
        }
      }
    }
  }

  const coupons: MlCoupon[] = [];
  for (const raw of rawList) {
    if (raw && typeof raw === "object" && "__parsed" in (raw as object)) {
      coupons.push((raw as { __parsed: MlCoupon }).__parsed);
      continue;
    }
    const parsed = parseCoupon(raw as Record<string, unknown>, opts.key || null);
    if (parsed) coupons.push(parsed);
  }

  return {
    coupons,
    totalPages: Number(json.pagination?.total || 1),
    total: Number(json.totalCouponsQuantity?.number || coupons.length),
  };
}

/** Sync catálogo de cupons (landing + verticais principais + top páginas). */
export async function syncMlCouponsCatalog(opts?: {
  maxPagesPerKey?: number;
  keys?: string[];
  /** all = completo · new = Novos (landing) · popular = Mais usados (% e R$) */
  mode?: "all" | "new" | "popular";
  /** Se true, testa códigos e anuncia (pesado). Padrão: false. */
  testAndAnnounce?: boolean;
}): Promise<{
  ok: boolean;
  fetched: number;
  stored: number;
  active: number;
  withCode?: number;
  totalReported: number;
  mode?: string;
  tips?: {
    scraped: number;
    resolved: number;
    stored: number;
    newCodes: string[];
    usable: string[];
    soldOut: string[];
  };
  error?: string;
}> {
  if (!hubSessionReady()) {
    return {
      ok: false,
      fetched: 0,
      stored: 0,
      active: 0,
      totalReported: 0,
      error: "Sessão do Hub necessária (Cookie/CSRF) para /cupons/api",
    };
  }

  ensureCouponsTable();
  const mode = opts?.mode || "all";
  const maxPages = Math.max(
    1,
    Math.min(opts?.maxPagesPerKey ?? (mode === "all" ? 6 : 3), 20),
  );
  const keys =
    opts?.keys ||
    (mode === "popular"
      ? ["percentage", "price"]
      : mode === "new"
        ? []
        : [
            "percentage",
            "price",
            "ce_vertical",
            "hi_vertical",
            "fa_vertical",
            "tb_vertical",
            "bh_vertical",
            "as_vertical",
            "cpg_vertical",
            "acc_vertical",
            "et_vertical",
            // Verticais extras (livros/coleções/bebês/beleza/moda) —
            // cupons tip (LIBROS*) às vezes só aparecem aqui ou via input-code.
            "antiques_and_collections",
            "toys_and_babys",
            "beauty_and_health",
            "shoes_and_clothes",
          ]);

  const byId = new Map<string, MlCoupon>();
  let totalReported = 0;

  // Landing = “Novos” / destaques da página /cupons
  const landing = await fetchCouponsFiltered({});
  if (landing.sessionExpired) {
    return {
      ok: false,
      fetched: 0,
      stored: 0,
      active: 0,
      totalReported: 0,
      mode,
      error:
        "Sessão do Hub expirada ao ler /cupons. Atualize Cookie e x-csrf-token em Contas (F12 → createLink).",
    };
  }
  totalReported = Math.max(totalReported, landing.total);
  for (const c of landing.coupons) byId.set(c.campaignId, c);

  // Meus cupons = códigos já ativados (PREFERIDO, APROVEITA…) que o feed
  // filtered às vezes não destaca — sem gastar cota do input-code.
  try {
    const mine = await fetchJson(`${BASE}/main-data/my-coupons`);
    if (mine.status === 200 && mine.json) {
      const raw: unknown[] = [];
      if (Array.isArray(mine.json.coupons)) raw.push(...mine.json.coupons);
      if (Array.isArray(mine.json.groupings)) {
        for (const g of mine.json.groupings) {
          for (const c of g.coupons || []) raw.push(c);
        }
      }
      for (const r of raw) {
        const parsed = parseCoupon(r as Record<string, unknown>, "my_coupons");
        if (!parsed) continue;
        const prev = byId.get(parsed.campaignId);
        if (!prev || (!prev.code && parsed.code)) byId.set(parsed.campaignId, parsed);
      }
    }
  } catch (err) {
    logAntiBan(
      "ml_coupons_my_sync_err",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (mode !== "new") {
    for (const key of keys) {
      for (let page = 1; page <= maxPages; page++) {
        const batch = await fetchCouponsFiltered({ page, key });
        totalReported = Math.max(totalReported, batch.total);
        for (const c of batch.coupons) {
          const prev = byId.get(c.campaignId);
          if (!prev || (!prev.code && c.code)) byId.set(c.campaignId, c);
        }
        if (page >= batch.totalPages) break;
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 600));
      }
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 400));
    }

    if (mode === "all") {
      // Catálogo completo ~80–100 páginas (~30/pág, ~2600+). Varre até totalPages.
      const probe = await fetchCouponsFiltered({ page: 1, allCoupons: true });
      totalReported = Math.max(totalReported, probe.total);
      const totalPages = Math.min(
        Math.max(Number(probe.totalPages) || 1, 1),
        120,
      );
      for (let page = 1; page <= totalPages; page++) {
        const batch =
          page === 1
            ? probe
            : await fetchCouponsFiltered({ page, allCoupons: true });
        totalReported = Math.max(totalReported, batch.total);
        for (const c of batch.coupons) {
          const prev = byId.get(c.campaignId);
          if (!prev) {
            byId.set(c.campaignId, c);
          } else if (!prev.code && c.code) {
            byId.set(c.campaignId, c);
          } else if (c.code && prev.code && c.code !== prev.code) {
            byId.set(c.campaignId, { ...prev, ...c, code: c.code });
          } else {
            byId.set(c.campaignId, {
              ...c,
              code: prev.code || c.code,
            });
          }
        }
        if (page >= batch.totalPages) break;
        await new Promise((r) => setTimeout(r, 280 + Math.random() * 220));
      }
    }
  }

  let stored = 0;
  let active = 0;
  for (const c of byId.values()) {
    upsertCouponRow(c);
    stored++;
    if (c.status === "ACTIVE") active++;
  }

  // Tips / input-code: pega LIBROS*, TechTudo, Cuponomia — o feed filtered
  // NÃO lista vários códigos digitáveis (só aparecem ao digitar).
  let tips:
    | Awaited<
        ReturnType<
          typeof import("./couponTipDiscovery.js").discoverAndIngestTipCoupons
        >
      >
    | undefined;
  try {
    const { discoverAndIngestTipCoupons } = await import(
      "./couponTipDiscovery.js"
    );
    tips = await discoverAndIngestTipCoupons({
      maxResolve: mode === "new" ? 10 : mode === "all" ? 22 : 8,
      // LIBROS* só sob demanda / tip tick — evita rate-limit no Sync Todos
      forceCodes: [],
    });
    if (tips?.stored) {
      stored += tips.stored;
      active += tips.usable.length;
    }
  } catch (err) {
    logAntiBan(
      "ml_coupons_tip_sync_err",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Limpa marcas gravadas como “código” (FASHION, STANLEY…) — depois do upsert
  // porque COALESCE no UPDATE preserva code antigo se o novo vier null.
  scrubFalsePositiveCouponCodes();
  const withCodeFinal = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM ml_coupons
         WHERE code IS NOT NULL AND TRIM(code) != ''`,
      )
      .get() as { c: number }
  ).c;
  const storedFinal = (
    getDb().prepare(`SELECT COUNT(*) AS c FROM ml_coupons`).get() as {
      c: number;
    }
  ).c;
  const activeFinal = (
    getDb()
      .prepare(`SELECT COUNT(*) AS c FROM ml_coupons WHERE status = 'ACTIVE'`)
      .get() as { c: number }
  ).c;

  setSetting("ml_coupons_synced_at", new Date().toISOString());
  setSetting("ml_coupons_count", String(storedFinal));
  setSetting("ml_coupons_with_code", String(withCodeFinal));
  logAntiBan(
    "ml_coupons_sync",
    `mode=${mode} fetched=${byId.size} stored=${storedFinal} active=${activeFinal} withCode=${withCodeFinal} reported=${totalReported} tipsNew=${tips?.newCodes?.join(",") || "-"}`,
  );

  // Teste + anúncio só sob demanda (botão Testar + anunciar) — não a cada Sync
  if (opts?.testAndAnnounce) {
    try {
      await testDigitibleCatalogCoupons(8);
    } catch (err) {
      logAntiBan(
        "ml_coupons_test_fail",
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      const { processCouponAnnouncements } = await import("./couponBroadcast.js");
      await processCouponAnnouncements();
    } catch (err) {
      logAntiBan(
        "ml_coupons_announce_fail",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    ok: storedFinal > 0 || byId.size > 0,
    fetched: byId.size,
    stored: storedFinal,
    active: activeFinal,
    withCode: withCodeFinal,
    totalReported,
    mode,
    tips: tips
      ? {
          scraped: tips.scraped,
          resolved: tips.resolved,
          stored: tips.stored,
          newCodes: tips.newCodes,
          usable: tips.usable,
          soldOut: tips.soldOut,
        }
      : undefined,
    error: storedFinal || byId.size
      ? undefined
      : "Nenhum cupom retornado pela API /cupons/api",
  };
}

function rowToCoupon(r: Record<string, unknown>): MlCoupon {
  return {
    campaignId: String(r.campaign_id),
    code: r.code ? String(r.code) : null,
    title: String(r.title),
    subtitle: r.subtitle ? String(r.subtitle) : null,
    status: String(r.status),
    discountType:
      (String(r.discount_type) as MlCoupon["discountType"]) || "unknown",
    discountValue: Number(r.discount_value) || 0,
    minAmount: r.min_amount == null ? null : Number(r.min_amount),
    capAmount: r.cap_amount == null ? null : Number(r.cap_amount),
    listUrl: r.list_url ? String(r.list_url) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    startsAt: r.starts_at ? String(r.starts_at) : null,
    sampleTitles: (() => {
      try {
        return JSON.parse(String(r.sample_titles || "[]")) as string[];
      } catch {
        return [];
      }
    })(),
    verticalHint: r.vertical_hint ? String(r.vertical_hint) : null,
    rawScoreBonus: 0,
    testedOk: r.tested_ok == null ? null : Number(r.tested_ok),
    testedAt: r.tested_at ? String(r.tested_at) : null,
    testedDetail: r.tested_detail ? String(r.tested_detail) : null,
    lastAnnouncedStatus: r.last_announced_status
      ? String(r.last_announced_status)
      : null,
    lastAnnouncedAt: r.last_announced_at ? String(r.last_announced_at) : null,
  };
}

export function listStoredCoupons(limit = 200): MlCoupon[] {
  ensureCouponsTable();
  const rows = getDb()
    .prepare(
      `SELECT * FROM ml_coupons
       WHERE status = 'ACTIVE'
       ORDER BY
         CASE WHEN code IS NOT NULL AND code != '' THEN 0 ELSE 1 END,
         discount_value DESC,
         updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map(rowToCoupon);
}

export function listAllStoredCoupons(limit = 250): MlCoupon[] {
  ensureCouponsTable();
  const rows = getDb()
    .prepare(
      `SELECT * FROM ml_coupons
       ORDER BY
         CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END,
         CASE WHEN code IS NOT NULL AND code != '' THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToCoupon);
}

/** Só cupons com código digitável (não depende do LIMIT antes do filtro). */
export function listCodedStoredCoupons(limit = 400): MlCoupon[] {
  ensureCouponsTable();
  const rows = getDb()
    .prepare(
      `SELECT * FROM ml_coupons
       WHERE code IS NOT NULL AND TRIM(code) != ''
       ORDER BY
         CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToCoupon).filter((c) => isDigitableCouponCode(c.code));
}

export function getStoredCoupon(campaignId: string): MlCoupon | null {
  ensureCouponsTable();
  const row = getDb()
    .prepare(`SELECT * FROM ml_coupons WHERE campaign_id = ?`)
    .get(campaignId) as Record<string, unknown> | undefined;
  return row ? rowToCoupon(row) : null;
}

export function markCouponTested(
  campaignId: string,
  ok: boolean,
  detail: string,
): void {
  ensureCouponsTable();
  getDb()
    .prepare(
      `UPDATE ml_coupons
       SET tested_ok = ?, tested_at = datetime('now'), tested_detail = ?
       WHERE campaign_id = ?`,
    )
    .run(ok ? 1 : 0, detail.slice(0, 240), campaignId);
}

function mlbIdFromDeal(d: {
  external_id?: string;
  product_url?: string;
}): string | null {
  const blob = `${d.external_id || ""} ${d.product_url || ""}`;
  const m = blob.match(/\bMLB-?(\d{6,})\b/i);
  return m ? `MLB${m[1]}` : null;
}

/** Testa códigos digitáveis do catálogo num produto da categoria (ex.: BRINQUEDOS em TCG). */
export async function testDigitibleCatalogCoupons(limit = 12): Promise<{
  tested: number;
  ok: number;
  dead: number;
  skipped: number;
}> {
  const { couponTargetCategories } = await import("./couponCategories.js");
  const { testMercadoLivreCoupon } = await import("./couponTester.js");
  const coupons = listStoredCoupons(200)
    .filter((c) => isDigitableCouponCode(c.code))
    .slice(0, limit);

  let tested = 0;
  let ok = 0;
  let dead = 0;
  let skipped = 0;

  for (const c of coupons) {
    const byCode = getDb()
      .prepare(
        `SELECT * FROM deals
         WHERE upper(coupon) = upper(?)
         ORDER BY CASE WHEN coupon_status = 'valid' THEN 0 ELSE 1 END, id DESC
         LIMIT 1`,
      )
      .get(c.code) as
      | {
          id: number;
          external_id: string;
          product_url: string;
          price: number;
          old_price: number | null;
        }
      | undefined;

    let deal = byCode;
    if (!deal) {
      const cats = couponTargetCategories(c);
      if (cats.length) {
        const ph = cats.map(() => "?").join(",");
        deal = getDb()
          .prepare(
            `SELECT * FROM deals
             WHERE category IN (${ph})
               AND status IN ('queued', 'posted', 'hold_coupon')
             ORDER BY id DESC LIMIT 1`,
          )
          .get(...cats) as typeof deal;
      }
    }
    if (!deal) {
      skipped += 1;
      continue;
    }
    const itemId = mlbIdFromDeal(deal);
    if (!itemId) {
      skipped += 1;
      continue;
    }

    const result = await testMercadoLivreCoupon({
      itemId,
      coupon: c.code,
      listedPrice: deal.price,
      listedOldPrice: deal.old_price,
      dealId: deal.id,
    });
    tested += 1;
    if (result.status === "valid" && result.ok) {
      markCouponTested(c.campaignId, true, result.detail);
      ok += 1;
    } else if (result.status === "invalid" || result.status === "expired") {
      markCouponTested(c.campaignId, false, result.detail);
      dead += 1;
    } else {
      skipped += 1;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  logAntiBan(
    "ml_coupons_catalog_test",
    `tested=${tested} ok=${ok} dead=${dead} skipped=${skipped}`,
  );
  return { tested, ok, dead, skipped };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter(
      (w) =>
        ![
          "com",
          "para",
          "por",
          "uma",
          "the",
          "off",
          "cupom",
          "produtos",
          "selecionados",
          "itens",
        ].includes(w),
    );
}

function titleOverlapScore(productTitle: string, coupon: MlCoupon): number {
  const pTokens = new Set(tokenize(productTitle));
  const cTokens = new Set([
    ...tokenize(coupon.title),
    ...coupon.sampleTitles.flatMap(tokenize),
  ]);
  let hit = 0;
  for (const t of pTokens) if (cTokens.has(t)) hit++;
  // keywords fortes
  const hay = `${coupon.title} ${coupon.sampleTitles.join(" ")}`.toLowerCase();
  const strong: Array<[RegExp, number]> = [
    [/smartphone|celular|galaxy|iphone|xiaomi|motorola|realme/, 8],
    [/áudio|audio|fone|buds|headset|soundbar/, 8],
    [/notebook|informática|monitor|ssd/, 6],
    [/moda|fashion|jeans|camiseta|sempremoda/, 6],
    [/casa|móveis|moveis|decoração|decoracao|comprinhaspracasa/, 6],
    [/brinquedo|bebê|bebe|hobbies/, 6],
    [/internacional/, -2], // genérico demais p/ produto BR
  ];
  let bonus = 0;
  const pLow = productTitle.toLowerCase();
  for (const [re, pts] of strong) {
    if (re.test(hay) && re.test(pLow)) bonus += pts;
    else if (re.test(hay) && !re.test(pLow) && pts > 0) bonus -= 3;
  }
  return hit * 2 + bonus;
}

function estimatedDiscount(price: number, coupon: MlCoupon): number {
  if (price <= 0) return 0;
  if (coupon.discountType === "percent") {
    let d = price * (coupon.discountValue / 100);
    if (coupon.capAmount != null) d = Math.min(d, coupon.capAmount);
    return d;
  }
  if (coupon.discountType === "fixed") {
    return Math.min(coupon.discountValue, price * 0.9);
  }
  return 0;
}

function isExpired(coupon: MlCoupon): boolean {
  if (!coupon.expiresAt) return false;
  const t = Date.parse(coupon.expiresAt);
  return Number.isFinite(t) && t < Date.now();
}

/** Cupom de loja “siga / novo seguidor” (sem código digitável). */
export function isFollowerStoreCoupon(coupon: {
  title?: string | null;
  subtitle?: string | null;
  code?: string | null;
}): boolean {
  const hay = `${coupon.title || ""} ${coupon.subtitle || ""}`.toLowerCase();
  return /seguidor|seguir a loja|siga a loja|novo seguidor|cupom por seguir|follow(er)?\s*coupon|follow the shop/i.test(
    hay,
  );
}

/** Cupom só da loja (sem código digitável) — candidato a qty>1 / seguir loja. */
function isSellerStoreCoupon(coupon: MlCoupon): boolean {
  if (isFollowerStoreCoupon(coupon)) return true;
  if (isDigitableCouponCode(coupon.code)) return false;
  const sub = String(coupon.subtitle || "");
  if (/Em produtos de\s+\S+/i.test(sub)) return true;
  return /^(R\$\s*)?\d+%?\s*OFF$/i.test(String(coupon.title || "").trim());
}

/**
 * Quantidade mínima de unidades para atingir o valor do cupom.
 * 1 = já ativa com 1; 0 = impossível (mínimo absurdo).
 * Digitable (BRINQUEDOS…) e loja/seguidor: todos podem subir qty.
 */
export function minQtyForCoupon(
  unitPrice: number,
  coupon: MlCoupon,
  opts?: { maxQty?: number; allowMulti?: boolean },
): number {
  const allowMulti = opts?.allowMulti !== false;
  if (!allowMulti) {
    if (coupon.minAmount == null || coupon.minAmount <= 0) return 1;
    if (!(unitPrice > 0)) return 1;
    return unitPrice + 0.009 >= coupon.minAmount ? 1 : 0;
  }
  return minUnitsForCouponMin(unitPrice, coupon.minAmount, opts?.maxQty ?? 6);
}

function passesMinPurchase(price: number, coupon: MlCoupon): boolean {
  if (coupon.minAmount == null) return true;
  if (price <= 0) return (coupon.minAmount || 0) <= 250;
  return minQtyForCoupon(price, coupon) >= 1;
}

export type PdpItemCoupon = {
  campaignId: string;
  title: string;
  code: string | null;
  discountType: "percent" | "fixed" | "unknown";
  discountValue: number;
  givenDiscount: number;
  minAmount: number | null;
  capAmount: number | null;
  expiresAt: string | null;
  isFollower: boolean;
  sellerName: string | null;
  listUrl: string | null;
  qty: number;
  /**
   * segmentations.has_items do ML.
   * false = cupom aparece no modal mas NÃO vale neste item (ex.: BRINQUEDOS no Gengar).
   * null = campo ausente (API antiga).
   */
  hasItems: boolean | null;
  /** tracking.coupons_list (confiável) vs rawCoupons (fallback fraco). */
  source: "tracking" | "raw";
};

function extractBuyingFlowData(html: string): Record<string, unknown> | null {
  const marker = '"buyingFlowData":';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0) return null;
  let depth = 0;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, p + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseMoneyLabel(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).replace(/\./g, "").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Cupons reais do anúncio (modal /cupons/pdp) — inclui “5% OFF / seguir a loja”
 * que muitas vezes NÃO aparece no catálogo geral /cupons.
 */
export async function fetchPdpItemCoupons(opts: {
  itemId: string;
  unitPrice: number;
  quantity?: number;
}): Promise<PdpItemCoupon[]> {
  if (!hubSessionReady()) return [];
  const itemId = String(opts.itemId || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^MLB\d{6,}$/.test(itemId)) return [];
  const unitPrice = Number(opts.unitPrice) || 0;
  if (!(unitPrice > 0)) return [];
  const quantity = Math.max(1, Math.min(12, Math.floor(opts.quantity || 1)));

  const url =
    `https://www.mercadolivre.com.br/cupons/pdp?item_id=${encodeURIComponent(itemId)}` +
    `&unit_price=${encodeURIComponent(String(unitPrice))}` +
    `&quantity=${quantity}&loyalty=6&new_version=true&title=Cupons`;

  try {
    const res = await fetch(url, {
      headers: {
        ...couponHeaders(),
        Accept: "text/html,application/xhtml+xml",
        Referer: `https://www.mercadolivre.com.br/`,
      },
    });
    if (!res.ok) {
      logAntiBan("ml_pdp_coupons_http", `item=${itemId} status=${res.status}`);
      return [];
    }
    const html = await res.text();
    const flow = extractBuyingFlowData(html);
    if (!flow) return [];

    const tracking = (flow.tracking || {}) as {
      view?: { eventData?: { coupons_list?: Array<Record<string, unknown>> } };
    };
    const list = tracking.view?.eventData?.coupons_list || [];

    // Fallback: rawCoupons nos groupings (tem seller_new_follower_coupon)
    const groupings = (flow.groupings || []) as Array<{
      key?: string;
      coupons?: Array<Record<string, unknown>>;
      rawCoupons?: Array<Record<string, unknown>>;
    }>;
    const followerIds = new Set<string>();
    const sellerByCampaign = new Map<string, string>();
    const listUrlByCampaign = new Map<string, string>();
    for (const g of groupings) {
      for (const raw of [...(g.rawCoupons || []), ...(g.coupons || [])]) {
        const id = String(raw.campaign_id || raw.campaignId || "").trim();
        if (!id) continue;
        if (raw.seller_new_follower_coupon || raw.isNewFollowerCoupon) {
          followerIds.add(id);
        }
        const seller = String(raw.category || "").trim();
        if (seller) sellerByCampaign.set(id, seller);
        const action = (raw.action || {}) as { value?: string };
        if (action.value) listUrlByCampaign.set(id, String(action.value));
      }
    }

    const out: PdpItemCoupon[] = [];
    for (const row of list) {
      const campaignId = String(row.campaign_id || "").trim();
      if (!campaignId) continue;
      const title = String(row.title || "Cupom loja").trim();
      const dtype = String(row.discount_type || "").toUpperCase();
      const discountType: PdpItemCoupon["discountType"] =
        dtype === "PERCENT" || dtype === "PERCENTAGE"
          ? "percent"
          : dtype === "FIXED" || dtype === "AMOUNT"
            ? "fixed"
            : "unknown";
      const discountValue = Number(row.discount_value) || 0;
      let givenDiscount = Number(row.given_discount) || 0;
      const minAmount =
        row.min_amount != null ? Number(row.min_amount) : null;
      const capAmount =
        row.cap_amount != null ? Number(row.cap_amount) : null;
      const seg = row.segmentations as
        | { has_items?: boolean }
        | undefined;
      const hasItems =
        seg && typeof seg.has_items === "boolean" ? seg.has_items : null;
      const cart = unitPrice * quantity;

      // has_items=false: cupom listado no modal mas NÃO elegível neste SKU.
      // O ML ainda manda given_discount teórico (15% do unit_price) — ignorar.
      if (hasItems === false) {
        givenDiscount = 0;
      }

      // Só recalcula given=0 quando o mínimo de compra ainda não era atingido
      // e o item É elegível (has_items === true). Nunca inventa desconto em
      // produto fora da campanha ou com elegibilidade desconhecida.
      if (
        hasItems === true &&
        givenDiscount <= 0.009 &&
        minAmount != null &&
        minAmount > 0 &&
        cart + 0.009 >= minAmount &&
        // qty>1: típico “mínimo não batia em 1 un.”
        quantity > 1 &&
        discountValue > 0
      ) {
        if (discountType === "percent") {
          givenDiscount = (cart * discountValue) / 100;
          if (capAmount != null) givenDiscount = Math.min(givenDiscount, capAmount);
        } else if (discountType === "fixed") {
          givenDiscount = Math.min(discountValue, cart * 0.9);
        }
        givenDiscount = Math.round(givenDiscount * 100) / 100;
      }
      const codeRaw = String(row.code || "").trim();
      const code = isDigitableCouponCode(codeRaw) ? codeRaw.toUpperCase() : null;
      out.push({
        campaignId,
        title,
        code,
        discountType,
        discountValue,
        givenDiscount,
        minAmount: Number.isFinite(minAmount as number) ? minAmount : null,
        capAmount: Number.isFinite(capAmount as number) ? capAmount : null,
        expiresAt: row.expiration_date ? String(row.expiration_date) : null,
        isFollower: followerIds.has(campaignId),
        sellerName: sellerByCampaign.get(campaignId) || null,
        listUrl: listUrlByCampaign.get(campaignId) || null,
        qty: quantity,
        hasItems,
        source: "tracking",
      });
    }

    // Se tracking veio vazio, monta a partir dos rawCoupons
    if (!out.length) {
      for (const g of groupings) {
        for (const raw of g.rawCoupons || []) {
          const campaignId = String(raw.campaign_id || "").trim();
          if (!campaignId) continue;
          const titleObj = (raw.title || {}) as { text?: string };
          const title = String(titleObj.text || "Cupom loja").trim();
          const amount = (raw.amount || {}) as {
            min_amount?: string;
            cap_amount?: string;
          };
          const benefit = String(raw.benefit_mode || "").toUpperCase();
          const pct = title.match(/(\d+(?:[.,]\d+)?)\s*%/i);
          const fixed = title.match(/R\$\s*([\d.,]+)/i);
          let discountType: PdpItemCoupon["discountType"] = "unknown";
          let discountValue = 0;
          if (benefit === "PERCENT" || pct) {
            discountType = "percent";
            discountValue = pct ? Number(pct[1].replace(",", ".")) : 0;
          } else if (fixed) {
            discountType = "fixed";
            discountValue = Number(fixed[1].replace(/\./g, "").replace(",", ".")) || 0;
          }
          const minAmount = parseMoneyLabel(amount.min_amount);
          const capAmount = parseMoneyLabel(amount.cap_amount);
          const seg = raw.segmentations as { has_items?: boolean } | undefined;
          const hasItems =
            seg && typeof seg.has_items === "boolean" ? seg.has_items : null;
          // rawCoupons quase nunca traz given_discount — sem inventar % OFF.
          const givenDiscount = 0;
          out.push({
            campaignId,
            title,
            code: isDigitableCouponCode(String(raw.code || ""))
              ? String(raw.code).toUpperCase()
              : null,
            discountType,
            discountValue,
            givenDiscount,
            minAmount,
            capAmount,
            expiresAt: raw.expiration_date ? String(raw.expiration_date) : null,
            isFollower: Boolean(raw.seller_new_follower_coupon),
            sellerName: String(raw.category || "") || null,
            listUrl: String((raw.action as { value?: string } | undefined)?.value || "") || null,
            qty: quantity,
            hasItems,
            source: "raw",
          });
        }
      }
    }

    return out;
  } catch (err) {
    logAntiBan(
      "ml_pdp_coupons_err",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Escolhe o melhor cupom do PDP; tenta qty>1 se o mínimo do cupom de loja exigir.
 * Cupom “seguir a loja” NÃO entra no post — muitos anúncios não têm o botão. */
export async function pickBestPdpCouponForPrice(opts: {
  itemId: string;
  unitPrice: number;
  maxQty?: number;
  /** Se false (padrão), ignora seller_new_follower_coupon. */
  allowFollower?: boolean;
}): Promise<PdpItemCoupon | null> {
  const maxQty = Math.max(1, Math.min(6, opts.maxQty ?? 6));
  const unitPrice = opts.unitPrice;
  const allowFollower = opts.allowFollower === true;
  let best: PdpItemCoupon | null = null;
  let pendingMins: number[] = [];

  for (let qty = 1; qty <= maxQty; qty++) {
    if (qty > 1) {
      // Só sobe qty se algum cupom de loja tiver mínimo entre (price*(qty-1), price*qty]
      const need = pendingMins.some(
        (m) => m > unitPrice * (qty - 1) + 0.009 && m <= unitPrice * qty + 0.009,
      );
      if (!need && best) break;
      if (!need && !pendingMins.length) break;
    }

    const list = await fetchPdpItemCoupons({
      itemId: opts.itemId,
      unitPrice,
      quantity: qty,
    });
    pendingMins = [];
    for (const c of list) {
      // Sem código digitável + follower = inventava “siga a loja” sem o botão no anúncio
      if (c.isFollower && !c.code && !allowFollower) continue;
      if (!isDigitableCouponCode(c.code) && !allowFollower && c.isFollower) continue;
      // Só confia em tracking.coupons_list (rawCoupons = modal teórico).
      if (c.source !== "tracking") continue;
      // Cupom listado mas has_items=false → não aplica neste produto
      if (c.hasItems === false) continue;
      // Sem economia real reportada pelo ML → não serve para post
      if (!(c.givenDiscount > 0.05)) {
        if (c.minAmount != null && c.minAmount > unitPrice * qty + 0.009) {
          if (c.isFollower || !c.code) pendingMins.push(c.minAmount);
        }
        continue;
      }
      // Cupom sem código e sem follower: só se for desconto real mensurável no carrinho
      if (!isDigitableCouponCode(c.code) && !c.isFollower) {
        // clique-no-link genérico: exige min atingido neste qty
        if (c.minAmount != null && c.minAmount > unitPrice * qty + 0.009) {
          pendingMins.push(c.minAmount);
          continue;
        }
      }
      if (c.minAmount != null && c.minAmount > unitPrice * qty + 0.009) {
        if (c.isFollower || !c.code) pendingMins.push(c.minAmount);
        continue; // não aplica desconto abaixo do mínimo
      }
      const unitSaving =
        c.givenDiscount > 0 ? c.givenDiscount / qty : 0;
      if (!(unitSaving > 0.05)) continue;
      // WhatsApp: cupom digitável (BRINQUEDOS, OFFMELI…) vale mais que só “seguir loja”
      const score =
        unitSaving * 10 +
        (c.code ? 55 : 0) +
        (c.isFollower ? -20 : 0) -
        (qty > 1 ? qty * 2 : 0);
      const bestSaving = best ? best.givenDiscount / best.qty : 0;
      const bestScore =
        bestSaving * 10 +
        (best?.code ? 55 : 0) +
        (best?.isFollower ? -20 : 0) -
        (best && best.qty > 1 ? best.qty * 2 : 0);
      if (!best || score > bestScore + 0.01) {
        best = { ...c, qty, givenDiscount: c.givenDiscount };
      }
    }

    if (best && qty === 1 && !pendingMins.length) break;
    if (qty < maxQty && pendingMins.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return best;
}

/**
 * Confirma se um código digitável realmente aplica neste item (PDP).
 * has_items=false ou given_discount=0 → não postar.
 */
export async function confirmDigitableCouponOnPdp(opts: {
  itemId: string;
  unitPrice: number;
  code: string;
}): Promise<
  | { ok: true; coupon: PdpItemCoupon; detail: string }
  | { ok: false; detail: string; inconclusive?: boolean }
> {
  const code = String(opts.code || "").trim().toUpperCase();
  if (!isDigitableCouponCode(code)) {
    return { ok: false, detail: "código não digitável" };
  }
  const unit = Number(opts.unitPrice) || 0;
  if (!(unit > 0)) return { ok: false, detail: "preço inválido para PDP" };

  let pendingMins: number[] = [];
  let sawAnyTracking = false;
  for (let qty = 1; qty <= 6; qty++) {
    if (qty > 1) {
      const need = pendingMins.some(
        (m) => m > unit * (qty - 1) + 0.009 && m <= unit * qty + 0.009,
      );
      if (!need && !pendingMins.length) break;
    }
    const list = await fetchPdpItemCoupons({
      itemId: opts.itemId,
      unitPrice: unit,
      quantity: qty,
    });
    pendingMins = [];
    if (!list.length) {
      return {
        ok: false,
        inconclusive: true,
        detail: "PDP sem resposta de cupons (inconclusivo — não demove)",
      };
    }
    const tracking = list.filter((c) => c.source === "tracking");
    if (tracking.length) sawAnyTracking = true;
    // Só decide com tracking.coupons_list (given_discount real + has_items).
    const pool = tracking.length ? tracking : [];
    if (!pool.length) {
      // Só rawCoupons → não dá para afirmar elegibilidade.
      return {
        ok: false,
        inconclusive: true,
        detail: `PDP só rawCoupons p/ ${code} (inconclusivo)`,
      };
    }
    const hit = pool.find((c) => String(c.code || "").toUpperCase() === code);
    if (!hit) {
      return {
        ok: false,
        detail: `PDP sem ${code} neste produto — cupom não aplicável`,
      };
    }
    if (hit.hasItems === false) {
      return {
        ok: false,
        detail: `PDP ${code} has_items=false — não aplica neste SKU`,
      };
    }
    if (hit.minAmount != null && hit.minAmount > unit * qty + 0.009) {
      pendingMins.push(hit.minAmount);
      continue;
    }
    if (!(hit.givenDiscount > 0.05)) {
      return {
        ok: false,
        detail: `PDP ${code} sem given_discount (não há desconto real)`,
      };
    }
    return {
      ok: true,
      coupon: { ...hit, qty },
      detail: `PDP ${code} ok −R$${Number(hit.givenDiscount).toFixed(2)} qty=${qty} has_items=${hit.hasItems}`,
    };
  }
  if (!sawAnyTracking) {
    return {
      ok: false,
      inconclusive: true,
      detail: `PDP ${code} inconclusivo`,
    };
  }
  return {
    ok: false,
    detail: `PDP ${code} não ativou desconto (mínimo/qty)`,
  };
}

export function scoreCouponForProduct(opts: {
  title: string;
  category: string;
  price: number;
  coupon: MlCoupon;
}): number {
  const { title, category, price, coupon } = opts;
  if (coupon.status !== "ACTIVE") return -1000;
  if (isExpired(coupon)) return -1000;
  if (!couponAllowedForDealCategory(coupon, category || "geral")) return -800;
  const qty = minQtyForCoupon(price, coupon);
  if (qty < 1) return -500;

  let score = titleOverlapScore(title, coupon);
  const verticals = CATEGORY_VERTICAL[category] || CATEGORY_VERTICAL.geral;
  if (coupon.verticalHint && verticals.includes(coupon.verticalHint)) score += 10;
  // Código digitável de verdade (OFFMELI…) — prioridade alta no post
  if (isDigitableCouponCode(coupon.code)) score += 22;
  else score -= 2;

  // Cupom de seguir a loja: vale o preço final (ex.: 5% / R$8 OFF)
  if (isFollowerStoreCoupon(coupon)) {
    score += 18;
    if (!isDigitableCouponCode(coupon.code)) score += 4;
  }

  // Sem preço: estima desconto com valor típico de oferta (não use min_amount alto)
  const priceForDisc = price > 0 ? price : 180;
  const disc = estimatedDiscount(priceForDisc, coupon);
  score += Math.min(28, disc / 8);
  if (coupon.discountType === "percent" && coupon.discountValue >= 5) score += 3;
  if (coupon.discountType === "percent" && coupon.discountValue >= 15) score += 4;
  // Precisa comprar mais de 1: ainda postável, mas perde um pouco vs 1 un.
  if (qty > 1) score -= Math.min(8, (qty - 1) * 2);
  if (/internacional/i.test(coupon.title) && !/internacional|importado|cn\b/i.test(title)) {
    score -= 8;
  }
  // Cupons genéricos de vendedor "5% OFF" sem código/amostra: ainda úteis no preço
  if (
    !isDigitableCouponCode(coupon.code) &&
    !isFollowerStoreCoupon(coupon) &&
    !coupon.sampleTitles.length &&
    /^(R\$\s*)?\d+%?\s*OFF$/i.test(coupon.title.trim())
  ) {
    score -= 4; // antes -12; 5% OFF de loja costuma ser real no PDP
  }
  // OFFMELI / áudio: bons para eletrônicos
  if (coupon.code === "OFFMELI" && ["eletronicos", "celulares", "informatica", "games"].includes(category)) {
    score += 8;
  }
  // BRINQUEDOS: prioridade em TCG / brinquedos / games
  if (
    coupon.code === "BRINQUEDOS" &&
    ["tcg", "brinquedos", "bebes", "games"].includes(category)
  ) {
    score += 28;
  }
  if (
    coupon.code === "COMPRINHASPRACASA" &&
    category === "casa"
  ) {
    score += 28;
  }
  if (
    (coupon.code === "SEMPREMODA" || coupon.code === "SEMPRENAMODA") &&
    ["moda", "beleza"].includes(category)
  ) {
    score += 18;
  }
  if (
    coupon.code === "ECONOMIAML" &&
    ["eletronicos", "celulares", "informatica", "games", "eletrodomesticos"].includes(
      category,
    )
  ) {
    score += 6; // útil, mas exige validação real na lista
  }
  if (
    /^LIBROS|^LIVROS|^LEITOR|^JOGOS|^GAMES/i.test(String(coupon.code || "")) &&
    ["games", "brinquedos", "tcg", "geral"].includes(category)
  ) {
    score += 26;
  }
  if (
    (coupon.code === "PREFERIDO" || coupon.code === "COMPRINHASPRACASA") &&
    category === "casa"
  ) {
    score += 20;
  }
  if (
    (coupon.code === "APROVEITA" || coupon.code === "CORREPROMELI") &&
    ["geral", "alimentos"].includes(category)
  ) {
    score += 14;
  }
  if (/áudio|audio|fone|buds/i.test(coupon.title) && /fone|buds|headset|áudio|audio/i.test(title)) {
    score += 12;
  }
  if (/smartphone/i.test(coupon.title) && /celular|smartphone|galaxy|iphone/i.test(title)) {
    score += 12;
  }
  // Evita cupom de smartphone em fone/acessório
  if (/smartphone/i.test(coupon.title) && /fone|buds|headset|carregador|capa|pel[ií]cula/i.test(title)) {
    score -= 20;
  }
  score += coupon.rawScoreBonus;
  return score;
}

export function pickBestCouponsForProduct(opts: {
  title: string;
  category: string;
  price: number;
  limit?: number;
}): Array<MlCoupon & { score: number }> {
  const coupons = listStoredCoupons(400);
  if (!coupons.length) return [];
  const ranked = coupons
    .map((c) => ({
      ...c,
      score: scoreCouponForProduct({ ...opts, coupon: c }),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const limit = opts.limit ?? 5;
  // Prioriza códigos digitáveis reais no topo da fila de validação
  const coded = ranked.filter((c) => isDigitableCouponCode(c.code));
  const rest = ranked.filter((c) => !isDigitableCouponCode(c.code));
  const ordered = [...coded, ...rest];
  const top = ordered.slice(0, limit);
  const bestCoded = coded[0];
  if (bestCoded && !top.some((c) => c.campaignId === bestCoded.campaignId)) {
    top.unshift(bestCoded);
  }
  return top.slice(0, limit + 2);
}

/** Valida se o produto parece elegível na lista do cupom. */
export async function validateCouponOnList(opts: {
  coupon: MlCoupon;
  title: string;
  itemId?: string | null;
  productUrl?: string | null;
}): Promise<{ ok: boolean; detail: string }> {
  const { coupon, title, itemId, productUrl } = opts;
  if (!coupon.listUrl && !coupon.campaignId) {
    return { ok: false, detail: "cupom sem lista/campaign" };
  }

  const catalogId =
    productUrl?.match(/\/p\/(MLB\d+)/i)?.[1] ||
    productUrl?.match(/(MLB\d{6,})/i)?.[1] ||
    null;
  const cleanItem = (itemId || "")
    .replace(/^hubauto-/i, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();

  const q = tokenize(title).slice(0, 5).join(" ");
  const base =
    coupon.listUrl ||
    `https://lista.mercadolivre.com.br/_Container_${coupon.campaignId}?coupon_campaign_id=${coupon.campaignId}`;
  const urls = [
    q ? `${base}${base.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}` : base,
    base,
  ];

  let lastDetail = `produto não encontrado na lista do cupom ${coupon.campaignId}`;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          ...couponHeaders(),
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(20000),
        redirect: "follow",
      });
      const html = await res.text();
      if (res.status !== 200 || html.length < 800) continue;

      const low = html.toLowerCase();
      const hasItem = Boolean(cleanItem && html.toUpperCase().includes(cleanItem));
      const hasCatalog = Boolean(
        catalogId && html.toUpperCase().includes(catalogId.toUpperCase()),
      );
      const tokens = tokenize(title).slice(0, 8);
      const tokenHits = tokens.filter((t) => low.includes(t)).length;
      const empty =
        /não encontramos|nao encontramos|não há resultados|sem resultados/i.test(
          html,
        );

      // Só aceita evidência na lista real do cupom — NUNCA amostra/overlap solto
      // (ECONOMIAML no DualSense passou por amostra e o cupom NÃO aplicava).
      if (hasItem || hasCatalog) {
        return {
          ok: true,
          detail: `lista contém id do produto (${coupon.campaignId})`,
        };
      }
      if (!empty && tokenHits >= Math.max(4, Math.min(5, tokens.length))) {
        return {
          ok: true,
          detail: `lista com ${tokenHits} tokens do título (campaign ${coupon.campaignId})`,
        };
      }
      lastDetail = empty
        ? `lista vazia para busca no cupom ${coupon.campaignId}`
        : `lista sem o produto (hits=${tokenHits}) cupom ${coupon.campaignId}`;
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: false, detail: lastDetail };
}

/** Só devolve código se for digitável de verdade. Nunca inventa "25%OFF". */
function displayCouponCode(coupon: MlCoupon): string | null {
  if (isDigitableCouponCode(coupon.code)) {
    return String(coupon.code).trim().toUpperCase();
  }
  return null;
}

/** Remove da fila códigos falsos já gravados (25%OFF, 40%OFF…). */
export function scrubFakeCouponCodes(): { cleared: number } {
  const rows = getDb()
    .prepare(
      `SELECT id, coupon FROM deals
       WHERE coupon IS NOT NULL AND trim(coupon) != ''`,
    )
    .all() as Array<{ id: number; coupon: string }>;
  let cleared = 0;
  const upd = getDb().prepare(
    `UPDATE deals SET coupon = NULL WHERE id = ?`,
  );
  const updMatch = getDb().prepare(
    `UPDATE deal_coupon_matches SET code = NULL WHERE deal_id = ? AND code = ?`,
  );
  for (const row of rows) {
    if (isDigitableCouponCode(row.coupon)) continue;
    upd.run(row.id);
    updMatch.run(row.id, row.coupon);
    cleared += 1;
  }
  if (cleared) {
    logAntiBan("coupon_scrub_fake", `cleared=${cleared} rótulos %OFF removidos`);
  }
  return { cleared };
}

function appendCampaignToAffiliateUrl(url: string, campaignId: string): string {
  if (!url || !campaignId) return url;
  if (url.includes("coupon_campaign_id=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  // meli.la não aceita query extra de forma confiável — só enriquece product_url style
  if (url.includes("meli.la")) return url;
  return `${url}${sep}coupon_campaign_id=${campaignId}`;
}

export async function enrichDealWithBestCoupon(
  dealId: number,
  opts?: {
    validate?: boolean;
    syncIfEmpty?: boolean;
    preferredCodes?: string[];
  },
): Promise<{
  ok: boolean;
  dealId: number;
  coupon: string | null;
  campaignId: string | null;
  title: string | null;
  score: number;
  validated: boolean;
  detail: string;
  test?: Awaited<ReturnType<typeof applyCouponTestToDeal>>;
}> {
  ensureCouponsTable();
  const deal = getDb()
    .prepare(`SELECT * FROM deals WHERE id = ?`)
    .get(dealId) as
    | {
        id: number;
        title: string;
        category: string;
        price: number;
        old_price: number | null;
        external_id: string;
        product_url: string;
        affiliate_url: string;
        source: string;
        description: string;
        coupon: string | null;
      }
    | undefined;

  if (!deal) {
    return {
      ok: false,
      dealId,
      coupon: null,
      campaignId: null,
      title: null,
      score: 0,
      validated: false,
      detail: "deal não encontrado",
    };
  }

  if (deal.source !== "mercadolivre" && deal.source !== "demo") {
    return {
      ok: false,
      dealId,
      coupon: deal.coupon,
      campaignId: null,
      title: null,
      score: 0,
      validated: false,
      detail: "fonte sem cupons ML",
    };
  }

  const price = deal.price || deal.old_price || 0;
  const validate = opts?.validate !== false;
  const { normalizeItemId } = await import("./mlHub.js");
  const itemId =
    normalizeItemId(deal.external_id) || normalizeItemId(deal.product_url);

  /** Aplica cupom já escolhido do PDP no deal e retorna o resultado do enrich. */
  const applyPdpPick = async (pdp: PdpItemCoupon) => {
      if (
        pdp.source !== "tracking" ||
        pdp.hasItems === false ||
        !(pdp.givenDiscount > 0.05)
      ) {
        return {
          ok: false as const,
          dealId,
          coupon: pdp.code,
          campaignId: pdp.campaignId,
          title: pdp.title,
          score: 0,
          validated: false,
          detail:
            pdp.source !== "tracking"
              ? `PDP: ${pdp.code || pdp.title} sem tracking (só raw — inconclusivo)`
              : pdp.hasItems === false
                ? `PDP: ${pdp.code || pdp.title} listado mas has_items=false (não aplica neste SKU)`
                : `PDP: ${pdp.code || pdp.title} sem given_discount real`,
        };
      }
      const code = pdp.code;
      const qty = pdp.qty;
      const unitSaving = pdp.givenDiscount / Math.max(1, pdp.qty);
      let priceWithCoupon = Math.round((price - unitSaving) * 100) / 100;
      // Se qty>1, rateia no carrinho (mesma regra do quoteCouponCart)
      let qtyTip = "";
      if (qty > 1 && pdp.minAmount != null) {
        const quote = quoteCouponCart(
          price,
          {
            discountType: pdp.discountType,
            discountValue: pdp.discountValue,
            minAmount: pdp.minAmount,
            capAmount: pdp.capAmount,
          },
          { maxQty: 6 },
        );
        if (quote.ok) {
          priceWithCoupon = quote.unitAfter;
          qtyTip = formatCouponQtyDescBit(quote);
        } else {
          qtyTip = ` · leve ${qty} un. para ativar (mín. R$ ${Number(pdp.minAmount || 0).toFixed(2).replace(".", ",")})`;
        }
      } else if (qty > 1) {
        qtyTip = ` · leve ${qty} un. para ativar (mín. R$ ${Number(pdp.minAmount || 0).toFixed(2).replace(".", ",")})`;
      }
      // Desconto absurdo no PDP (ex.: 50%+ sem código) — ignora este cupom
      if (
        !(priceWithCoupon > 0) ||
        !(unitSaving > 0.05) ||
        priceWithCoupon < price * 0.6 ||
        unitSaving > price * 0.4 + 0.009
      ) {
        return {
          ok: false as const,
          dealId,
          coupon: null,
          campaignId: pdp.campaignId,
          title: pdp.title,
          score: 0,
          validated: false,
          detail: `PDP desconto absurdo (−R$${unitSaving.toFixed(2)} de ${price}) — ignorado`,
        };
      }
      const followTip =
        getSetting("allow_follower_coupons", "0") === "1" &&
        (pdp.isFollower || /seguir|seguidor/i.test(pdp.title))
          ? " · siga a loja no anúncio para ativar"
          : "";
      const sellerLabel =
        pdp.sellerName &&
        !/off|cupom|código|codigo|brinquedo|economia|sempremoda|offmeli/i.test(
          pdp.sellerName,
        )
          ? pdp.sellerName
          : null;
      const descExtra = code
        ? `Cupom ML: ${pdp.title}${sellerLabel ? ` · ${sellerLabel}` : ""} · código ${code} · campanha ${pdp.campaignId}${qtyTip}`
        : `Desconto ML no link: ${pdp.title}${sellerLabel ? ` · ${sellerLabel}` : ""} · campanha ${pdp.campaignId}${qtyTip}`;
      // Limpa textos antigos de “seguir loja” / tips duplicados
      const baseDesc = String(deal.description || "")
        .replace(/\n?Cupom ML:.*$/gim, "")
        .replace(/\n?Desconto ML.*$/gim, "")
        .replace(/\s*·\s*leve\s+\d+\s+un\.[^\n]*/gi, "")
        .replace(/\s*·\s*carrinho\s+R\$[^\n]*/gi, "")
        .replace(/\s*·\s*siga a loja[^\n]*/gi, "")
        .trim();
      const description = scrubCouponDescTips(`${baseDesc}\n${descExtra}`.trim());

      const productUrl = appendCampaignToAffiliateUrl(
        deal.product_url,
        pdp.campaignId,
      );
      let affiliateUrl = deal.affiliate_url;
      try {
        const { createAffiliateLink, withCouponCampaign } = await import(
          "./mlHub.js"
        );
        const origin =
          productUrl ||
          withCouponCampaign(
            `https://produto.mercadolivre.com.br/${itemId!.replace(/^MLB/i, "MLB-")}`,
            pdp.campaignId,
          );
        if (origin) {
          const link = await createAffiliateLink(origin, {
            couponCampaignId: pdp.campaignId,
          });
          if (link.shortUrl) affiliateUrl = link.shortUrl;
        }
      } catch (err) {
        logAntiBan(
          "ml_coupon_link_regen_err",
          err instanceof Error ? err.message : String(err),
        );
      }

      try {
        upsertCouponRow({
          campaignId: pdp.campaignId,
          code: pdp.code,
          title: pdp.isFollower
            ? `${pdp.title} · Cupom por seguir a loja`
            : pdp.title,
          subtitle: pdp.sellerName
            ? `Em produtos de ${pdp.sellerName}`
            : "Cupom de loja (PDP)",
          status: "ACTIVE",
          discountType: pdp.discountType,
          discountValue: pdp.discountValue,
          minAmount: pdp.minAmount,
          capAmount: pdp.capAmount,
          listUrl: pdp.listUrl,
          expiresAt: pdp.expiresAt,
          startsAt: null,
          sampleTitles: [deal.title],
          verticalHint: null,
          rawScoreBonus: pdp.isFollower ? 12 : 6,
        });
      } catch {
        /* ignore */
      }

      getDb()
        .prepare(
          `UPDATE deals SET
             coupon = ?,
             coupon_status = 'pending',
             price_with_coupon = ?,
             description = ?,
             product_url = ?,
             affiliate_url = ?,
             status = CASE WHEN status = 'posted' THEN status ELSE 'hold_coupon' END
           WHERE id = ?`,
        )
        .run(
          code,
          priceWithCoupon > 0 ? priceWithCoupon : null,
          description,
          productUrl,
          affiliateUrl,
          dealId,
        );

      const detail = pdp.isFollower
        ? `PDP seguir loja: ${pdp.title} −R$${unitSaving.toFixed(2)} qty=${qty}`
        : `PDP${code ? " código" : " loja"}: ${pdp.title} −R$${unitSaving.toFixed(2)} qty=${qty}`;

      getDb()
        .prepare(
          `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
           ON CONFLICT(deal_id) DO UPDATE SET
             campaign_id=excluded.campaign_id,
             code=excluded.code,
             title=excluded.title,
             score=excluded.score,
             validated=1,
             detail=excluded.detail,
             updated_at=datetime('now')`,
        )
        .run(
          dealId,
          pdp.campaignId,
          code,
          pdp.title,
          90 + Math.min(20, unitSaving),
          // PDP com código digitável = evidência forte (dado pelo próprio anúncio)
          code
            ? `lista contém id do produto (${pdp.campaignId}); ${detail}`
            : detail,
        );

      let test: Awaited<ReturnType<typeof applyCouponTestToDeal>> | undefined;
      // Código digitável: testa de verdade. Clique/loja: só marca valid se o
      // desconto unitário for crível (evita 173→87,90 inventado).
      const unitOk =
        priceWithCoupon > 0 &&
        priceWithCoupon + 0.009 < price &&
        priceWithCoupon >= price * 0.6;
      if (code && (getSetting("require_coupon_test", "1") === "1" || validate)) {
        test = await applyCouponTestToDeal(dealId);
      } else if (!code && unitOk && (validate || getSetting("require_coupon_test", "1") === "1")) {
        getDb()
          .prepare(
            `UPDATE deals SET coupon_status = 'valid', coupon_tested_at = datetime('now') WHERE id = ?`,
          )
          .run(dealId);
        test = {
          ok: true,
          coupon: code,
          originalPrice: price,
          finalPrice: priceWithCoupon,
          detail: `PDP: ${detail}`,
          status: "valid",
        };
      }

      logAntiBan("ml_coupon_match", `deal=${dealId} ${detail}`);
      return {
        ok: true as const,
        dealId,
        coupon: code,
        campaignId: pdp.campaignId,
        title: pdp.title,
        score: 90,
        validated: true,
        detail,
        test,
      };
  };

  // 1) Cupons do anúncio — só código digitável (nunca “seguir loja” no WhatsApp)
  if (itemId && price > 0 && hubSessionReady()) {
    const pdp = await pickBestPdpCouponForPrice({
      itemId,
      unitPrice: price,
      allowFollower: getSetting("allow_follower_coupons", "0") === "1",
    });
    if (pdp && pdp.givenDiscount > 0.05 && isDigitableCouponCode(pdp.code)) {
      return applyPdpPick(pdp);
    }
  }

  let stored = listStoredCoupons(50);
  if (!stored.length && opts?.syncIfEmpty !== false && hubSessionReady()) {
    await syncMlCouponsCatalog({ maxPagesPerKey: 2 });
    stored = listStoredCoupons(50);
  }
  if (!stored.length) {
    return {
      ok: false,
      dealId,
      coupon: null,
      campaignId: null,
      title: null,
      score: 0,
      validated: false,
      detail: "catálogo de cupons vazio — rode Sync Cupons",
    };
  }

  const urlCampaign = (() => {
    const m = String(deal.product_url || deal.affiliate_url || "").match(
      /coupon_campaign_id=(\d+)/i,
    );
    return m?.[1] || null;
  })();

  const candidates = pickBestCouponsForProduct({
    title: deal.title,
    category: deal.category || "geral",
    price,
    limit: 16,
  });

  // Catálogo: só códigos digitáveis. Preferência: preferredCodes → campaign da URL → score.
  const preferred = (opts?.preferredCodes || []).map((c) =>
    String(c || "").toUpperCase(),
  );
  const ordered = [...candidates]
    .filter((c) => isDigitableCouponCode(c.code))
    .sort((a, b) => {
      const cat = (deal.category || "").toLowerCase();
      const prefA = preferred.some((p) => couponCodesMatch(p, a.code)) ? 1 : 0;
      const prefB = preferred.some((p) => couponCodesMatch(p, b.code)) ? 1 : 0;
      if (prefB !== prefA) return prefB - prefA;
      const urlA = urlCampaign && a.campaignId === urlCampaign ? 1 : 0;
      const urlB = urlCampaign && b.campaignId === urlCampaign ? 1 : 0;
      if (urlB !== urlA) return urlB - urlA;
      const aBr = cat === "tcg" && a.code === "BRINQUEDOS" ? 1 : 0;
      const bBr = cat === "tcg" && b.code === "BRINQUEDOS" ? 1 : 0;
      if (bBr !== aBr) return bBr - aBr;
      return (b.score || 0) - (a.score || 0);
    });
  if ((deal.category || "").toLowerCase() === "tcg") {
    const br = stored.find((c) => String(c.code || "").toUpperCase() === "BRINQUEDOS");
    if (br && !ordered.some((c) => String(c.code || "").toUpperCase() === "BRINQUEDOS")) {
      ordered.unshift({ ...br, score: 999 });
    }
  }

  if (!ordered.length) {
    return {
      ok: false,
      dealId,
      coupon: null,
      campaignId: null,
      title: null,
      score: 0,
      validated: false,
      detail: "nenhum cupom digitável compatível (seguir loja não é postado)",
    };
  }

  let chosen: (MlCoupon & { score: number }) | null = null;
  let detail = "";

  for (const cand of ordered) {
    if (!isDigitableCouponCode(cand.code)) continue;
    if (!couponAllowedForDealCategory(cand, deal.category || "geral")) {
      detail = `cupom ${cand.code} fora da categoria ${deal.category}`;
      continue;
    }
    if (!validate) {
      chosen = cand;
      detail = `match score=${cand.score} (sem validar lista)`;
      break;
    }
    const v = await validateCouponOnList({
      coupon: cand,
      title: deal.title,
      itemId: deal.external_id,
      productUrl: deal.product_url,
    });
    if (v.ok) {
      chosen = cand;
      detail = `${v.detail}; score=${cand.score}`;
      break;
    }
    detail = v.detail;
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!chosen) {
    getDb()
      .prepare(
        `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
         VALUES (?, NULL, NULL, NULL, 0, 0, ?, datetime('now'))
         ON CONFLICT(deal_id) DO UPDATE SET detail=excluded.detail, validated=0, updated_at=datetime('now')`,
      )
      .run(dealId, detail || "sem cupom válido");
    return {
      ok: false,
      dealId,
      coupon: null,
      campaignId: null,
      title: null,
      score: ordered[0]?.score || 0,
      validated: false,
      detail: detail || "nenhum candidato passou na validação",
    };
  }

  // Lista HTML pode dar falso positivo. Confirma no PDP: has_items + given_discount.
  if (validate && itemId && hubSessionReady()) {
    const pdpHit = await confirmDigitableCouponOnPdp({
      itemId,
      unitPrice: price,
      code: String(chosen.code || ""),
    });
    if (!pdpHit.ok) {
      // Rate-limit / só raw → não demove; tenta de novo depois.
      if (pdpHit.inconclusive) {
        getDb()
          .prepare(
            `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))
             ON CONFLICT(deal_id) DO UPDATE SET
               detail=excluded.detail,
               validated=0,
               updated_at=datetime('now')`,
          )
          .run(
            dealId,
            chosen.campaignId,
            displayCouponCode(chosen),
            chosen.title,
            chosen.score,
            pdpHit.detail,
          );
        return {
          ok: false,
          dealId,
          coupon: displayCouponCode(chosen),
          campaignId: chosen.campaignId,
          title: chosen.title,
          score: chosen.score,
          validated: false,
          detail: pdpHit.detail,
        };
      }
      getDb()
        .prepare(
          `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))
           ON CONFLICT(deal_id) DO UPDATE SET
             campaign_id=excluded.campaign_id,
             code=excluded.code,
             title=excluded.title,
             score=excluded.score,
             validated=0,
             detail=excluded.detail,
             updated_at=datetime('now')`,
        )
        .run(
          dealId,
          chosen.campaignId,
          displayCouponCode(chosen),
          chosen.title,
          chosen.score,
          pdpHit.detail,
        );
      getDb()
        .prepare(
          `UPDATE deals SET
             coupon_status = 'pending',
             price_with_coupon = NULL,
             status = CASE WHEN status = 'posted' THEN status ELSE 'hold_coupon' END
           WHERE id = ?`,
        )
        .run(dealId);
      return {
        ok: false,
        dealId,
        coupon: displayCouponCode(chosen),
        campaignId: chosen.campaignId,
        title: chosen.title,
        score: chosen.score,
        validated: false,
        detail: pdpHit.detail,
      };
    }
    // Usa o given real do PDP (não o % teórico do catálogo sozinho).
    return applyPdpPick(pdpHit.coupon);
  }

  const code = displayCouponCode(chosen);
  const quote = quoteCouponCart(price, chosen, { maxQty: 6 });
  const qty = quote.qty;
  // Sem %/R$ OFF conhecido: produto na lista ≠ desconto do cupom (não grava preço falso).
  const hasMeasurableCouponDiscount =
    quote.ok && quote.discount >= 0.5 && quote.unitAfter + 0.5 < price;
  let priceWithCoupon: number | null = null;
  if (hasMeasurableCouponDiscount) {
    priceWithCoupon = quote.unitAfter;
  } else if (qty < 1) {
    // Cupom exige carrinho impossível — não aplica desconto falso em 1 un.
    getDb()
      .prepare(
        `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))
         ON CONFLICT(deal_id) DO UPDATE SET detail=excluded.detail, validated=0, updated_at=datetime('now')`,
      )
      .run(
        dealId,
        chosen.campaignId,
        code,
        chosen.title,
        chosen.score,
        quote.reason || "mínimo do cupom inviável",
      );
    return {
      ok: false,
      dealId,
      coupon: code,
      campaignId: chosen.campaignId,
      title: chosen.title,
      score: chosen.score,
      validated: false,
      detail: quote.reason || "mínimo do cupom inviável para este preço",
    };
  } else if (
    !chosen.discountType ||
    chosen.discountType === "unknown" ||
    !(Number(chosen.discountValue) > 0)
  ) {
    getDb()
      .prepare(
        `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))
         ON CONFLICT(deal_id) DO UPDATE SET
           campaign_id=excluded.campaign_id,
           code=excluded.code,
           title=excluded.title,
           score=excluded.score,
           validated=0,
           detail=excluded.detail,
           updated_at=datetime('now')`,
      )
      .run(
        dealId,
        chosen.campaignId,
        code,
        chosen.title,
        chosen.score,
        "na lista do cupom sem %/R$ OFF conhecido — não postar (pode ser só oferta da loja)",
      );
    getDb()
      .prepare(
        `UPDATE deals SET
           coupon = ?,
           coupon_status = 'pending',
           price_with_coupon = NULL,
           status = CASE WHEN status = 'posted' THEN status ELSE 'hold_coupon' END
         WHERE id = ?`,
      )
      .run(code, dealId);
    return {
      ok: false,
      dealId,
      coupon: code,
      campaignId: chosen.campaignId,
      title: chosen.title,
      score: chosen.score,
      validated: false,
      detail:
        "cupom sem desconto mensurável neste produto (lista ≠ desconto; não confundir com seguir loja)",
    };
  } else if (!hasMeasurableCouponDiscount) {
    getDb()
      .prepare(
        `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))
         ON CONFLICT(deal_id) DO UPDATE SET
           campaign_id=excluded.campaign_id,
           code=excluded.code,
           title=excluded.title,
           score=excluded.score,
           validated=0,
           detail=excluded.detail,
           updated_at=datetime('now')`,
      )
      .run(
        dealId,
        chosen.campaignId,
        code,
        chosen.title,
        chosen.score,
        quote.reason || "cupom conhecido sem economia neste preço",
      );
    return {
      ok: false,
      dealId,
      coupon: code,
      campaignId: chosen.campaignId,
      title: chosen.title,
      score: chosen.score,
      validated: false,
      detail: quote.reason || "cupom sem economia mensurável neste preço",
    };
  }

  const qtyTip = formatCouponQtyDescBit(quote);
  const followTip = "";
  const descExtra = code
    ? `Cupom ML: ${chosen.title} · código ${code} · campanha ${chosen.campaignId}${qtyTip}`
    : `Desconto ML no link: ${chosen.title} · campanha ${chosen.campaignId}${qtyTip}`;
  const baseDesc = String(deal.description || "")
    .replace(/\n?Cupom ML:.*$/gim, "")
    .replace(/\n?Desconto ML.*$/gim, "")
    .replace(/\s*·\s*leve\s+\d+\s+un\.[^\n]*/gi, "")
    .replace(/\s*·\s*carrinho\s+R\$[^\n]*/gi, "")
    .replace(/\s*·\s*siga a loja[^\n]*/gi, "")
    .trim();
  const description = scrubCouponDescTips(`${baseDesc}\n${descExtra}`.trim());

  const productUrl = appendCampaignToAffiliateUrl(
    deal.product_url,
    chosen.campaignId,
  );

  // Regenera meli.la a partir da URL do produto + campaign (query no short link não funciona)
  let affiliateUrl = deal.affiliate_url;
  try {
    const { createAffiliateLink, withCouponCampaign, normalizeItemId } =
      await import("./mlHub.js");
    const itemId =
      normalizeItemId(deal.external_id) || normalizeItemId(deal.product_url);
    const origin =
      productUrl ||
      (itemId
        ? withCouponCampaign(
            `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`,
            chosen.campaignId,
          )
        : "");
    if (origin) {
      const link = await createAffiliateLink(origin, {
        couponCampaignId: chosen.campaignId,
      });
      if (link.shortUrl) affiliateUrl = link.shortUrl;
      else {
        logAntiBan(
          "ml_coupon_link_regen_fail",
          `deal=${dealId} campaign=${chosen.campaignId} ${link.error || "sem short"}`,
        );
      }
    }
  } catch (err) {
    logAntiBan(
      "ml_coupon_link_regen_err",
      err instanceof Error ? err.message : String(err),
    );
  }

  getDb()
    .prepare(
      `UPDATE deals SET
         coupon = ?,
         coupon_status = 'pending',
         price_with_coupon = ?,
         description = ?,
         product_url = ?,
         affiliate_url = ?,
         status = CASE WHEN status = 'posted' THEN status ELSE 'hold_coupon' END
       WHERE id = ?`,
    )
    .run(
      code, // null se campanha sem código digitável — não inventa 25%OFF
      priceWithCoupon != null && priceWithCoupon > 0 ? priceWithCoupon : null,
      description,
      productUrl,
      affiliateUrl,
      dealId,
    );

  getDb()
    .prepare(
      `INSERT INTO deal_coupon_matches (deal_id, campaign_id, code, title, score, validated, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
       ON CONFLICT(deal_id) DO UPDATE SET
         campaign_id=excluded.campaign_id,
         code=excluded.code,
         title=excluded.title,
         score=excluded.score,
         validated=1,
         detail=excluded.detail,
         updated_at=datetime('now')`,
    )
    .run(
      dealId,
      chosen.campaignId,
      code,
      chosen.title,
      chosen.score,
      code
        ? detail
        : `${detail}; desconto só no link (sem código digitável)`,
    );

  let test: Awaited<ReturnType<typeof applyCouponTestToDeal>> | undefined;
  if (getSetting("require_coupon_test", "1") === "1" || validate) {
    test = await applyCouponTestToDeal(dealId);
  }

  logAntiBan(
    "ml_coupon_match",
    `deal=${dealId} coupon=${code || "LINK_ONLY"} campaign=${chosen.campaignId} score=${chosen.score} ${detail}`,
  );

  return {
    ok: true,
    dealId,
    coupon: code,
    campaignId: chosen.campaignId,
    title: chosen.title,
    score: chosen.score,
    validated: true,
    detail,
    test,
  };
}

export async function enrichQueuedDealsWithCoupons(opts?: {
  limit?: number;
  syncFirst?: boolean;
  category?: string;
}): Promise<{
  ok: boolean;
  synced?: Awaited<ReturnType<typeof syncMlCouponsCatalog>>;
  matched: number;
  failed: number;
  scrubbed?: number;
  results: Array<Awaited<ReturnType<typeof enrichDealWithBestCoupon>>>;
}> {
  const scrubbed = scrubFakeCouponCodes().cleared;
  let synced: Awaited<ReturnType<typeof syncMlCouponsCatalog>> | undefined;
  if (opts?.syncFirst !== false && hubSessionReady()) {
    const age = getSetting("ml_coupons_synced_at", "");
    const stale = !age || Date.now() - Date.parse(age) > 30 * 60 * 1000;
    if (stale) synced = await syncMlCouponsCatalog({ maxPagesPerKey: 2 });
  }

  const limit = Math.max(1, Math.min(opts?.limit ?? 30, 80));
  const cat = String(opts?.category || "").trim();
  const deals = getDb()
    .prepare(
      cat
        ? `SELECT id FROM deals
           WHERE source = 'mercadolivre'
             AND status IN ('queued', 'hold_coupon')
             AND category = ?
             AND (coupon IS NULL OR coupon = '' OR coupon_status IN ('none', 'pending', 'invalid'))
           ORDER BY id DESC
           LIMIT ?`
        : `SELECT id FROM deals
           WHERE source = 'mercadolivre'
             AND status IN ('queued', 'hold_coupon')
             AND (coupon IS NULL OR coupon = '' OR coupon_status IN ('none', 'pending', 'invalid'))
           ORDER BY id DESC
           LIMIT ?`,
    )
    .all(...(cat ? [cat, limit] : [limit])) as Array<{ id: number }>;

  const results = [];
  let matched = 0;
  let failed = 0;
  for (const d of deals) {
    const r = await enrichDealWithBestCoupon(d.id, {
      validate: true,
      syncIfEmpty: false,
    });
    results.push(r);
    if (r.ok) matched++;
    else failed++;
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    ok: matched > 0 || deals.length === 0,
    synced,
    matched,
    failed,
    scrubbed,
    results,
  };
}

export async function testCouponsApi(): Promise<{
  ok: boolean;
  detail: string;
  total?: number;
  sample?: Array<{ title: string; code: string | null; campaignId: string }>;
}> {
  if (!hubSessionReady()) {
    return { ok: false, detail: "Sessão Hub ausente" };
  }
  const landing = await fetchCouponsFiltered({});
  if (!landing.coupons.length && !landing.total) {
    return { ok: false, detail: "API /cupons/api sem dados (cookie?)" };
  }
  return {
    ok: true,
    detail: `OK — ${landing.total || landing.coupons.length} cupons na landing`,
    total: landing.total,
    sample: landing.coupons.slice(0, 8).map((c) => ({
      title: c.title,
      code: c.code,
      campaignId: c.campaignId,
    })),
  };
}
