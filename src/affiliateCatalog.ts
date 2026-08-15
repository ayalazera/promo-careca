export const AFFILIATE_SOURCES = [
  {
    id: "mercadolivre",
    label: "Mercado Livre",
    blurb: "Afiliados ML — cupons relâmpago frequentes",
  },
  {
    id: "amazon",
    label: "Amazon",
    blurb: "Associates + PA-API",
  },
  {
    id: "shopee",
    label: "Shopee",
    blurb: "Shopee Affiliates (appId + secret + affiliateId)",
  },
  {
    id: "magalu",
    label: "Magalu",
    blurb: "Magazine Você / Magalu Afiliados",
  },
  {
    id: "americanas",
    label: "Americanas",
    blurb: "Via rede Awin (publisher)",
  },
  {
    id: "awin",
    label: "Awin (geral)",
    blurb: "Rede com várias lojas BR",
  },
] as const;

export type AffiliateSourceId = (typeof AFFILIATE_SOURCES)[number]["id"];

export const GROUP_NAME_SUGGESTIONS = [
  "Rei das promoções",
  "Garimpo de Ofertas",
  "Achadinhos do Dia",
  "Promo Flash BR",
  "Caça Cupom",
  "Ofertas Tech",
  "Mundo Games Promo",
  "TCG & Colecionáveis",
  "Casa em Promoção",
  "Moda com Cupom",
];

/** Formato Careca VIP: menor preço no topo (se houver), headline + blocos. */
export const DEFAULT_POST_TEMPLATE = `{{history_line}}
*{{headline}}*

{{title}}

{{por_line}}

{{coupon_line}}

{{shipping_line}}
{{store_line}}

👉 {{link}}

{{cta_line}}
{{hashtag_line}}
{{footer_line}}`;

/** TCG: curto, preços e cupom em blocos. */
export const TCG_POST_TEMPLATE = `{{history_line}}
*{{headline}}*

{{title}}

{{por_line}}

{{coupon_line}}

👉 {{link}}

{{cta_line}}
{{hashtag_line}}
{{footer_line}}`;

/** Pico (almoço / noite): curto, blocos separados. */
export const FLASH_POST_TEMPLATE = `{{history_line}}
*{{headline}}*

{{title}}

{{por_line}}

{{coupon_line}}

👉 {{link}}

{{footer_line}}`;

export function affiliateDefaultsFromEnv() {
  return {
    shopee: {
      appId: process.env.SHOPEE_APP_ID || "",
      secret: process.env.SHOPEE_SECRET || "",
      affiliateId: process.env.SHOPEE_AFFILIATE_ID || "",
    },
    magalu: {
      token: process.env.MAGALU_AFFILIATE_TOKEN || "",
      partnerId: process.env.MAGALU_PARTNER_ID || "",
    },
    awin: {
      publisherId: process.env.AWIN_PUBLISHER_ID || "",
      apiKey: process.env.AWIN_API_KEY || "",
    },
  };
}

export const panelConfig = {
  couponRevalidateMinutes: Number(process.env.COUPON_REVALIDATE_MINUTES || 8),
};
