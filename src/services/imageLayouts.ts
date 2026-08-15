/**
 * Layouts de arte 1080×1080 — chrome SVG profissional por tema.
 * O produto é composto no miolo; cada layout define cores, header e rodapé.
 */

export type ImageLayoutId =
  | "classic"
  | "neon"
  | "pulse"
  | "hearth"
  | "studio"
  | "auto";

export type LayoutMeta = {
  id: Exclude<ImageLayoutId, "auto">;
  name: string;
  blurb: string;
  categories: string[];
};

export const IMAGE_LAYOUTS: LayoutMeta[] = [
  {
    id: "classic",
    name: "Classic Laranja",
    blurb: "Quadro laranja Careca VIP — sandwich header / produto / QR",
    categories: ["geral", "achadinhos"],
  },
  {
    id: "neon",
    name: "Neon Cyber",
    blurb: "Fundo escuro, grade e borda neon — visual futurista",
    categories: ["tcg", "games"],
  },
  {
    id: "pulse",
    name: "Pulse Tech",
    blurb: "Navy + ciano elétrico — eletrônicos e informática",
    categories: ["eletronicos", "informatica", "celulares"],
  },
  {
    id: "hearth",
    name: "Hearth Casa",
    blurb: "Ink + cobre — casa, cama e decoração",
    categories: ["casa", "moveis"],
  },
  {
    id: "studio",
    name: "Studio Premium",
    blurb: "Minimal escuro com filete âmbar — moda e geral clean",
    categories: ["moda", "esportes"],
  },
];

