/**
 * Filtro de demanda / procura: evita nicho sem venda (químico gastronômico,
 * tempero pouch, cápsula vazia, toner de modelo, interfone, etc.) e prioriza
 * itens de uso comum com volume de venda.
 */
import { getDb } from "../db/index.js";

/** Normaliza título para match de nicho. */
function normTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Produtos de uso muito específico / baixa aceitação em grupos VIP de promo.
 * Bloqueia na fila, no sanitize e nas listas ML.
 */
export function isLowDemandNicheTitle(title: string): boolean {
  const t = normTitle(title);
  if (!t) return true;

  // Química / gastronomia molecular / insumos de lab
  if (
    /alginato|cloreto de calcio|agar agar|goma xantana|goma guar|transglutaminase|lecitina de soja em po|maltodextrina industrial/.test(
      t,
    )
  ) {
    return true;
  }

  // Temperos / especiarias em sachê de pouca procura no “achadinhos”
  if (
    /\bpaprica\b|defumada bombay|herbs?\s*&\s*spices|pouch\s*\d+\s*g|cominho em po|curry em po\b|sumac\b|zaatar\b/.test(
      t,
    ) ||
    (/temperos?|especiarias?/i.test(t) && /pouch|sach[eê]|20g|25g|30g/.test(t))
  ) {
    return true;
  }

  // Cápsulas vazias / encapsulamento / farma artesanal
  if (
    /capsulas?\s+vazias?|gelatina incolor|para encapsulamento|encapsulamento|n[ºo°]?\s*0\s+para encaps|digna farma|manipula[cç][aã]o/.test(
      t,
    )
  ) {
    return true;
  }

  // Toner / cartucho / ribbon de impressora (modelo específico = poucos cliques)
  if (
    /\btoner\b|cartucho(?:s)?(?:\s+de\s+tinta)?|tinta para impressora|ribbon de impressora|fotocondutor|drum unit|toner compativel|toner original/.test(
      t,
    ) ||
    (/impressora/.test(t) && /toner|cartucho|refil de tinta/.test(t))
  ) {
    return true;
  }

  // Peças / insumos muito específicos (pouca aceitação no grupo)
  if (
    /interfone|porteiro eletronico|fechadura digital(?!.*smart)|modulo wifi para portao|placa mae de impressora|cabeca de impressao/.test(
      t,
    )
  ) {
    return true;
  }

  // Mini compressor / bomba elétrica de pneu — baixo clique em grupos VIP
  if (
    /mini\s*compressor|compressor de ar portatil|compressor 12v|bomba eletrica (?:de )?(?:ar|pneu)|inflador (?:de )?pneu|compressor veicular/.test(
      t,
    )
  ) {
    return true;
  }

  // Outros nichos ruins para volume
  if (
    /reagente|solu[cç][aã]o padr[aã]o|meio de cultura|pipeta|erlenmeyer|balan[cç]a analitica|filamento dental|agulha hipodermica/.test(
      t,
    )
  ) {
    return true;
  }

  return false;
}

/** Extrai “vendidos” do HTML da PDP ou JSON embutido. */
export function extractSoldQuantityFromHtml(html: string): number | null {
  if (!html) return null;
  const json = html.match(/"sold_quantity"\s*:\s*(\d+)/i);
  if (json) {
    const n = Number(json[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const mil = html.match(
    /(?:mais\s+de\s+)?([\d.]+)\s*mil\s*\+?\s*vendidos?/i,
  );
  if (mil) {
    const n = Number(String(mil[1]).replace(/\./g, "")) * 1000;
    if (Number.isFinite(n)) return Math.round(n);
  }
  const plus = html.match(/([\d.]+)\s*\+\s*vendidos?/i);
  if (plus) {
    const n = Number(String(plus[1]).replace(/\./g, ""));
    if (Number.isFinite(n)) return n;
  }
  const plain = html.match(/([\d.]+)\s*vendidos?/i);
  if (plain) {
    const n = Number(String(plain[1]).replace(/\./g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function ensureSoldQuantityColumn(): void {
  const cols = getDb()
    .prepare(`PRAGMA table_info(deals)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "sold_quantity")) {
    getDb().exec(`ALTER TABLE deals ADD COLUMN sold_quantity INTEGER`);
  }
}

/** Score de demanda para ranking (0–40). */
export function demandScore(opts: {
  title: string;
  soldQuantity?: number | null;
}): number {
  if (isLowDemandNicheTitle(opts.title)) return -80;
  const sold = Number(opts.soldQuantity);
  if (!Number.isFinite(sold) || sold < 0) return 0;
  if (sold >= 5000) return 40;
  if (sold >= 1000) return 32;
  if (sold >= 500) return 24;
  if (sold >= 100) return 16;
  if (sold >= 25) return 8;
  if (sold >= 5) return 2;
  return -15;
}

/** Mínimo de vendas para postar em Achadinhos/geral (quando conhecido). */
export function failsDemandGate(opts: {
  title: string;
  category?: string | null;
  soldQuantity?: number | null;
}): boolean {
  if (isLowDemandNicheTitle(opts.title)) return true;
  const cat = String(opts.category || "").toLowerCase();
  if (cat === "tcg" || cat === "games") return false;
  const sold = opts.soldQuantity;
  if (sold == null || !Number.isFinite(Number(sold))) return false;
  if (Number(sold) < 5 && /geral|casa|alimentos|moda/.test(cat || "geral")) {
    return true;
  }
  return false;
}
