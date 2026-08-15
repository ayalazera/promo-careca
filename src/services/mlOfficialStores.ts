/**
 * Lojas oficiais do ML (ex.: Pokémon) mapeadas a categorias (TCG…).
 * Fonte alternativa quando o Hub de afiliados não traz o nicho.
 */
import { getDb, logAntiBan } from "../db/index.js";
import {
  classifyProduct,
  listCategories,
} from "./categories.js";
import {
  extractListingProductsFromHtml,
  type HubProduct,
  normalizeItemId,
} from "./mlHub.js";

export type OfficialStore = {
  id: number;
  name: string;
  list_url: string;
  category: string;
  commission_hint: number;
  active: number;
  max_items: number;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
};

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS official_stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      list_url TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      commission_hint REAL NOT NULL DEFAULT 12,
      active INTEGER NOT NULL DEFAULT 1,
      max_items INTEGER NOT NULL DEFAULT 16,
      last_synced_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** Converte link de lista/loja para a URL que o ML serve sem challenge. */
export function normalizeStoreListUrl(input: string): string {
  let u = String(input || "").trim();
  if (!u) return "";
  // remove tracking
  u = u.split("#")[0].split("&tracking_id")[0];
  try {
    const parsed = new URL(u.startsWith("http") ? u : `https://${u}`);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    // lista.mercadolivre.com.br/loja/pokemon → www.../loja/pokemon
    const m = path.match(/\/loja\/([^/]+)/i);
    if (m) {
      return `https://www.mercadolivre.com.br/loja/${decodeURIComponent(m[1])}`;
    }
    if (/mercadolivre\.com\.br$/i.test(parsed.hostname)) {
      return `https://www.mercadolivre.com.br${path}`;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

export function seedOfficialStores(): void {
  ensureTable();
  const poke = getDb()
    .prepare(`SELECT id FROM official_stores WHERE list_url LIKE '%/loja/pokemon%'`)
    .get() as { id?: number } | undefined;
  if (!poke?.id) {
    getDb()
      .prepare(
        `INSERT INTO official_stores (name, list_url, category, commission_hint, active, max_items)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        "Pokémon (oficial)",
        "https://www.mercadolivre.com.br/loja/pokemon",
        "tcg",
        12,
        28,
      );
  }
  // Asmodee (TCG board/cards) se ainda não existir
  const asmo = getDb()
    .prepare(`SELECT id FROM official_stores WHERE list_url LIKE '%/loja/asmodee%'`)
    .get() as { id?: number } | undefined;
  if (!asmo?.id) {
    getDb()
      .prepare(
        `INSERT INTO official_stores (name, list_url, category, commission_hint, active, max_items)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        "Asmodee",
        "https://www.mercadolivre.com.br/loja/asmodee",
        "tcg",
        12,
        28,
      );
  }
  // Copag (cartas oficiais BR)
  const copag = getDb()
    .prepare(`SELECT id FROM official_stores WHERE list_url LIKE '%/loja/copag%'`)
    .get() as { id?: number } | undefined;
  if (!copag?.id) {
    getDb()
      .prepare(
        `INSERT INTO official_stores (name, list_url, category, commission_hint, active, max_items)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        "Copag",
        "https://www.mercadolivre.com.br/loja/copag",
        "tcg",
        12,
        28,
      );
  }
  getDb()
    .prepare(
      `UPDATE official_stores SET max_items = 28
       WHERE category = 'tcg' AND active = 1 AND max_items < 28`,
    )
    .run();

  const extra: Array<[string, string, string, number, number]> = [
    ["PlayStation (oficial)", "https://www.mercadolivre.com.br/loja/playstation", "games", 10, 16],
    ["Xbox (oficial)", "https://www.mercadolivre.com.br/loja/xbox", "games", 10, 16],
    ["Nintendo (oficial)", "https://www.mercadolivre.com.br/loja/nintendo", "games", 10, 16],
    ["Electrolux (oficial)", "https://www.mercadolivre.com.br/loja/electrolux", "casa", 8, 16],
    ["Tramontina (oficial)", "https://www.mercadolivre.com.br/loja/tramontina", "casa", 8, 16],
    ["Philips (oficial)", "https://www.mercadolivre.com.br/loja/philips", "casa", 8, 16],
    ["Ultra Pro", "https://www.mercadolivre.com.br/loja/ultra-pro", "tcg", 10, 24],
    ["Konami", "https://www.mercadolivre.com.br/loja/konami", "tcg", 10, 24],
  ];
  for (const [name, url, cat, hint, max] of extra) {
    const slug = url.replace(/^https?:\/\/www\.mercadolivre\.com\.br/, "");
    const exists = getDb()
      .prepare(`SELECT id FROM official_stores WHERE list_url LIKE ?`)
      .get(`%${slug}%`) as { id?: number } | undefined;
    if (exists?.id) continue;
    getDb()
      .prepare(
        `INSERT INTO official_stores (name, list_url, category, commission_hint, active, max_items)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(name, url, cat, hint, max);
  }
}

export function listOfficialStores(opts?: {
  activeOnly?: boolean;
}): OfficialStore[] {
  ensureTable();
  seedOfficialStores();
  const sql = opts?.activeOnly
    ? `SELECT * FROM official_stores WHERE active = 1 ORDER BY id ASC`
    : `SELECT * FROM official_stores ORDER BY id ASC`;
  return getDb().prepare(sql).all() as OfficialStore[];
}

export function getOfficialStore(id: number): OfficialStore | undefined {
  ensureTable();
  return getDb()
    .prepare(`SELECT * FROM official_stores WHERE id = ?`)
    .get(id) as OfficialStore | undefined;
}

export function upsertOfficialStore(input: {
  id?: number;
  name: string;
  listUrl: string;
  category: string;
  commissionHint?: number;
  active?: boolean;
  maxItems?: number;
}): OfficialStore {
  ensureTable();
  const name = String(input.name || "").trim();
  const listUrl = normalizeStoreListUrl(input.listUrl);
  const category = String(input.category || "geral").trim().toLowerCase();
  if (!name) throw new Error("Informe o nome da loja");
  if (!listUrl || !/\/loja\//i.test(listUrl)) {
    throw new Error(
      "Cole o link da loja oficial (ex.: https://www.mercadolivre.com.br/loja/pokemon)",
    );
  }
  const known = new Set(listCategories().map((c) => c.id));
  if (!known.has(category)) {
    throw new Error(`Categoria desconhecida: ${category}`);
  }
  const commission = Math.max(
    0,
    Math.min(80, Number(input.commissionHint ?? 12) || 12),
  );
  const maxItems = Math.max(1, Math.min(40, Number(input.maxItems ?? 16) || 16));
  const active = input.active === false ? 0 : 1;

  if (input.id) {
    getDb()
      .prepare(
        `UPDATE official_stores
         SET name = ?, list_url = ?, category = ?, commission_hint = ?,
             active = ?, max_items = ?
         WHERE id = ?`,
      )
      .run(name, listUrl, category, commission, active, maxItems, input.id);
    const updated = getOfficialStore(input.id);
    if (!updated) throw new Error("Loja não encontrada");
    return updated;
  }

  const info = getDb()
    .prepare(
      `INSERT INTO official_stores (name, list_url, category, commission_hint, active, max_items)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, listUrl, category, commission, active, maxItems);
  return getOfficialStore(Number(info.lastInsertRowid))!;
}

export function deleteOfficialStore(id: number): boolean {
  ensureTable();
  return getDb().prepare(`DELETE FROM official_stores WHERE id = ?`).run(id)
    .changes > 0;
}

function AbortTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function itemIdFromStoreHref(href: string): string | null {
  const h = href.replace(/&amp;/g, "&");
  const wid = h.match(/(?:[?&#](?:wid|item_id)=|item_id%3A)(MLB\d{6,})/i);
  if (wid) return wid[1].toUpperCase();
  const pathId = h.match(/\/(MLB-?\d{6,})(?:\?|#|$)/i);
  if (pathId) return pathId[1].replace(/-/g, "").toUpperCase();
  // catálogo /p/MLB123 — preferir wid do query se houver
  const catalog = h.match(/\/p\/(MLB\d{6,})/i);
  if (catalog) return catalog[1].toUpperCase();
  return normalizeItemId(h);
}

function parseMoneyChunk(raw: string): number {
  const s = String(raw || "").trim();
  if (!s) return 0;
  if (/,/.test(s) && /\./.test(s)) {
    return Number(s.replace(/\./g, "").replace(",", ".")) || 0;
  }
  if (/,/.test(s)) return Number(s.replace(",", ".")) || 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function priceNear(chunk: string): number {
  const frac = chunk.match(/andes-money-amount__fraction[^>]*>(\d[\d.]*)/);
  const cents = chunk.match(/andes-money-amount__cents[^>]*>(\d{1,2})/);
  if (frac) {
    const whole = Number(String(frac[1]).replace(/\./g, ""));
    if (Number.isFinite(whole)) {
      const c = cents ? Number(cents[1]) : 0;
      const n = whole + (Number.isFinite(c) ? c / 100 : 0);
      if (n > 0) return n;
    }
  }
  const aria = chunk.match(
    /andes-money-amount[^>]*aria-label="(\d+(?:[.,]\d+)?)\s*reais/i,
  );
  if (aria) {
    const n = parseMoneyChunk(aria[1]);
    if (n > 0) return n;
  }
  const raw = chunk.match(/data-andes-money-amount[^>]*>([\d.,]+)/);
  if (raw) {
    const n = parseMoneyChunk(raw[1]);
    if (n > 0) return n;
  }
  const json = chunk.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/);
  if (json) {
    const n = Number(json[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Extrai produtos de páginas de loja oficial (polycard + títulos reais). */
export function extractStoreProductsFromHtml(html: string): HubProduct[] {
  const text = html
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
  const seen = new Set<string>();
  const out: HubProduct[] = [];

  // <a href="..." class="poly-component__title">Título</a> (ordem dos attrs varia)
  const titleAnchors = [
    ...text.matchAll(
      /<a\b([^>]*class="[^"]*poly-component__title[^"]*"[^>]*)>([^<]{8,200})<\/a>/gi,
    ),
  ];
  for (const m of titleAnchors) {
    const attrs = m[1] || "";
    const title = m[2].trim();
    const hrefMatch = attrs.match(/href="([^"]+)"/i);
    const href = hrefMatch?.[1]?.replace(/&amp;/g, "&") || "";
    // wid costuma estar no href; senão, no bloco ao redor
    let itemId = href ? itemIdFromStoreHref(href) : null;
    if (!itemId) {
      const around = text.slice(
        Math.max(0, m.index! - 400),
        Math.min(text.length, m.index! + m[0].length + 1800),
      );
      const wid =
        around.match(/[?&#]wid=(MLB\d{6,})/i) ||
        around.match(/item_id[=%]3A?(MLB\d{6,})/i) ||
        around.match(/\b(MLB\d{8,})\b/);
      itemId = wid ? wid[1].toUpperCase() : null;
    }
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    const around = text.slice(
      Math.max(0, m.index! - 200),
      Math.min(text.length, m.index! + m[0].length + 1200),
    );
    const productUrl =
      href && href.startsWith("http")
        ? href.split("#")[0]
        : `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`;
    out.push({
      itemId,
      title,
      price: priceNear(around),
      oldPrice: null,
      imageUrl: null,
      productUrl,
      commissionPct: 0,
      badge: null,
      category: "geral",
    });
  }

  if (out.length >= 12) return out;

  // fallback: parser genérico de listagens + MLB longos
  const base = extractListingProductsFromHtml(html);
  for (const p of base) {
    const id = normalizeItemId(p.itemId) || p.itemId;
    if (!id || seen.has(id)) continue;
    if (/^Produto |^Eletr[oô]nico /i.test(p.title) && out.length) continue;
    seen.add(id);
    out.push(p);
  }
  // Lojas oficiais (Pokémon) às vezes só expõem 3 títulos no HTML; IDs MLB ainda vêm no JSON embutido
  if (out.length < 20) {
    for (const id of text.matchAll(/\b(MLB\d{9,})\b/g)) {
      const itemId = id[1].toUpperCase();
      if (seen.has(itemId)) continue;
      // IDs curtos (8 dígitos) costumam ser categoria/domínio, não anúncio
      if (!/^MLB\d{9,}$/i.test(itemId)) continue;
      seen.add(itemId);
      const around = text.slice(
        Math.max(0, id.index! - 120),
        Math.min(text.length, id.index! + 220),
      );
      const titleGuess =
        around.match(/"title"\s*:\s*"([^"]{8,160})"/i)?.[1] ||
        around.match(/"name"\s*:\s*"([^"]{8,160})"/i)?.[1] ||
        `Produto ${itemId}`;
      out.push({
        itemId,
        title: titleGuess.replace(/\\u([0-9a-f]{4})/gi, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
        price: 0,
        oldPrice: null,
        imageUrl: null,
        productUrl: `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/i, "MLB-")}`,
        commissionPct: 0,
        badge: null,
        category: "geral",
      });
      if (out.length >= 36) break;
    }
  }
  return out;
}

export async function fetchOfficialStoreProducts(
  store: OfficialStore,
): Promise<{ products: HubProduct[]; error?: string }> {
  const url = normalizeStoreListUrl(store.list_url);
  try {
    const base = url.replace(/\/$/, "");
    const pages = [
      base,
      `${base}/_Desde_49_NoIndex_True`,
      `${base}/_Desde_97_NoIndex_True`,
      `${base}/_Desde_145_NoIndex_True`,
    ];
    const seen = new Set<string>();
    const raw: HubProduct[] = [];
    for (const pageUrl of pages) {
      if (raw.length >= store.max_items) break;
      const res = await fetch(pageUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortTimeout(25000),
      });
      const html = await res.text();
      if (/account-verification|suspicious-traffic/i.test(html) || !res.ok) {
        if (!raw.length) {
          const err =
            "ML pediu verificação nesta URL. Use o link www.mercadolivre.com.br/loja/... ou atualize Cookie em Contas e tente de novo.";
          markStoreSync(store.id, err);
          return { products: [], error: err };
        }
        break;
      }
      for (const p of extractStoreProductsFromHtml(html)) {
        const id = normalizeItemId(p.itemId) || p.itemId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        raw.push(p);
        if (raw.length >= store.max_items) break;
      }
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 500)));
    }
    const products = raw.slice(0, store.max_items).map((p) => {
      const itemId = normalizeItemId(p.itemId) || p.itemId;
      const category = classifyProduct({
        title: p.title,
        productUrl: p.productUrl,
        categoryHint: store.category,
      });
      return {
        ...p,
        itemId,
        category,
        commissionPct: Number(store.commission_hint) || 0,
        badge: `Loja ${store.name} · ${store.commission_hint || 0}%`,
      };
    });
    markStoreSync(store.id, null);
    logAntiBan(
      "official_store_fetch",
      `id=${store.id} name=${store.name} items=${products.length}`,
    );
    return { products };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markStoreSync(store.id, msg);
    return { products: [], error: msg };
  }
}

function markStoreSync(id: number, error: string | null): void {
  getDb()
    .prepare(
      `UPDATE official_stores
       SET last_synced_at = datetime('now'), last_error = ?
       WHERE id = ?`,
    )
    .run(error, id);
}

/** Busca todas as lojas ativas (com pausa leve entre elas). */
export async function fetchAllOfficialStoreProducts(opts?: {
  category?: string;
  onStore?: (store: OfficialStore, count: number, error?: string) => void;
}): Promise<HubProduct[]> {
  const stores = listOfficialStores({ activeOnly: true }).filter((s) =>
    opts?.category ? s.category === opts.category : true,
  );
  const out: HubProduct[] = [];
  const seen = new Set<string>();
  for (const store of stores) {
    const { products, error } = await fetchOfficialStoreProducts(store);
    opts?.onStore?.(store, products.length, error);
    for (const p of products) {
      const id = normalizeItemId(p.itemId) || p.itemId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(p);
    }
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 500));
  }
  return out;
}

/** Consultas profundas TCG: Pokémon, Magic, Yu-Gi-Oh, sleeves, pastas, BR. */
export const TCG_DEEP_QUERIES = [
  "pokemon-booster",
  "pokemon-elite-trainer-box",
  "pokemon-box-treinador-elite",
  "pokemon-pasta-fichario",
  "pokemon-sleeve-protetor",
  "pokemon-portugues-booster",
  "yu-gi-oh-booster",
  "yugioh-deck-estrutura",
  "magic-the-gathering-booster",
  "mtg-booster-box",
  "sleeves-ultra-pro-cartas",
  "dragon-shield-sleeve",
  "pasta-binder-cartas-tcg",
  "fichario-cartas-pokemon",
  "deck-box-cartas",
  "toploader-cartas",
  "lorcana-booster",
  "one-piece-card-game-booster",
] as const;

/**
 * Varre listas de busca do ML para encher o nicho TCG (além das lojas oficiais).
 */
export async function fetchTcgDeepCatalog(opts?: {
  maxQueries?: number;
  maxPerQuery?: number;
}): Promise<HubProduct[]> {
  const { isTcgCollectible } = await import("./tcgFilter.js");
  const maxQueries = Math.max(4, Math.min(opts?.maxQueries ?? 10, TCG_DEEP_QUERIES.length));
  const maxPerQuery = Math.max(4, Math.min(opts?.maxPerQuery ?? 12, 20));
  const queries = [...TCG_DEEP_QUERIES].slice(0, maxQueries);
  const seen = new Set<string>();
  const out: HubProduct[] = [];

  for (const q of queries) {
    const url = `https://lista.mercadolivre.com.br/${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortTimeout(22000),
      });
      const html = await res.text();
      if (!res.ok || /account-verification|suspicious-traffic/i.test(html)) {
        continue;
      }
      let added = 0;
      const fromStore = extractStoreProductsFromHtml(html);
      const fromList = extractListingProductsFromHtml(html);
      for (const p of [...fromStore, ...fromList]) {
        const id = normalizeItemId(p.itemId) || p.itemId;
        if (!id || seen.has(id)) continue;
        if (!isTcgCollectible(p.title, p.productUrl || "")) continue;
        seen.add(id);
        const category = classifyProduct({
          title: p.title,
          productUrl: p.productUrl,
          categoryHint: "tcg",
        });
        out.push({
          ...p,
          itemId: id,
          category: category === "tcg" ? "tcg" : "tcg",
          commissionPct: p.commissionPct || 8,
          badge: `Busca TCG · ${q}`,
        });
        added += 1;
        if (added >= maxPerQuery) break;
      }
    } catch {
      /* próxima query */
    }
    await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
  }

  logAntiBan("tcg_deep_catalog", `queries=${maxQueries} items=${out.length}`);
  return out;
}
