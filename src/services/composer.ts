import type { CategoryId } from "../config.js";
import {
  DEFAULT_POST_TEMPLATE,
  FLASH_POST_TEMPLATE,
  TCG_POST_TEMPLATE,
} from "../affiliateCatalog.js";
import type { Deal, WaGroup } from "../db/index.js";
import { getDb, getSetting, getSettingNum } from "../db/index.js";
import { getPriceHistoryVerdict } from "./priceHistory.js";
import { brazilMinutesSinceMidnight } from "./timeBr.js";
import { cleanAffiliateUrl } from "./shortLinks.js";
import {
  cardLanguage,
  presaleHint,
  tcgProductKind,
} from "./tcgFilter.js";
import { groupFooterLine, resolveDealPrices } from "./dealDisplay.js";

function brl(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    amazon: "Na Amazon!!!",
    mercadolivre: "No Mercado Livre!!!",
    demo: "No Mercado Livre!!!",
    shopee: "Na Shopee!!!",
    magalu: "No Magalu!!!",
    americanas: "Nas Americanas!!!",
    awin: "Confira a oferta!!!",
  };
  return map[source] || "Confira a oferta!!!";
}

function cleanTitle(title: string): string {
  const t = title
    .replace(/\{[^}]+\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= 90) return t;
  const cut = t.slice(0, 87);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 50 ? cut.slice(0, sp) : cut).trim()}…`;
}

function isPeakHour(now = new Date()): boolean {
  const m = brazilMinutesSinceMidnight(now);
  return (m >= 11 * 60 + 30 && m < 13 * 60) || (m >= 18 * 60 && m < 21 * 60);
}

function savingsPct(deal: Deal, finalPrice: number): number | null {
  const base =
    deal.old_price && deal.old_price > finalPrice
      ? deal.old_price
      : deal.price > finalPrice
        ? deal.price
        : null;
  if (!base || base <= finalPrice) return null;
  return Math.round((1 - finalPrice / base) * 100);
}

/** Headline automática estilo canais BR / Careca VIP. */
export function buildPromoHeadline(deal: Deal, finalPrice: number): string {
  return pickPromoHeadline(deal, finalPrice).text;
}

export function pickPromoHeadline(
  deal: Deal,
  finalPrice: number,
): { text: string; variant: "A" | "B" } {
  const t = `${deal.title} ${deal.category || ""}`.toLowerCase();
  const pct = savingsPct(deal, finalPrice);
  const hard = pct != null && pct >= 35;
  const mid = pct != null && pct >= 20;

  // Headlines estilo canais BR (Clube/Will/Rei): humor + produto, sem genérico vazio.
  const byProduct: Array<{ test: RegExp; lines: string[] }> = [
    {
      test: /pok[eé]mon|tcg|yu-?gi|magic|carta|booster|deck|copag|makuhita|charizard|blister|quadruplo|triplo/,
      lines: [
        "SUA COLEÇÃO TÁ PEDINDO ISSO 🃏",
        "BOOSTER COM PREÇO DE AMIGO",
        "TCG BOM SEM VENDER O RIM",
        "OLHA O QUE CAIU PRO TREINADOR",
        "QUAD/TRIPLO QUE VALE O HYPE",
      ],
    },
    {
      test: /brinquedo|boneco|lego|funko|hot wheels|quebra[- ]?cabeça/,
      lines: [
        "BRINQUEDO COM PREÇO DE CRIANÇA FELIZ 🧸",
        "ACHADINHO PRA ALEGRAR A GALERA",
        "OFERTA QUE VALE CONFERIR — SÉRIO",
      ],
    },
    {
      test: /toner|cartucho|tinta(?:\s|$)|impressora|multifuncional|epson|hp\b|brother|canon/,
      lines: [
        "TONER / TINTA NO PREÇO CERTO 🖨️",
        "IMPRESSORA NÃO PARA POR FALTA DE TINTA",
        "ACHADINHO PRA NÃO FICAR SEM IMPRIMIR",
      ],
    },
    {
      test: /len[cç]ol|jogo de cama|edredom|travesseiro|colcha|cobertor|toalha|cama|quarto/,
      lines: [
        "CAMA ARRUMADEIRA COM PREÇO BAIXO 🛏️",
        "LENÇOL TOP SEM GASTAR ABSURDO",
        "ACHADINHO PRA DEIXAR A CAMA LINDA",
      ],
    },
    {
      test: /oculos|óculos|ray[- ]?ban|oakley|solar/,
      lines: [
        "RAY-BAN DO CLT",
        "ÓCULOS COM PREÇO DE QUEM ACORDA CEDO",
        "VISÃO CLARA SEM QUEBRAR O BOLSO",
      ],
    },
    {
      test: /jaqueta|moletom|casaco|corta[- ]?vento|blusa de frio/,
      lines: [
        "ALPHA TAMBÉM SENTE FRIO",
        "FRIO CHEGOU, PREÇO CAIU",
        "CASACO QUE O BOLSO AGRADECE",
      ],
    },
    {
      test: /fone|buds|earbud|headset|airpod/,
      lines: [
        "SEU OUVIDO VAI AGRADECER 🎧",
        "SOM TOP SEM ESVAZIAR A CARTEIRA",
        "FONE BOM COM PREÇO QUE COMPENSA",
      ],
    },
    {
      test: /celular|smartphone|iphone|galaxy|motorola|xiaomi/,
      lines: [
        "CELULAR TOP COM PREÇO QUE COMPENSA",
        "OLHA ESSE PREÇO DE CELULAR 📱",
        "CORRE QUE O PREÇO TÁ ABSURDO",
      ],
    },
    {
      test: /carregador|fonte|cabo|power.?bank/,
      lines: [
        "NUNCA MAIS FICAR SEM BATERIA ⚡",
        "CARREGADOR NO PREÇO CERTO",
        "ACHADINHO PRA SALVAR O DIA",
      ],
    },
    {
      test: /tv\b|smart tv|monitor|projetor|ar[- ]?condicionado|split/,
      lines: [
        "CINEMA EM CASA PELO PREÇO DE PIPOCA 📺",
        "ISSO AQUI TÁ ABSURDO",
        "OLHA O QUE CAIU DE PREÇO",
      ],
    },
    {
      test: /notebook|laptop|ssd|hd |mouse|teclado/,
      lines: [
        "SETUP COMPLETO SEM GASTAR ABSURDO 💻",
        "PREÇO DE NOTEBOOK QUE DÓI NA CONCORRÊNCIA",
        "ACHADINHO TECH DO DIA",
      ],
    },
    {
      test: /creatina|whey|suplemento/,
      lines: [
        "SHAPE SAINDO DO FORNO 💪",
        "PREÇO PRA MANTER A DIETA E O BOLSO",
        "SUPLEMENTO COM PREÇO QUE COMPENSA",
      ],
    },
    {
      test: /controle|console|playstation|xbox|nintendo|\bgame\b/,
      lines: [
        "PRO PLAYER SEM GASTAR UMA FORTUNA 🎮",
        "GAME TIME COM PREÇO BAIXO",
        "OLHA ESSE ACHADINHO GAMER",
      ],
    },
    {
      test: /perfume|eau de|desodorante|colonia|colônia/,
      lines: [
        "CHEIRINHO CARO, PREÇO MANSA ✨",
        "FRAGRÂNCIA TOP SEM GASTAR ABSURDO",
        "ACHADINHO DE PERFUME",
      ],
    },
    {
      test: /cueca|boxer|espartano/,
      lines: [
        "RECOMENDADA PELO LEÔNIDAS",
        "KIT QUE O BOLSO AGRADECE",
        "CONFORTO SEM GASTAR ABSURDO",
      ],
    },
    {
      test: /t[eê]nis|nike|adidas|puma|vans|dunk/,
      lines: [
        "JÁ VIU TÊNIS FEIO NESSE PREÇO??",
        "PÉ NO CHÃO, PREÇO NO CHÃO",
        "TÊNIS TOP SEM ESVAZIAR A CONTA",
        "CORRE QUE ESSE SUMIU RÁPIDO",
      ],
    },
    {
      test: /moletom|casaco|agasalho|jaqueta/,
      lines: [
        "ALPHA TAMBÉM SENTE FRIO",
        "FRIO CHEGANDO, PREÇO CAINDO",
        "CASACO BOM SEM GASTAR ABSURDO",
      ],
    },
    {
      test: /[oó]culos|ray-?ban|aviador/,
      lines: [
        "RAY-BAN DO CLT",
        "SOL FORTE, PREÇO MANSO",
        "VISÃO TOP SEM GASTAR ABSURDO",
      ],
    },
    {
      test: /meia|lupo|soquete/,
      lines: [
        "CANO CURTO PRA NÃO APARECER",
        "MEIA BOA EM KIT QUE COMPENSA",
        "ACHADINHO DE MEIA QUE SOME",
      ],
    },
    {
      test: /creme|beleza|camiseta|moda|roupa|legging/,
      lines: [
        "ACHADINHO DE MODA QUE COMPENSA",
        "OLHA ESSE PREÇO DE MODA",
        "PEÇA TOP SEM ESVAZIAR A CARTEIRA",
        "LOOK PRONTO, BOLSO TRANQUILO",
      ],
    },
    {
      test: /rel[oó]gio|smartwatch|fit3|watch|aurafit|trek/,
      lines: [
        "PULSEIRA INTELIGENTE NO PREÇO CERTO ⌚",
        "OLHA ESSE RELÓGIO CAINDO DE PREÇO",
        "ACHADINHO PRO PULSO",
      ],
    },
    {
      test: /panela|fog[aã]o|liquidificador|air.?fryer|cozinha|utens[ií]lio|tramontina|toalha|len[cç]ol/,
      lines: [
        "CASA ORGANIZADA SEM GASTAR ABSURDO 🏠",
        "ACHADINHO PRA COZINHA",
        "PREÇO BAIXO PRA DEIXAR A CASA TOP",
        "CASA FELIZ, BOLSO TAMBÉM",
      ],
    },
  ];

  for (const row of byProduct) {
    if (row.test.test(t)) {
      const arm: "A" | "B" = deal.id % 2 === 0 ? "A" : "B";
      const idx = deal.id % row.lines.length;
      return { text: row.lines[idx], variant: arm };
    }
  }

  const genericHard = [
    "TÁ BARATO DEMAIS ISSO AQUI",
    "CAIU O PREÇO FORTE DEMAIS",
    "ISSO AQUI TÁ ABSURDO",
    "PREÇO QUE NÃO FAZ SENTIDO",
    "DESCONTO PESADO, CORRE",
    "SE ISSO NÃO FOR PROMO EU SOU PADRE",
  ];
  const genericMid = [
    "ACHADINHO DO DIA 🔥",
    "OLHA O QUE EU ACHEI",
    "CORRE ANTES QUE ACABE",
    "PROMO QUE VALE O CLIQUE",
    "PEGUEI ESSA AQUI PRO GRUPO",
    "PASSANDO O OURO ANTES DA GALERA",
  ];
  const genericSoft = [
    "OFERTA QUE VALE CONFERIR",
    "MAIS UMA PRO CARECA VIP",
    "PASSANDO O ACHADINHO",
    "DÁ UMA OLHADA NESSA AQUI",
    "ACHADINHO SEM DRAMA",
  ];

  const pool = hard ? genericHard : mid ? genericMid : genericSoft;
  const arm: "A" | "B" = deal.id % 2 === 0 ? "A" : "B";
  const idx = deal.id % pool.length;
  return { text: pool[idx], variant: arm };
}

export function briefDescription(deal: Deal, maxLines = 4): string[] {
  const raw = (deal.description || "").trim();
  if (!raw) return [cleanTitle(deal.title)].slice(0, maxLines);
  return raw
    .split(/[\n.!]+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        !/^ganhos extras/i.test(s) &&
        !/^categoria:/i.test(s) &&
        !/^cupom ml:/i.test(s) &&
        !/^desconto ml/i.test(s) &&
        !/^catálogo/i.test(s),
    )
    .slice(0, maxLines);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out
    .split("\n")
    .filter((line) => !line.includes("{{") && line.trim() !== "🏷️ Utilize o Cupom: ``" && line.trim() !== "🎟️ Cupom: ``")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Formato Careca VIP:
 * headline + título + De/Por (valor com desconto) + cupom + rodapé do grupo.
 * Sem parcela inventada e sem desconto PIX inventado.
 */
export function composePromo(
  deal: Deal,
  group?: WaGroup | null,
): { text: string; headlineVariant: "A" | "B" } {
  let title = cleanTitle(deal.title);
  const kind = tcgProductKind(deal.title);
  const lang = cardLanguage(deal.title);
  if (kind || lang) {
    const bits = [kind, lang].filter(Boolean).join(" · ");
    if (bits && !title.includes(bits)) title = `${title} (${bits})`;
  }
  const view = resolveDealPrices(deal);
  const finalPrice = view.final;
  const oldPrice = view.de;
  const dealForPct = {
    ...deal,
    price: view.listed,
    old_price: oldPrice,
  } as Deal;
  const history = getPriceHistoryVerdict({
    ...deal,
    price: view.listed,
    old_price: oldPrice,
    price_with_coupon:
      view.final < view.listed ? view.final : deal.price_with_coupon,
  });
  const picked = pickPromoHeadline(dealForPct, finalPrice);
  // Evita repetir a mesma headline 3x seguidas (usa headline_variant / reason)
  const recentHeads = getDb()
    .prepare(
      `SELECT headline_variant, reason FROM post_logs WHERE ok = 1 ORDER BY id DESC LIMIT 6`,
    )
    .all() as Array<{ headline_variant?: string | null; reason?: string }>;
  let headline =
    history.isLowest === true
      ? "👑 MENOR PREÇO DOS ÚLTIMOS 30 DIAS"
      : picked.text;
  const sameHead = recentHeads.filter((r) => {
    const hay = `${r.headline_variant || ""} ${r.reason || ""}`;
    return hay.includes(headline.slice(0, 24));
  }).length;
  if (sameHead >= 2 && history.isLowest !== true) {
    const alt = pickPromoHeadline(
      { ...dealForPct, id: deal.id + 7 } as Deal,
      finalPrice,
    );
    headline = alt.text;
  }
  // Destaca % off alto no headline
  const pctOff = savingsPct(dealForPct, finalPrice);
  if (
    history.isLowest !== true &&
    pctOff != null &&
    pctOff >= 40 &&
    !/%/.test(headline)
  ) {
    headline = `${headline} (−${pctOff}%)`;
  }
  const savingsLine = "";

  const coupon = view.couponCode;
  let couponLine = "";
  if (coupon) {
    couponLine = `🎟️ Cupom: \`${coupon}\``;
  } else if (view.clickCoupon) {
    const p = view.clickCouponPct;
    couponLine = p
      ? `🎟️ Cupom de ${p}% no anúncio — clique no link para ativar`
      : "🎟️ Cupom no anúncio — clique no link para ativar";
  }
  const desc = deal.description || "";
  // Nunca postar “siga a loja” — a maioria dos anúncios não tem esse botão.
  // Só se setting explícito e texto de PDP (não inventado).
  const followLine =
    getSetting("allow_follower_coupons", "0") === "1" &&
    /Desconto ML seguir loja/i.test(desc)
      ? "📌 Siga a loja no anúncio e ative o cupom"
      : "";
  const qtyMatch = desc.match(/leve\s+(\d+)\s+un/i);

  const historyLine =
    history.isLowest === true ? "" : history.line;
  const groupCat = String(group?.categories || deal.category || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const flashOn =
    getSetting("post_flash_peak", "1") === "1" && isPeakHour();
  const template =
    (group?.post_template || "").trim() ||
    (flashOn
      ? FLASH_POST_TEMPLATE
      : groupCat === "tcg"
        ? TCG_POST_TEMPLATE
        : DEFAULT_POST_TEMPLATE);

  const hasCoupon = Boolean(coupon || view.clickCoupon);
  void hasCoupon;
  const packQty = view.packQty > 1 ? view.packQty : 1;
  // Totais do carrinho vêm de quoteCouponCart (desconto no total), nunca final×qty.
  const packBefore = packQty > 1 ? view.packBefore : null;
  const packAfter = packQty > 1 ? view.packAfter : null;

  // De/Por SEMPRE unitários como na PDP do ML (original → com cupom).
  // Nunca substituir por “2× preço promocional” (ex.: 57,95×2=115,90) — isso não aparece no anúncio.
  const deUnit =
    oldPrice && oldPrice > finalPrice + 0.009
      ? oldPrice
      : view.listed > finalPrice + 0.009
        ? view.listed
        : null;
  const deLine = deUnit ? `~De ${brl(deUnit)}~` : "";
  const porLine = `💸 *Por ${brl(finalPrice)}* 👑`;
  const priceBlock = [deLine, porLine].filter(Boolean).join("\n");
  const qtyLine =
    packQty > 1
      ? `📦 Leve ${packQty} unidades para ativar o cupom` +
        (view.packMinAmount != null
          ? ` (mín. ${brl(Number(view.packMinAmount))})`
          : " (valor mínimo)") +
        (packBefore != null &&
        packAfter != null &&
        packAfter + 0.009 < packBefore
          ? `\n🛒 No carrinho (${packQty} un.): ~${brl(packBefore)}~ → *${brl(packAfter)}*`
          : "")
      : qtyMatch
        ? `📦 Leve ${qtyMatch[1]} unidades para ativar o cupom (valor mínimo)`
        : "";
  const urlHay = `${deal.product_url || ""} ${deal.affiliate_url || ""}`.toLowerCase();
  const official =
    Number((deal as Deal & { official_store?: number }).official_store) === 1 ||
    /\/loja\/(pokemon|copag|asmodee|nintendo)\b/.test(urlHay) ||
    /loja oficial/.test(`${deal.title} ${deal.description}`.toLowerCase());
  const storeLine = official
    ? "🏬 Loja oficial · verifique se está selecionada no checkout"
    : sourceLabel(deal.source);
  const shippingLine =
    Number((deal as Deal & { free_shipping?: number }).free_shipping) === 1
      ? "🚚 Frete grátis"
      : "";
  const stock = Number((deal as Deal & { stock?: number | null }).stock);
  const stockWarn = getSettingNum("stock_warn_max", 8, 1, 80);
  const stockLine =
    Number.isFinite(stock) && stock > 0 && stock <= stockWarn
      ? `⚠️ Restam ${stock} no anúncio`
      : "";
  const preLine = presaleHint(deal.title, deal.description);
  // Uma linha por bloco + linha em branco entre metadados (WhatsApp legível)
  const extraCoupon = [couponLine, qtyLine, followLine, stockLine, preLine]
    .filter(Boolean)
    .join("\n\n");
  const ctaLine =
    groupCat === "tcg"
      ? "Comunidade TCG · ative as notificações"
      : "";
  const hashtagLine =
    getSetting("post_hashtag", "0") === "1" ? "#anuncio" : "";
  const promoUrl = String(group?.promo_url || "").trim();
  const footerLine = groupFooterLine({
    groupName: group?.name,
    promoUrl,
    inviteUrl: group?.invite_link,
  });

  const text = renderTemplate(template, {
    headline,
    title,
    description: "",
    old_price: oldPrice ? brl(oldPrice) : "",
    de_line: "",
    price: brl(finalPrice),
    por_line: priceBlock,
    savings_line: savingsLine,
    highlights: "",
    coupon,
    coupon_line: extraCoupon,
    history_line: historyLine,
    shipping_line: shippingLine,
    link: cleanAffiliateUrl(deal.affiliate_url || deal.product_url),
    store_line: storeLine,
    cta_line: ctaLine,
    hashtag_line: hashtagLine,
    footer_line: footerLine,
    urgency_line: "",
    category: "",
  });

  let out = text;
  if (
    historyLine &&
    !template.includes("{{history_line}}") &&
    !out.includes(historyLine)
  ) {
    const couponBlock = [couponLine, followLine, qtyLine]
      .filter(Boolean)
      .join("\n");
    if (couponBlock && out.includes(couponBlock)) {
      out = out.replace(couponBlock, `${couponBlock}\n${historyLine}`);
    } else {
      out = out.replace(/(\n)(https?:|🛒)/, `\n${historyLine}$1$2`);
    }
  }
  if (
    footerLine &&
    !template.includes("{{footer_line}}") &&
    !out.includes(footerLine)
  ) {
    out = `${out}\n\n${footerLine}`;
  }

  return {
    text: out
      .split("\n")
      .filter((l, i, arr) => {
        const t = l.trim();
        // evita linha em branco no topo quando history_line vazio
        if (!t && i === 0) return false;
        if (!t) return true;
        if (/^~De\s*~$/.test(t) || t === "~De ~" || t === "~De~" || t === "*~~*")
          return false;
        if (/^~De\s+R\$\s*~$/.test(t) || t === "~De R$ ~") return false;
        if (t.includes("Utilize o Cupom: ``") || t.includes("🎟️ Cupom: ``")) return false;
        if (/categoria:/i.test(t)) return false;
        if (/desconto no link/i.test(t)) return false;
        if (/valida o cupom/i.test(t)) return false;
        if (/economia de cerca/i.test(t)) return false;
        if (/\bem até\s+\d+x\b/i.test(t)) return false;
        // Nunca postar split PIX (template antigo / custom).
        if (/\bsem\s*PIX\b/i.test(t)) return false;
        if (/\bno\s*PIX\b/i.test(t)) return false;
        if (/^💳/.test(t) && /PIX/i.test(t)) return false;
        // Sem “siga a loja” inventado
        if (/siga a loja|seguir a loja|cupom por seguir/i.test(t)) return false;
        return true;
      })
      .map((l) =>
        l
          .replace(/\s*no PIX\s*/gi, " ")
          .replace(/\s*sem PIX\s*/gi, " ")
          .replace(/\s{2,}/g, " ")
          .trimEnd(),
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    headlineVariant: picked.variant,
  };
}

export function composePromoMessage(deal: Deal, group?: WaGroup | null): string {
  return composePromo(deal, group).text;
}

export function parseCategories(raw: string): CategoryId[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as CategoryId[];
}

export function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
