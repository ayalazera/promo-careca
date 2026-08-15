import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { getSetting, setSetting, getDb } from "../db/index.js";
import { config } from "../config.js";
import {
  buildLayoutSvg,
  productWell,
  resolveImageLayout,
  type ImageLayoutId,
  IMAGE_LAYOUTS,
} from "./imageLayouts.js";

export { IMAGE_LAYOUTS, resolveImageLayout };
export type { ImageLayoutId };

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function normalizeInviteUrl(raw: string | null | undefined): string {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^chat\.whatsapp\.com\//i.test(u)) return `https://${u}`;
  if (/^[A-Za-z0-9_-]{10,}$/.test(u)) return `https://chat.whatsapp.com/${u}`;
  return u;
}

export async function generateInviteQrPng(
  inviteUrl: string,
  size = 280,
): Promise<Buffer | null> {
  const url = normalizeInviteUrl(inviteUrl);
  if (!url) return null;
  try {
    return await QRCode.toBuffer(url, {
      type: "png",
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    });
  } catch {
    return null;
  }
}

export function brandLogoPath(): string {
  return (
    getSetting("brand_logo_path", "") ||
    path.join(path.dirname(config.databasePath), "brand", "logo.png")
  );
}

export function brandLogoExists(): boolean {
  try {
    return fs.existsSync(brandLogoPath());
  } catch {
    return false;
  }
}

function splitBrandName(name: string): { brand: string; niche: string } {
  const parts = String(name || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return {
      brand: parts[0].toUpperCase().slice(0, 22),
      niche: parts.slice(1).join(" ").toUpperCase().slice(0, 22),
    };
  }
  return { brand: String(name || "CARECA VIP").toUpperCase().slice(0, 22), niche: "" };
}

function wrapUpper(text: string, width: number, lines = 2): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = w;
    if (out.length >= lines) {
      cur = "";
      break;
    }
  }
  if (cur && out.length < lines) out.push(cur);
  return out;
}

function fingerprintSvg(cx: number, cy: number, color: string): string {
  return [36, 62, 90, 120, 152, 186]
    .map(
      (r, i) =>
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${3 + (i % 2)}" opacity="${0.22 - i * 0.02}"/>`,
    )
    .join("");
}

/**
 * Arte 1080×1080 com layout escolhível (classic / neon / pulse / hearth / studio / auto).
 */