export function resolveImageLayout(
  requested: string | null | undefined,
  category?: string | null,
): Exclude<ImageLayoutId, "auto"> {
  const raw = String(requested || "auto").trim().toLowerCase();
  if (raw && raw !== "auto" && IMAGE_LAYOUTS.some((l) => l.id === raw)) {
    return raw as Exclude<ImageLayoutId, "auto">;
  }
  const cat = String(category || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  for (const layout of IMAGE_LAYOUTS) {
    if (layout.categories.includes(cat)) return layout.id;
  }
  if (/toner|cartucho|impressora|notebook|ssd|mouse|teclado/.test(cat)) {
    return "pulse";
  }
  return "classic";
}

export type LayoutChromeOpts = {
  W: number;
  H: number;
  HEADER_H: number;
  FOOTER_H: number;
  brand: string;
  niche: string;
  tagLines: string[];
  hasLogo: boolean;
  hasQr: boolean;
  qrX: number;
  qrY: number;
  qrBox: number;
  discountPct?: number | null;
  escapeXml: (s: string) => string;
  fingerprintSvg: (cx: number, cy: number, color: string) => string;
};

function brandBlock(
  opts: LayoutChromeOpts,
  accent: string,
  brandY = 78,
): string {
  const { brand, niche, tagLines, hasLogo, escapeXml } = opts;
  const brandSafe = escapeXml(brand);
  const nicheSafe = escapeXml(niche);
  const x = hasLogo ? 134 : 48;
  return `
    ${
      hasLogo
        ? ""
        : `<circle cx="68" cy="88" r="36" fill="${accent}" fill-opacity="0.2" stroke="${accent}" stroke-width="2"/>
           <text x="68" y="100" text-anchor="middle"
             font-family="Arial Black, Arial, sans-serif" font-size="28" fill="${accent}">${escapeXml(
               brand.slice(0, 1) || "C",
             )}</text>`
    }
    <text x="${x}" y="${nicheSafe ? brandY : brandY + 16}"
      font-family="Arial Black, Impact, sans-serif" font-size="32" letter-spacing="1" fill="#FFFFFF">${brandSafe}</text>
    ${
      nicheSafe
        ? `<text x="${x}" y="${brandY + 32}"
            font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="${accent}">${nicheSafe}</text>`
        : ""
    }
    <text x="1040" y="${tagLines[1] ? 78 : 96}" text-anchor="end"
      font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#E8E8E8">${tagLines[0] || ""}</text>
    ${
      tagLines[1]
        ? `<text x="1040" y="100" text-anchor="end"
            font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#B8B8B8">${tagLines[1]}</text>`
        : ""
    }`;
}

function discountBadge(
  opts: LayoutChromeOpts,
  fill: string,
  text = "#FFFFFF",
): string {
  const pct = opts.discountPct;
  if (pct == null || pct < 8) return "";
  return `
    <g transform="translate(848, 198)">
      <polygon points="28,0 152,0 168,28 152,56 28,56 12,28" fill="${fill}"/>
      <text x="90" y="37" text-anchor="middle"
        font-family="Arial Black, Impact, sans-serif" font-size="26" fill="${text}">-${pct}%</text>
    </g>`;
}

function footerEngage(
  opts: LayoutChromeOpts,
  accent: string,
  muted = "#C8C8C8",
): string {
  const { FOOTER_H, H, hasQr, qrX, qrY, qrBox } = opts;
  const footerY = H - FOOTER_H;
  return `
    <text x="56" y="${footerY + 72}"
      font-family="Arial Black, Arial, sans-serif" font-size="15" fill="#FFFFFF">ATIVE AS NOTIFICAÇÕES</text>
    <text x="56" y="${footerY + 96}"
      font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="${muted}">e não perca nenhuma oferta</text>
    <text x="56" y="${footerY + 128}"
      font-family="Arial Black, Arial, sans-serif" font-size="14" fill="${accent}">CURTA · COMENTE · COMPARTILHE</text>
    <text x="56" y="${footerY + 152}"
      font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="${muted}">ajude mais gente a economizar</text>
    ${
      hasQr
        ? `<rect x="${qrX}" y="${qrY}" width="${qrBox}" height="${qrBox}" rx="14" fill="#FFFFFF"/>
           <text x="${qrX + qrBox / 2}" y="${qrY - 18}" text-anchor="middle"
             font-family="Arial Black, Arial, sans-serif" font-size="13" fill="#FFFFFF">ENTRE PELO QR</text>
           <text x="${qrX + qrBox / 2}" y="${qrY - 2}" text-anchor="middle"
             font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="${accent}">WhatsApp · Telegram</text>`
        : `<rect x="${qrX}" y="${qrY}" width="${qrBox}" height="${qrBox}" rx="14" fill="#1A1A1A" stroke="${accent}" stroke-width="2"/>`
    }`;
}

/** Classic Careca — sandwich laranja (referência Game Barato). */
export function svgClassic(opts: LayoutChromeOpts): string {
  const { W, H, HEADER_H, FOOTER_H, fingerprintSvg, brand, niche, tagLines, hasLogo, hasQr, qrX, qrY, qrBox, escapeXml } = opts;
  const orange = "#FF6A00";
  const orangeDark = "#D45200";
  const FRAME = 16;
  const BAR = 12;
  const footerY = H - FOOTER_H;
  const whiteH = H - HEADER_H - FOOTER_H;
  const inner = FRAME + 3;
  const brandSafe = escapeXml(brand);
  const nicheSafe = escapeXml(niche);
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#1A0A08"/>
        <stop offset="100%" stop-color="#111111"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="#FFFFFF"/>
    <rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="url(#hdr)"/>
    <rect x="0" y="${footerY}" width="${W}" height="${FOOTER_H}" fill="#111111"/>
    ${fingerprintSvg(980, 40, "#7A1A12")}
    ${fingerprintSvg(120, 1040, "#7A1A12")}
    <rect x="0" y="0" width="${W}" height="${BAR}" fill="${orange}"/>
    <rect x="0" y="${H - BAR}" width="${W}" height="${BAR}" fill="${orange}"/>
    <rect x="0" y="0" width="${FRAME}" height="${H}" fill="${orange}"/>
    <rect x="${W - FRAME}" y="0" width="${FRAME}" height="${H}" fill="${orange}"/>
    <rect x="${FRAME}" y="${BAR}" width="${W - FRAME * 2}" height="3" fill="#FFFFFF"/>
    <rect x="${FRAME}" y="${H - BAR - 3}" width="${W - FRAME * 2}" height="3" fill="#FFFFFF"/>
    <rect x="${FRAME}" y="${BAR}" width="3" height="${H - BAR * 2}" fill="#FFFFFF"/>
    <rect x="${W - FRAME - 3}" y="${BAR}" width="3" height="${H - BAR * 2}" fill="#FFFFFF"/>
    <rect x="${FRAME}" y="${HEADER_H - BAR}" width="${W - FRAME * 2}" height="${BAR}" fill="${orange}"/>
    <rect x="${FRAME}" y="${HEADER_H - BAR + 3}" width="${W - FRAME * 2}" height="2" fill="#FFFFFF" fill-opacity="0.85"/>
    <rect x="${FRAME}" y="${footerY}" width="${W - FRAME * 2}" height="${BAR}" fill="${orange}"/>
    <rect x="${FRAME}" y="${footerY + 3}" width="${W - FRAME * 2}" height="2" fill="#FFFFFF" fill-opacity="0.85"/>
    <rect x="${FRAME + 3}" y="${HEADER_H}" width="${W - FRAME * 2 - 6}" height="${whiteH}" fill="#FFFFFF"/>
    <rect x="${FRAME}" y="${HEADER_H}" width="5" height="${whiteH}" fill="${orange}"/>
    <rect x="${W - FRAME - 5}" y="${HEADER_H}" width="5" height="${whiteH}" fill="${orange}"/>
    ${
      hasLogo
        ? ""
        : `<circle cx="${inner + 52}" cy="${BAR + 78}" r="40" fill="#FFFFFF"/>
           <text x="${inner + 52}" y="${BAR + 92}" text-anchor="middle"
             font-family="Arial Black, Arial, sans-serif" font-size="32" fill="${orange}">${escapeXml(
               brand.slice(0, 1) || "C",
             )}</text>`
    }
    <text x="${hasLogo ? inner + 118 : inner + 108}" y="${nicheSafe ? 78 : 98}"
      font-family="Impact, Arial Black, sans-serif" font-size="34" fill="#FFFFFF">${brandSafe}</text>
    ${
      nicheSafe
        ? `<text x="${hasLogo ? inner + 118 : inner + 108}" y="114"
            font-family="Arial Black, Arial, sans-serif" font-size="18" fill="${orange}">${nicheSafe}</text>`
        : ""
    }
    <rect x="548" y="42" width="5" height="92" fill="${orange}"/>
    <text x="572" y="${tagLines[1] ? 82 : 100}"
      font-family="Arial Black, Arial, sans-serif" font-size="18" fill="#FFFFFF">${tagLines[0] || ""}</text>
    ${
      tagLines[1]
        ? `<text x="572" y="110" font-family="Arial Black, Arial, sans-serif" font-size="18" fill="#FFFFFF">${tagLines[1]}</text>`
        : ""
    }
    ${discountBadge(opts, orange)}
    <rect x="368" y="${footerY + 28}" width="3" height="${FOOTER_H - 48}" fill="${orange}"/>
    <rect x="700" y="${footerY + 28}" width="3" height="${FOOTER_H - 48}" fill="${orange}"/>
    <g transform="translate(48, ${footerY + 48})" fill="${orange}">
      <path d="M34 10c-10 0-18 8-18 18v14l-8 12h52l-8-12V28c0-10-8-18-18-18z"/>
      <rect x="26" y="54" width="16" height="8" rx="4"/>
      <circle cx="48" cy="14" r="6" fill="${orangeDark}"/>
    </g>
    <text x="48" y="${footerY + 140}" font-family="Arial Black, Arial, sans-serif" font-size="16" fill="#FFFFFF">ATIVE AS NOTIFICAÇÕES</text>
    <text x="48" y="${footerY + 166}" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#F3F3F3">E NÃO PERCA NENHUMA</text>
    <text x="48" y="${footerY + 190}" font-family="Arial Black, Arial, sans-serif" font-size="16" fill="${orange}">OFERTA!</text>
    <g transform="translate(400, ${footerY + 48})" fill="${orange}">
      <path d="M28 54 L6 32 C1 27 1 16 9 11 C16 7 22 10 26 16 C30 10 36 7 43 11 C51 16 51 27 46 32 Z"/>
    </g>
    <g transform="translate(470, ${footerY + 52})" fill="none" stroke="${orange}" stroke-width="4" stroke-linecap="round">
      <circle cx="22" cy="8" r="6" fill="${orange}"/>
      <circle cx="8" cy="32" r="6" fill="${orange}"/>
      <circle cx="36" cy="32" r="6" fill="${orange}"/>
      <path d="M16 12 L12 26"/><path d="M28 12 L32 26"/>
    </g>
    <text x="400" y="${footerY + 140}" font-family="Arial Black, Arial, sans-serif" font-size="16" fill="#FFFFFF">CURTA  ·  COMENTE</text>
    <text x="400" y="${footerY + 166}" font-family="Arial Black, Arial, sans-serif" font-size="16" fill="${orange}">COMPARTILHE</text>
    <text x="400" y="${footerY + 190}" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#F3F3F3">E AJUDE MAIS GENTE</text>
    <text x="400" y="${footerY + 212}" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#F3F3F3">A ECONOMIZAR</text>
    ${
      hasQr
        ? `<rect x="${qrX}" y="${qrY}" width="${qrBox}" height="${qrBox}" rx="8" fill="#FFFFFF"/>`
        : `<rect x="${qrX}" y="${qrY}" width="${qrBox}" height="${qrBox}" rx="8" fill="#1A1A1A" stroke="${orange}" stroke-width="3"/>`
    }
    <text x="888" y="${footerY + 46}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="15" fill="#FFFFFF">SIGA PELO QR</text>
    <text x="888" y="${footerY + 66}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="${orange}">WHATSAPP E TELEGRAM</text>
  </svg>`;
}

