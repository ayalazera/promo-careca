/**
 * Garante imagem do produto para o post (watermark + WhatsApp).
 * Lista ML / catálogo costumam vir sem thumbnail — busca og:image da página.
 */
import { getDb, logAntiBan } from "../db/index.js";
import { getMercadoLivreCreds } from "./credentialVault.js";
import { normalizeItemId } from "./mlHub.js";

function upgradeMlImageUrl(url: string): string {
  return url
    .replace(/-I\.jpg/i, "-O.jpg")
    .replace(/-V\.jpg/i, "-O.jpg")
    .replace(/-S\.jpg/i, "-O.jpg")
    .replace(/-W\.webp/i, "-O.webp");
}

function extractImageFromHtml(html: string): string | null {
  const og =
    html.match(
      /property=["']og:image["']\s+content=["']([^"']+)["']/i,
    )?.[1] ||
    html.match(
      /content=["']([^"']+)["']\s+property=["']og:image["']/i,
    )?.[1];
  if (og?.includes("mlstatic.com") || og?.startsWith("http")) {
    return upgradeMlImageUrl(og);
  }
  const pic = html.match(
    /https:\/\/http2\.mlstatic\.com\/D_[A-Za-z0-9_-]+\.(?:jpg|jpeg|webp|png)/i,
  )?.[0];
  return pic ? upgradeMlImageUrl(pic) : null;
}

async function fetchProductPageImage(productUrl: string): Promise<string | null> {
  if (!productUrl) return null;
  const c = getMercadoLivreCreds();
  try {
    const res = await fetch(productUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ...(c.hubCookie ? { Cookie: c.hubCookie } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(18_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractImageFromHtml(html);
  } catch {
    return null;
  }
}

async function fetchItemApiImage(itemId: string): Promise<string | null> {
  const c = getMercadoLivreCreds();
  if (!c.accessToken || !itemId) return null;
  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      headers: { Authorization: `Bearer ${c.accessToken}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      thumbnail?: string;
      pictures?: Array<{ secure_url?: string; url?: string }>;
    };
    const pic =
      json.pictures?.[0]?.secure_url ||
      json.pictures?.[0]?.url ||
      json.thumbnail ||
      null;
    return pic ? upgradeMlImageUrl(pic) : null;
  } catch {
    return null;
  }
}

function candidateUrls(deal: {
  product_url?: string | null;
  external_id?: string | null;
  affiliate_url?: string | null;
}): string[] {
  const out: string[] = [];
  const push = (u?: string | null) => {
    if (u && u.startsWith("http") && !u.includes("meli.la") && !out.includes(u)) {
      out.push(u);
    }
  };
  push(deal.product_url);
  const id = normalizeItemId(deal.external_id) || normalizeItemId(deal.product_url);
  if (id) {
    push(`https://produto.mercadolivre.com.br/${id.replace(/^MLB/i, "MLB-")}`);
    push(`https://www.mercadolivre.com.br/wid/${id}`);
  }
  return out;
}

/** Busca e persiste image_url se estiver faltando. */
export async function ensureDealImage(dealId: number): Promise<string | null> {
  const deal = getDb()
    .prepare(
      `SELECT id, image_url, product_url, affiliate_url, external_id, source FROM deals WHERE id = ?`,
    )
    .get(dealId) as
    | {
        id: number;
        image_url: string | null;
        product_url: string;
        affiliate_url: string;
        external_id: string;
        source: string;
      }
    | undefined;

  if (!deal) return null;
  if (deal.image_url && deal.image_url.startsWith("http")) {
    return upgradeMlImageUrl(deal.image_url);
  }

  let image: string | null = null;
  const itemId =
    normalizeItemId(deal.external_id) || normalizeItemId(deal.product_url);
  if (itemId) image = await fetchItemApiImage(itemId);

  if (!image) {
    for (const url of candidateUrls(deal)) {
      image = await fetchProductPageImage(url);
      if (image) break;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  if (image) {
    getDb()
      .prepare(`UPDATE deals SET image_url = ? WHERE id = ?`)
      .run(image, dealId);
    logAntiBan("deal_image_ok", `deal=${dealId} ${image.slice(0, 70)}`);
  } else {
    logAntiBan("deal_image_miss", `deal=${dealId} item=${itemId || "?"}`);
  }
  return image;
}

/** Preenche imagens faltantes na fila (antes do Sync/Envio). */
export async function backfillMissingDealImages(limit = 20): Promise<{
  checked: number;
  filled: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT id FROM deals
       WHERE source IN ('mercadolivre','demo')
         AND status IN ('queued','hold_coupon')
         AND (image_url IS NULL OR trim(image_url) = '')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number }>;

  let filled = 0;
  for (const row of rows) {
    const img = await ensureDealImage(row.id);
    if (img) filled += 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { checked: rows.length, filled };
}
