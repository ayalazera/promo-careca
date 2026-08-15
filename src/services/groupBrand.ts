/**
 * Marca (handle + tagline) distinta por grupo/categoria.
 * Se o destino não tiver valores próprios, usa um padrão do nicho —
 * nunca o mesmo texto em TCG, Eletrônicos e Achadinhos.
 */
import { getDb, type WaGroup } from "../db/index.js";

export function defaultGroupBrand(
  category: string,
  groupName = "",
): { handle: string; tagline: string } {
  const cat = String(category || "geral")
    .split(",")[0]
    .trim()
    .toLowerCase();
  switch (cat) {
    case "tcg":
      return {
        handle: "@carecavip.tcg",
        tagline: "Pokémon, Yu-Gi-Oh, sleeves e colecionáveis",
      };
    case "eletronicos":
      return {
        handle: "@carecavip.tech",
        tagline: "Eletrônicos com o menor preço",
      };
    case "celulares":
      return {
        handle: "@carecavip.cel",
        tagline: "Celulares e acessórios em oferta",
      };
    case "informatica":
      return {
        handle: "@carecavip.pc",
        tagline: "Informática pra comprar agora",
      };
    case "games":
      return {
        handle: "@carecavip.games",
        tagline: "Consoles, jogos, headset e acessórios",
      };
    case "casa":
      return {
        handle: "@carecavip.casa",
        tagline: "Casa e decoração com desconto",
      };
    case "esportes":
      return {
        handle: "@carecavip.fit",
        tagline: "Esportes e fitness em oferta",
      };
    case "geral":
      return {
        handle: "@carecavip",
        tagline: "Achadinhos do dia pra comprar agora",
      };
    default:
      return {
        handle: `@carecavip.${cat || "promo"}`,
        tagline: groupName
          ? `${groupName} — ofertas pra comprar`
          : "Ofertas selecionadas pra comprar agora",
      };
  }
}

export function resolveGroupBrand(group: {
  name?: string;
  categories?: string;
  watermark_handle?: string | null;
  watermark_tagline?: string | null;
}): { handle: string; tagline: string } {
  const d = defaultGroupBrand(group.categories || "geral", group.name || "");
  return {
    handle: String(group.watermark_handle || "").trim() || d.handle,
    tagline: String(group.watermark_tagline || "").trim() || d.tagline,
  };
}

/** Preenche handle/tagline vazios com o padrão do nicho (cada grupo diferente). */
export function backfillGroupBrands(): number {
  const rows = getDb()
    .prepare(`SELECT * FROM wa_groups`)
    .all() as WaGroup[];
  const upd = getDb().prepare(
    `UPDATE wa_groups SET watermark_handle = ?, watermark_tagline = ? WHERE id = ?`,
  );
  let n = 0;
  for (const g of rows) {
    const brand = resolveGroupBrand(g);
    if (
      brand.handle !== String(g.watermark_handle || "") ||
      brand.tagline !== String(g.watermark_tagline || "")
    ) {
      upd.run(brand.handle, brand.tagline, g.id);
      n += 1;
    }
  }
  return n;
}