/** Neon cyber — grade + borda ciano/magenta (referência Caçadores). */
export function svgNeon(opts: LayoutChromeOpts): string {
  const { W, H, HEADER_H, FOOTER_H, hasQr, qrX, qrY, qrBox } = opts;
  const cyan = "#00E5FF";
  const mag = "#FF2BD6";
  const footerY = H - FOOTER_H;
  const wellY = HEADER_H + 28;
  const wellH = footerY - wellY - 28;
  const grid = Array.from({ length: 18 }, (_, i) => {
    const x = 40 + i * 58;
    return `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${cyan}" stroke-opacity="0.06" stroke-width="1"/>`;
  }).join("");
  const gridH = Array.from({ length: 18 }, (_, i) => {
    const y = 40 + i * 58;
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${mag}" stroke-opacity="0.05" stroke-width="1"/>`;
  }).join("");
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgN" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#070B18"/>
        <stop offset="55%" stop-color="#0C1024"/>
        <stop offset="100%" stop-color="#14081C"/>
      </linearGradient>
      <linearGradient id="bordN" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${cyan}"/>
        <stop offset="50%" stop-color="#7B5CFF"/>
        <stop offset="100%" stop-color="${mag}"/>
      </linearGradient>
      <filter id="glowN" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="6" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgN)"/>
    ${grid}${gridH}
    <rect x="22" y="22" width="${W - 44}" height="${H - 44}" rx="28" fill="none" stroke="url(#bordN)" stroke-width="3" filter="url(#glowN)"/>
    <rect x="34" y="34" width="${W - 68}" height="${H - 68}" rx="22" fill="none" stroke="${cyan}" stroke-opacity="0.35" stroke-width="1.5"/>
    <!-- % corners -->
    <rect x="56" y="56" width="44" height="44" rx="10" fill="#0A1228" stroke="${cyan}" stroke-width="2"/>
    <text x="78" y="86" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="20" fill="${cyan}">%</text>
    <rect x="980" y="56" width="44" height="44" rx="10" fill="#18081C" stroke="${mag}" stroke-width="2"/>
    <text x="1002" y="86" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="20" fill="${mag}">%</text>
    ${brandBlock(opts, cyan, 118)}
    <rect x="72" y="${wellY}" width="${W - 144}" height="${wellH}" rx="20" fill="#F7F8FC"/>
    <rect x="72" y="${wellY}" width="${W - 144}" height="${wellH}" rx="20" fill="none" stroke="${mag}" stroke-opacity="0.55" stroke-width="2"/>
    <!-- ícones laterais estilo canal -->
    <g transform="translate(96, ${wellY + wellH / 2 - 20})" fill="none" stroke="${cyan}" stroke-width="3" opacity="0.85">
      <circle cx="18" cy="18" r="18"/>
      <path d="M8 14 h20 l-2 14 H10 z"/><circle cx="14" cy="36" r="2.5" fill="${cyan}"/><circle cx="26" cy="36" r="2.5" fill="${cyan}"/>
    </g>
    <g transform="translate(948, ${wellY + wellH / 2 - 20})" fill="none" stroke="${mag}" stroke-width="3" opacity="0.85">
      <path d="M10 34 V14 h8 c0-8 12-8 12 0 h8 v20 z"/>
    </g>
    ${discountBadge({ ...opts }, mag)}
    <!-- pills de CTA -->
    <rect x="72" y="${footerY + 36}" width="420" height="44" rx="22" fill="#101828" stroke="${cyan}" stroke-width="1.5"/>
    <text x="282" y="${footerY + 64}" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="13" fill="#FFFFFF">ATIVE AS NOTIFICAÇÕES · NÃO PERCA OFERTA</text>
    <rect x="72" y="${footerY + 92}" width="420" height="44" rx="22" fill="#101828" stroke="${mag}" stroke-width="1.5"/>
    <text x="282" y="${footerY + 120}" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="13" fill="#FFFFFF">CURTA · COMENTE · COMPARTILHE</text>
    ${
      opts.hasQr
        ? `<rect x="${opts.qrX}" y="${opts.qrY}" width="${opts.qrBox}" height="${opts.qrBox}" rx="14" fill="#FFFFFF"/>
           <text x="${opts.qrX + opts.qrBox / 2}" y="${opts.qrY - 18}" text-anchor="middle"
             font-family="Arial Black, Arial, sans-serif" font-size="13" fill="#FFFFFF">ENTRE PELO QR</text>
           <text x="${opts.qrX + opts.qrBox / 2}" y="${opts.qrY - 2}" text-anchor="middle"
             font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="${cyan}">WhatsApp · Telegram</text>`
        : `<rect x="${opts.qrX}" y="${opts.qrY}" width="${opts.qrBox}" height="${opts.qrBox}" rx="14" fill="#1A1A1A" stroke="${cyan}" stroke-width="2"/>`
    }
  </svg>`;
}

/** Pulse tech — navy + ciano. */
export function svgPulse(opts: LayoutChromeOpts): string {
  const { W, H, HEADER_H, FOOTER_H } = opts;
  const blue = "#1AE0FF";
  const deep = "#06101F";
  const footerY = H - FOOTER_H;
  const wellY = HEADER_H + 18;
  const wellH = footerY - wellY - 18;
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgP" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#081628"/>
        <stop offset="100%" stop-color="${deep}"/>
      </linearGradient>
      <linearGradient id="edgeP" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${blue}"/>
        <stop offset="100%" stop-color="#2B6BFF"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgP)"/>
    <rect x="0" y="0" width="10" height="${H}" fill="url(#edgeP)"/>
    <rect x="${W - 10}" y="0" width="10" height="${H}" fill="url(#edgeP)"/>
    <rect x="0" y="0" width="${W}" height="6" fill="${blue}"/>
    <rect x="0" y="${H - 6}" width="${W}" height="6" fill="${blue}"/>
    <path d="M40 168 H1040" stroke="${blue}" stroke-opacity="0.35" stroke-width="1"/>
    <path d="M40 ${footerY} H1040" stroke="${blue}" stroke-opacity="0.35" stroke-width="1"/>
    ${brandBlock(opts, blue)}
    <rect x="56" y="${wellY}" width="${W - 112}" height="${wellH}" rx="8" fill="#FFFFFF"/>
    <rect x="56" y="${wellY}" width="${W - 112}" height="4" fill="${blue}"/>
    ${discountBadge(opts, "#0B2A44", blue)}
    ${footerEngage(opts, blue, "#8EC8E8")}
  </svg>`;
}