export async function watermarkProductImage(opts: {
  imageUrl?: string;
  imageBuffer?: Buffer | null;
  handle?: string;
  tagline?: string;
  logoPath?: string | null;
  inviteUrl?: string | null;
  groupName?: string;
  category?: string;
  layout?: string | null;
  discountPct?: number | null;
  outDir?: string;
  /** Área do miolo (produto; banner de cupom usa o quadro maior). */
  centerSize?: { w: number; h: number };
}): Promise<Buffer> {
  const W = 1080;
  const H = 1080;
  const HEADER_H = 176;
  const FOOTER_H = 292;
  const layout = resolveImageLayout(opts.layout, opts.category);
  const handle =
    opts.handle || getSetting("brand_handle", "@carecavip");
  void handle;
  const tagline =
    opts.tagline ||
    getSetting("brand_tagline", "AS MELHORES OFERTAS EM UM SÓ LUGAR!");
  const groupName = String(
    opts.groupName ||
      getSetting("brand_group_name", "") ||
      handle.replace(/^@/, "") ||
      "Careca VIP",
  );
  const { brand, niche } = splitBrandName(groupName);

  let input: Buffer;
  if (opts.imageBuffer && opts.imageBuffer.length > 80) {
    input = opts.imageBuffer;
  } else if (opts.imageUrl) {
    const res = await fetch(opts.imageUrl);
    if (!res.ok) throw new Error(`Falha ao baixar imagem: ${res.status}`);
    input = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error("sem imagem para a arte");
  }

  const well = productWell(layout, W, H, HEADER_H, FOOTER_H);
  const productArea = opts.centerSize || {
    w: Math.min(560, well.w - 40),
    h: Math.min(500, well.h - 40),
  };
  const productBuf = await sharp(input)
    .rotate()
    .resize({
      width: productArea.w,
      height: productArea.h,
      fit: "inside",
      withoutEnlargement: false,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png()
    .toBuffer();
  const pmeta = await sharp(productBuf).metadata();
  const pw = pmeta.width || productArea.w;
  const ph = pmeta.height || productArea.h;
  const productLeft = well.left + Math.floor((well.w - pw) / 2);
  const productTop = well.top + Math.floor((well.h - ph) / 2);

  const qrSize = 132;
  const qrBuf = await generateInviteQrPng(opts.inviteUrl || "", qrSize * 2);
  let qrSmall: Buffer | null = null;
  if (qrBuf) {
    qrSmall = await sharp(qrBuf)
      .resize(qrSize, qrSize, { fit: "cover" })
      .png()
      .toBuffer();
  }

  let logoHeader: Buffer | null = null;
  let logoFoot: Buffer | null = null;
  const logoFile =
    (opts.logoPath && fs.existsSync(opts.logoPath) && opts.logoPath) ||
    (brandLogoExists() ? brandLogoPath() : "");
  const headerLogoSize = 88;
  const footLogoSize = 68;
  if (logoFile) {
    try {
      logoHeader = await sharp(logoFile)
        .resize(headerLogoSize, headerLogoSize, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      logoFoot = await sharp(logoFile)
        .resize(footLogoSize, footLogoSize, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
    } catch {
      logoHeader = null;
      logoFoot = null;
    }
  }

  const tagLines = wrapUpper(tagline, 22, 2).map(escapeXml);
  const hasQr = Boolean(qrSmall);
  const footerY = H - FOOTER_H;
  const qrBox = 140;
  const qrX = 720;
  const qrY = footerY + 86;

  const svg = buildLayoutSvg(layout, {
    W,
    H,
    HEADER_H,
    FOOTER_H,
    brand,
    niche,
    tagLines,
    hasLogo: Boolean(logoHeader),
    hasQr,
    qrX,
    qrY,
    qrBox,
    discountPct: opts.discountPct ?? null,
    escapeXml,
    fingerprintSvg,
  });

  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: Buffer.from(svg), top: 0, left: 0 },
    { input: productBuf, top: productTop, left: productLeft },
  ];
  if (logoHeader) {
    composites.push({ input: logoHeader, top: 44, left: 40 });
  }
  if (qrSmall) {
    composites.push({
      input: qrSmall,
      top: qrY + Math.floor((qrBox - qrSize) / 2),
      left: qrX + Math.floor((qrBox - qrSize) / 2),
    });
  }
  if (logoFoot) {
    composites.push({
      input: logoFoot,
      top: qrY + Math.floor((qrBox - footLogoSize) / 2),
      left: qrX + qrBox + 16,
    });
  }

  const out = await sharp({
    create: {
      width: W,
      height: H,
      channels: 3,
      background: "#111111",
    },
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer();

  if (opts.outDir) {
    fs.mkdirSync(opts.outDir, { recursive: true });
    const file = path.join(opts.outDir, `wm-${layout}-${Date.now()}.jpg`);
    fs.writeFileSync(file, out);
  }

  return out;
}

export async function saveBrandLogoFromBase64(
  dataUrlOrBase64: string,
): Promise<{ path: string; bytes: number }> {
  const raw = String(dataUrlOrBase64 || "");
  const m = raw.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  const b64 = m ? m[2] : raw.replace(/\s/g, "");
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100) throw new Error("imagem inválida");
  if (buf.length > 8_000_000) throw new Error("logo muito grande (máx. ~8MB)");

  const dir = path.join(path.dirname(config.databasePath), "brand");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "logo.png");
  await sharp(buf)
    .resize(256, 256, { fit: "cover" })
    .png()
    .toFile(dest);
  setSetting("brand_logo_path", dest);
  return { path: dest, bytes: fs.statSync(dest).size };
}

export async function saveGroupLogoFromBase64(
  groupId: number,
  dataUrlOrBase64: string,
): Promise<{ path: string; bytes: number }> {
  const raw = String(dataUrlOrBase64 || "");
  const m = raw.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  const b64 = m ? m[2] : raw.replace(/\s/g, "");
  const buf = Buffer.from(b64, "base64");
  return saveGroupLogoFromBuffer(groupId, buf);
}

export async function saveGroupLogoFromBuffer(
  groupId: number,
  buf: Buffer,
): Promise<{ path: string; bytes: number }> {
  if (!Buffer.isBuffer(buf) || buf.length < 100) {
    throw new Error("imagem inválida");
  }
  if (buf.length > 12_000_000) {
    throw new Error("logo muito grande (máx. ~12MB)");
  }
  if (!Number.isFinite(groupId) || groupId < 1) {
    throw new Error("grupo inválido");
  }

  const dir = path.join(path.dirname(config.databasePath), "brand", "groups");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${groupId}.png`);
  await sharp(buf)
    .rotate()
    .resize(256, 256, { fit: "cover" })
    .png()
    .toFile(dest);
  getDb()
    .prepare(`UPDATE wa_groups SET watermark_logo_path = ? WHERE id = ?`)
    .run(dest, groupId);
  return { path: dest, bytes: fs.statSync(dest).size };
}

export function groupLogoPath(groupId: number): string | null {
  const row = getDb()
    .prepare(`SELECT watermark_logo_path FROM wa_groups WHERE id = ?`)
    .get(groupId) as { watermark_logo_path?: string } | undefined;
  const p = String(row?.watermark_logo_path || "").trim();
  if (p && fs.existsSync(p)) return p;
  return null;
}

/** Cartão central do cupom — entra no quadro da marca (header, laterais, QR). */
async function couponCenterCard(opts: {
  kind: "valid" | "exhausted";
  code: string;
  headline?: string;
  detail?: string;
}): Promise<Buffer> {
  const w = 720;
  const h = 520;
  const codeRaw = (opts.code || "CUPOM").slice(0, 22).toUpperCase();
  const code = escapeXml(codeRaw);
  const detailRaw = (opts.detail || "").slice(0, 64);
  const detail = escapeXml(detailRaw);
  const isValid = opts.kind === "valid";
  const pctMatch = detailRaw.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const bigStat = pctMatch
    ? `${pctMatch[1].replace(",0", "").replace(".0", "")}%`
    : isValid
      ? "OFF"
      : "∅";
  const codeSize =
    codeRaw.length > 16 ? 42 : codeRaw.length > 12 ? 52 : codeRaw.length > 9 ? 58 : 68;
  const orange = "#FF6A00";
  const svg = isValid
    ? `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#FFFFFF"/>
    <rect x="28" y="24" width="664" height="472" rx="28" fill="#111111"/>
    <rect x="28" y="24" width="664" height="14" rx="7" fill="${orange}"/>
    <text x="360" y="78" text-anchor="middle"
      font-family="Arial Black, Arial, sans-serif" font-size="18" fill="${orange}">CUPOM MERCADO LIVRE</text>
    <circle cx="360" cy="168" r="58" fill="${orange}"/>
    <text x="360" y="180" text-anchor="middle"
      font-family="Impact, Arial Black, sans-serif" font-size="42" fill="#FFFFFF">${escapeXml(bigStat)}</text>
    <text x="360" y="248" text-anchor="middle"
      font-family="Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="3" fill="#F3F3F3">USE O CÓDIGO</text>
    <text x="360" y="318" text-anchor="middle"
      font-family="Impact, Arial Black, sans-serif" font-size="${codeSize}" fill="#FFFFFF">${code}</text>
    <text x="360" y="368" text-anchor="middle"
      font-family="Arial Black, Arial, sans-serif" font-size="16" fill="${orange}">NO CHECKOUT DO MERCADO LIVRE</text>
    <text x="360" y="410" text-anchor="middle"
      font-family="Arial, sans-serif" font-size="15" fill="#E8E8E8">${escapeXml((opts.headline || "SÓ EM PRODUTOS DA LISTA DO CUPOM").slice(0, 42))}</text>
    ${
      detail
        ? `<text x="360" y="448" text-anchor="middle"
            font-family="Arial, sans-serif" font-size="14" fill="#C8C8C8">${detail}</text>`
        : ""
    }
  </svg>`
    : `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#FFFFFF"/>
    <rect x="28" y="24" width="664" height="472" rx="28" fill="#111111"/>
    <rect x="28" y="24" width="664" height="14" rx="7" fill="#888888"/>
    <text x="360" y="90" text-anchor="middle"
      font-family="Arial Black, Arial, sans-serif" font-size="22" fill="#C8C8C8">CUPOM ESGOTADO</text>
    <text x="360" y="240" text-anchor="middle"
      font-family="Impact, Arial Black, sans-serif" font-size="${codeSize}" fill="#FFFFFF">${code}</text>
    <text x="360" y="310" text-anchor="middle"
      font-family="Arial Black, Arial, sans-serif" font-size="36" fill="${orange}">ESGOTADO</text>
    <text x="360" y="380" text-anchor="middle"
      font-family="Arial, sans-serif" font-size="18" fill="#D0D0D0">Pode voltar a qualquer momento</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Banner 1080×1080 no mesmo quadro da oferta: marca, laterais, engajamento e QR. */
export async function generateCouponBanner(opts: {
  kind: "valid" | "exhausted";
  code: string;
  headline?: string;
  detail?: string;
  groupName?: string;
  inviteUrl?: string | null;
  logoPath?: string | null;
  tagline?: string;
  handle?: string;
  layout?: string | null;
  category?: string;
}): Promise<Buffer> {
  const inner = await couponCenterCard(opts);
  return watermarkProductImage({
    imageBuffer: inner,
    handle: opts.handle,
    tagline: opts.tagline || "CUPONS EM PRODUTOS SELECIONADOS",
    logoPath: opts.logoPath,
    inviteUrl: opts.inviteUrl,
    groupName: opts.groupName || getSetting("brand_group_name", "Careca VIP"),
    layout: opts.layout,
    category: opts.category,
    centerSize: { w: 920, h: 560 },
  });
}
