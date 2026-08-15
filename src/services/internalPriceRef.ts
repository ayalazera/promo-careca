/**
 * Referência interna de preço (estilo Keepa/Zoom) — sem API externa.
 * Usa histórico próprio + faixa “mercado interno” para o painel.
 */
import { getDb, type Deal } from "../db/index.js";
import { getPriceHistoryVerdict, sellerPriceHistory } from "./priceHistory.js";

export type InternalPriceRef = {
  dealId: number;
  mlb: string | null;
  ourPrice: number;
  lowest30d: number | null;
  isLowest30d: boolean;
  worseThanHistory: boolean;
  sellerId: string | null;
  sellerSamples: number;
  sellerAvg: number | null;
  /** Faixa interna só para operador (não vai no post). */
  internalNote: string;
};

export function buildInternalPriceRef(deal: Deal): InternalPriceRef {
  const verdict = getPriceHistoryVerdict(deal);
  const price = Number(deal.price_with_coupon || deal.price) || 0;
  const sellerId = deal.seller_id ? String(deal.seller_id) : null;
  let sellerSamples = 0;
  let sellerAvg: number | null = null;
  if (sellerId) {
    const hist = sellerPriceHistory(sellerId, 40);
    sellerSamples = hist.length;
    if (hist.length) {
      sellerAvg =
        hist.reduce((a, h) => a + Number(h.price || 0), 0) / hist.length;
    }
  }
  let note = "sem histórico suficiente";
  if (verdict.isLowest) note = "menor preço 30d (histórico interno)";
  else if (verdict.isWorseThanHistory) note = "acima do histórico 30d — rebaixar";
  else if (verdict.lowest != null) {
    note = `ref. interna 30d: R$ ${Number(verdict.lowest).toFixed(2)}`;
  }
  if (sellerAvg != null && price > sellerAvg * 1.15) {
    note += " · acima da média do vendedor";
  }
  return {
    dealId: deal.id,
    mlb: deal.external_id || null,
    ourPrice: price,
    lowest30d: verdict.lowest != null ? Number(verdict.lowest) : null,
    isLowest30d: Boolean(verdict.isLowest),
    worseThanHistory: Boolean(verdict.isWorseThanHistory),
    sellerId,
    sellerSamples,
    sellerAvg,
    internalNote: note,
  };
}

export function listSellerHistoryApi(sellerId: string, limit = 30) {
  return sellerPriceHistory(String(sellerId), limit);
}

/** Contagem de moda postada na última hora (anti-viés). */
export function fashionPostsLastHour(groupId: number): number {
  const rows = getDb()
    .prepare(
      `SELECT d.title AS title FROM post_logs pl
       JOIN deals d ON d.id = pl.deal_id
       WHERE pl.ok = 1 AND pl.group_id = ?
         AND pl.created_at >= datetime('now', '-1 hour')`,
    )
    .all(groupId) as Array<{ title: string }>;
  return rows.filter((r) =>
    /legging|camiseta|cropped|meia|calça|blusa|vestido|fitness/i.test(
      r.title || "",
    ),
  ).length;
}