/** Hearth — casa / cama: ink + cobre. */
export function svgHearth(opts: LayoutChromeOpts): string {
  const { W, H, HEADER_H, FOOTER_H } = opts;
  const copper = "#D4A26A";
  const ink = "#14181F";
  const footerY = H - FOOTER_H;
  const wellY = HEADER_H + 20;
  const wellH = footerY - wellY - 20;
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgH" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#171C24"/>
        <stop offset="100%" stop-color="${ink}"/>
      </linearGradient>
      <pattern id="dotsH" width="24" height="24" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.2" fill="${copper}" fill-opacity="0.18"/>
      </pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgH)"/>
    <rect width="${W}" height="${H}" fill="url(#dotsH)"/>
    <rect x="28" y="28" width="${W - 56}" height="${H - 56}" rx="4" fill="none" stroke="${copper}" stroke-opacity="0.55" stroke-width="1.5"/>
    <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="2" fill="none" stroke="${copper}" stroke-opacity="0.22" stroke-width="1"/>
    ${brandBlock(opts, copper)}
    <rect x="72" y="${wellY}" width="${W - 144}" height="${wellH}" rx="6" fill="#FAF7F2"/>
    ${discountBadge(opts, copper, "#1A140C")}
    ${footerEngage(opts, copper, "#D8C8B0")}
  </svg>`;
}

/** Studio premium — minimal escuro + âmbar. */
export function svgStudio(opts: LayoutChromeOpts): string {
  const { W, H, HEADER_H, FOOTER_H } = opts;
  const amber = "#E8B84A";
  const footerY = H - FOOTER_H;
  const wellY = HEADER_H + 24;
  const wellH = footerY - wellY - 24;
  return `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgS" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#121212"/>
        <stop offset="100%" stop-color="#0A0A0A"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgS)"/>
    <rect x="48" y="48" width="${W - 96}" height="${H - 96}" fill="none" stroke="#2A2A2A" stroke-width="1"/>
    <rect x="48" y="48" width="120" height="3" fill="${amber}"/>
    <rect x="${W - 168}" y="${H - 51}" width="120" height="3" fill="${amber}"/>
    ${brandBlock(opts, amber)}
    <rect x="88" y="${wellY}" width="${W - 176}" height="${wellH}" fill="#FFFFFF"/>
    ${discountBadge(opts, amber, "#111111")}
    ${footerEngage(opts, amber, "#A8A8A8")}
  </svg>`;
}

export function buildLayoutSvg(
  layout: Exclude<ImageLayoutId, "auto">,
  opts: LayoutChromeOpts,
): string {
  switch (layout) {
    case "neon":
      return svgNeon(opts);
    case "pulse":
      return svgPulse(opts);
    case "hearth":
      return svgHearth(opts);
    case "studio":
      return svgStudio(opts);
    case "classic":
    default:
      return svgClassic(opts);
  }
}

/** Área útil do produto por layout (miolo). */
export function productWell(
  layout: Exclude<ImageLayoutId, "auto">,
  W: number,
  H: number,
  HEADER_H: number,
  FOOTER_H: number,
): { left: number; top: number; w: number; h: number } {
  const footerY = H - FOOTER_H;
  switch (layout) {
    case "neon":
      return { left: 92, top: HEADER_H + 48, w: W - 184, h: footerY - HEADER_H - 96 };
    case "pulse":
      return { left: 72, top: HEADER_H + 34, w: W - 144, h: footerY - HEADER_H - 68 };
    case "hearth":
      return { left: 88, top: HEADER_H + 36, w: W - 176, h: footerY - HEADER_H - 72 };
    case "studio":
      return { left: 104, top: HEADER_H + 40, w: W - 208, h: footerY - HEADER_H - 80 };
    case "classic":
    default:
      return { left: 24, top: HEADER_H, w: W - 48, h: footerY - HEADER_H };
  }
}
