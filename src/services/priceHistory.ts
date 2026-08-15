/**
 * Histórico de preço por anúncio (MLB…).
 *
 * Como o “menor preço” é decidido (só isso entra no post):
 *
 * 1) Fonte oficial: o Mercado Livre publica no anúncio o
 *    “menor preço dos últimos 30 dias” (Lei 14.181). Extraímos esse
 *    número do HTML/JSON do PDP e gravamos como snapshot `ml_30d`.
 * 2) Preço atual do post = PIX com cupom, se o cupom foi testado;
 *    senão o preço à vista do anúncio. Nunca parcela.
 * 3) Se PIX atual ≤ ml_30d (folga de ~0,8%), o post GANHA a linha
 *    “Menor valor dos últimos 30 dias”. Isso chama atenção.
 * 4) Se NÃO for o menor: o post mostra só De/Por + cupom. Nunca
 *    escrevemos “já foi mais barato” — isso mata a conversão.
 *
 * Snapshots locais e testes de cupom antigos NÃO viram frase pública.
 * Servem só para o painel interno.
 */
import { getDb, logAntiBan } from "../db/index.js";
import { isPlausibleProductPrice, roundMoney } from "./priceSanity.js";
import { normalizeItemId } from "./mlHub.js";

export type PriceHistoryVerdict = {
  current: number;
  lowest: number | null;
  lowestHadCoupon: boolean;
  lowestSource: string | null;
  /** true = atual ≤ menor 30 dias oficial do ML */
  isLowest: boolean | null;
  /** atual está pior que um menor já visto (não postar) */
  isWorseThanHistory: boolean;
  /** menor preço dos últimos 30 dias extraído do anúncio (Lei 14.181) */
  official30d: number | null;
  samples: number;
  line: string;
};

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS deal_price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      deal_id INTEGER,
      price REAL NOT NULL,
      price_with_coupon REAL,
      coupon TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      seller_id TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_snap_item
      ON deal_price_snapshots(item_id, observed_at);
  `);
  try {
    getDb().exec(`ALTER TABLE deal_price_snapshots ADD COLUMN seller_id TEXT`);
  } catch {
    /* já existe */
  }
  try {
    getDb().exec(`
      CREATE INDEX IF NOT EXISTS idx_price_snap_seller
        ON deal_price_snapshots(seller_id, observed_at);
    `);
  } catch {
    /* índice/coluna ainda indisponível */
  }
}

function brl(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function parseBrlAmount(raw: string): number | null {
  const s = String(raw || "")
    .replace(/R\$\s?/gi, "")
    .replace(/\u00a0/g, "")
    .trim();
  if (!s) return null;
  let n: number;
  if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(s) || /^\d+,\d{2}$/.test(s)) {
    n = Number(s.replace(/\./g, "").replace(",", "."));
  } else {
    n = Number(s.replace(",", "."));
  }
  if (!isPlausibleProductPrice(n)) return null;
  return roundMoney(n);
}

export function itemIdFromDeal(deal: {
  external_id?: string | null;
  product_url?: string | null;
  affiliate_url?: string | null;
}): string | null {
  return (
    normalizeItemId(deal.external_id) ||
    normalizeItemId(deal.product_url) ||
    normalizeItemId(deal.affiliate_url)
  );
}

/** Extrai o menor preço de 30 dias (e similares) do HTML do anúncio. */
export function extractLowest30dFromHtml(html: string): number | null {
  if (!html) return null;
  const text = html.replace(/\s+/g, " ");
  const candidates: number[] = [];
  const push = (n: number | null) => {
    if (n != null && isPlausibleProductPrice(n)) candidates.push(n);
  };

  const brlNear30d = [
    /menor pre[cç]o dos [uú]ltimos 30 dias[^R$]{0,80}R\$\s*([\d.]{1,12},\d{2})/i,
    /pre[cç]o m[ií]nimo (?:dos )?30 dias[^R$]{0,80}R\$\s*([\d.]{1,12},\d{2})/i,
    /30 dias[^R$]{0,40}R\$\s*([\d.]{1,12},\d{2})/i,
  ];
  for (const re of brlNear30d) {
    const m = text.match(re);
    if (m) push(parseBrlAmount(m[1]));
  }

  const jsonPatterns = [
    /"type"\s*:\s*"(?:min_30_days|was_price|reference_price|lowest_price)"[^}]{0,180}"amount"\s*:\s*(\d+(?:\.\d+)?)/gi,
    /"amount"\s*:\s*(\d+(?:\.\d+)?)[^}]{0,180}"type"\s*:\s*"(?:min_30_days|was_price|reference_price|lowest_price)"/gi,
    /"lowest_price(?:_30d|_30_days)?"\s*:\s*(\d+(?:\.\d+)?)/gi,
    /"min_price(?:_30d|_30_days)?"\s*:\s*(\d+(?:\.\d+)?)/gi,
    /"reference_price"\s*:\s*(\d+(?:\.\d+)?)/gi,
  ];
  for (const re of jsonPatterns) {
    for (const m of html.matchAll(re)) {
      push(roundMoney(Number(m[1])));
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  return candidates[0];
}

export function recordPriceSnapshot(opts: {
  itemId?: string | null;
  dealId?: number | null;
  price: number;
  priceWithCoupon?: number | null;
  coupon?: string | null;
  source: string;
  sellerId?: string | null;
}): boolean {
  ensureTable();
  const itemId = normalizeItemId(opts.itemId) || String(opts.itemId || "").trim();
  if (!itemId || !isPlausibleProductPrice(opts.price)) return false;
  const couponPrice =
    opts.priceWithCoupon != null &&
    isPlausibleProductPrice(opts.priceWithCoupon, { reference: opts.price }) &&
    opts.priceWithCoupon + 0.009 < opts.price
      ? roundMoney(opts.priceWithCoupon)
      : null;
  const price = roundMoney(opts.price);

  const last = getDb()
    .prepare(
      `SELECT price, price_with_coupon, source, observed_at
       FROM deal_price_snapshots
       WHERE item_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(itemId) as
    | {
        price: number;
        price_with_coupon: number | null;
        source: string;
        observed_at: string;
      }
    | undefined;

  if (last) {
    const samePrice = Math.abs(Number(last.price) - price) < 0.05;
    const sameCoupon =
      Math.abs(Number(last.price_with_coupon || 0) - Number(couponPrice || 0)) <
      0.05;
    const lastMs = Date.parse(String(last.observed_at).replace(" ", "T") + "Z");
    const recent =
      Number.isFinite(lastMs) && Date.now() - lastMs < 2 * 3600_000;
    if (samePrice && sameCoupon && recent && last.source === opts.source) {
      return false;
    }
  }

  getDb()
    .prepare(
      `INSERT INTO deal_price_snapshots
        (item_id, deal_id, price, price_with_coupon, coupon, source, seller_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      opts.dealId ?? null,
      price,
      couponPrice,
      opts.coupon ? String(opts.coupon).trim().toUpperCase() : null,
      opts.source.slice(0, 40),
      opts.sellerId ? String(opts.sellerId).slice(0, 40) : null,
    );
  return true;
}

type DealLike = {
  id?: number;
  external_id?: string | null;
  product_url?: string | null;
  affiliate_url?: string | null;
  price: number;
  price_with_coupon?: number | null;
  coupon?: string | null;
  old_price?: number | null;
  seller_id?: string | null;
};

export function recordDealSnapshot(
  deal: DealLike,
  source = "deal",
  extra?: { lowest30d?: number | null },
): void {
  const itemId = itemIdFromDeal(deal);
  if (!itemId) return;
  recordPriceSnapshot({
    itemId,
    dealId: deal.id,
    price: deal.price,
    priceWithCoupon: deal.price_with_coupon,
    coupon: deal.coupon,
    source,
    sellerId: deal.seller_id,
  });
  if (
    extra?.lowest30d != null &&
    isPlausibleProductPrice(extra.lowest30d, { reference: deal.price })
  ) {
    recordPriceSnapshot({
      itemId,
      dealId: deal.id,
      price: extra.lowest30d,
      priceWithCoupon: null,
      coupon: null,
      source: "ml_30d",
    });
  }
}

type LowestRow = {
  amount: number;
  hadCoupon: boolean;
  source: string;
};

function collectLows(itemId: string): LowestRow[] {
  ensureTable();
  const out: LowestRow[] = [];
  const snaps = getDb()
    .prepare(
      `SELECT price, price_with_coupon, coupon, source
       FROM deal_price_snapshots WHERE item_id = ?`,
    )
    .all(itemId) as Array<{
    price: number;
    price_with_coupon: number | null;
    coupon: string | null;
    source: string;
  }>;
  for (const s of snaps) {
    const src = String(s.source || "");
    const fromCouponTest = /coupon_test/.test(src);
    // Preço com cupom de teste antigo NÃO entra no “menor 30 dias” público.
    // Entra só no gate interno (não postar se hoje está mais caro).
    if (isPlausibleProductPrice(s.price_with_coupon, { reference: s.price })) {
      out.push({
        amount: roundMoney(Number(s.price_with_coupon)),
        hadCoupon: true,
        source: fromCouponTest ? "coupon_test" : src || "snap",
      });
    }
    if (isPlausibleProductPrice(s.price)) {
      out.push({
        amount: roundMoney(Number(s.price)),
        hadCoupon: false,
        source: src || "snap",
      });
    }
  }

  const tests = getDb()
    .prepare(
      `SELECT final_price, coupon, ok
       FROM coupon_tests
       WHERE item_id = ? OR item_id LIKE ?
       ORDER BY id DESC LIMIT 40`,
    )
    .all(itemId, `%${itemId.replace(/^MLB/i, "")}%`) as Array<{
    final_price: number | null;
    coupon: string | null;
    ok: number;
  }>;
  for (const t of tests) {
    if (!t.ok || !isPlausibleProductPrice(t.final_price)) continue;
    out.push({
      amount: roundMoney(Number(t.final_price)),
      hadCoupon: Boolean(t.coupon),
      source: "coupon_test",
    });
  }

  const deals = getDb()
    .prepare(
      `SELECT price, price_with_coupon, coupon
       FROM deals
       WHERE external_id LIKE ? OR product_url LIKE ? OR affiliate_url LIKE ?`,
    )
    .all(`%${itemId}%`, `%${itemId}%`, `%${itemId}%`) as Array<{
    price: number;
    price_with_coupon: number | null;
    coupon: string | null;
  }>;
  for (const d of deals) {
    if (isPlausibleProductPrice(d.price_with_coupon, { reference: d.price })) {
      out.push({
        amount: roundMoney(Number(d.price_with_coupon)),
        hadCoupon: true,
        source: "deal",
      });
    }
    if (isPlausibleProductPrice(d.price)) {
      out.push({
        amount: roundMoney(Number(d.price)),
        hadCoupon: false,
        source: "deal",
      });
    }
  }
  return out;
}

export function getPriceHistoryVerdict(deal: DealLike): PriceHistoryVerdict {
  const empty: PriceHistoryVerdict = {
    current: deal.price,
    lowest: null,
    lowestHadCoupon: false,
    lowestSource: null,
    isLowest: null,
    isWorseThanHistory: false,
    official30d: null,
    samples: 0,
    line: "",
  };
  const itemId = itemIdFromDeal(deal);
  const listedOk = isPlausibleProductPrice(deal.price, {
    reference: deal.old_price,
  });
  const couponOk = isPlausibleProductPrice(deal.price_with_coupon, {
    reference: deal.old_price || deal.price,
  });
  const current = couponOk
    ? Number(deal.price_with_coupon)
    : listedOk
      ? deal.price
      : isPlausibleProductPrice(deal.old_price)
        ? Number(deal.old_price)
        : deal.price;
  if (!itemId || !isPlausibleProductPrice(current)) {
    return { ...empty, current };
  }

  const rows = collectLows(itemId);
  if (!rows.length) return { ...empty, current };

  const officialRows = rows.filter((r) => r.source === "ml_30d");
  officialRows.sort((a, b) => a.amount - b.amount);
  const official30d = officialRows[0]?.amount ?? null;

  rows.sort((a, b) => a.amount - b.amount);
  const best = rows[0];
  const uniqueAmounts = new Set(rows.map((r) => Math.round(r.amount * 100)));
  const samples = uniqueAmounts.size;
  const eps = Math.max(0.5, current * 0.008);
  const worseEps = Math.max(current * 0.08, 1);

  const isLowest =
    official30d != null ? current <= official30d + eps : null;
  const isWorseThanHistory =
    best != null && current > best.amount + worseEps;

  // Público: só afirma menor 30 dias com o número oficial do anúncio.
  // Nunca escrever “já foi mais barato” — isso mata a promo.
  let line = "";
  if (isLowest === true) {
    line = `👑 MENOR PREÇO DOS ÚLTIMOS 30 DIAS`;
  }

  return {
    current: roundMoney(current),
    lowest: best.amount,
    lowestHadCoupon: best.hadCoupon,
    lowestSource: best.source,
    isLowest,
    isWorseThanHistory,
    official30d,
    samples,
    line,
  };
}

/** Pontos do gráfico de 30 dias (preço observado, mais antigo → mais novo). */
export function sparklineForDeal(deal: DealLike): number[] {
  const itemId = itemIdFromDeal(deal);
  if (!itemId) return [];
  ensureTable();
  const rows = getDb()
    .prepare(
      `SELECT price FROM deal_price_snapshots
       WHERE item_id = ? AND observed_at >= datetime('now', '-30 days')
       ORDER BY observed_at ASC LIMIT 40`,
    )
    .all(itemId) as Array<{ price: number }>;
  return rows
    .map((r) => Number(r.price))
    .filter((n) => isPlausibleProductPrice(n));
}

/** Garante snapshot do preço atual + 30 dias (HTML já baixado no refresh). */
export function ingestLiveHistory(
  deal: DealLike,
  opts?: { lowest30d?: number | null; source?: string },
): PriceHistoryVerdict {
  recordDealSnapshot(deal, opts?.source || "live", {
    lowest30d: opts?.lowest30d,
  });
  return getPriceHistoryVerdict(deal);
}

export function sellerPriceHistory(
  sellerId: string,
  days = 30,
): Array<{ itemId: string; price: number; observedAt: string }> {
  ensureTable();
  const id = String(sellerId || "").trim();
  if (!id) return [];
  return getDb()
    .prepare(
      `SELECT item_id AS itemId, price, observed_at AS observedAt
       FROM deal_price_snapshots
       WHERE seller_id = ? AND observed_at >= datetime('now', ?)
       ORDER BY observed_at DESC
       LIMIT 80`,
    )
    .all(id, `-${Math.max(7, days)} days`) as Array<{
    itemId: string;
    price: number;
    observedAt: string;
  }>;
}

export function seedSnapshotsFromLegacy(): number {
  ensureTable();
  const count = (
    getDb()
      .prepare(`SELECT COUNT(*) AS c FROM deal_price_snapshots`)
      .get() as { c: number }
  ).c;
  if (count > 0) return 0;
  const deals = getDb()
    .prepare(
      `SELECT id, external_id, product_url, affiliate_url, price, price_with_coupon, coupon
       FROM deals WHERE price > 0`,
    )
    .all() as DealLike[];
  let n = 0;
  for (const d of deals) {
    recordDealSnapshot(d, "seed");
    n += 1;
  }
  const tests = getDb()
    .prepare(
      `SELECT deal_id, item_id, coupon, final_price, original_price
       FROM coupon_tests WHERE ok = 1 AND final_price > 0`,
    )
    .all() as Array<{
    deal_id: number | null;
    item_id: string | null;
    coupon: string | null;
    final_price: number;
    original_price: number | null;
  }>;
  for (const t of tests) {
    const itemId = normalizeItemId(t.item_id) || t.item_id;
    if (!itemId) continue;
    if (
      recordPriceSnapshot({
        itemId,
        dealId: t.deal_id,
        price: t.original_price || t.final_price,
        priceWithCoupon: t.final_price,
        coupon: t.coupon,
        source: "coupon_test_seed",
      })
    ) {
      n += 1;
    }
  }
  if (n) logAntiBan("price_history_seed", `snapshots=${n}`);
  return n;
}
