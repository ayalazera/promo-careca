/**
 * Garante JPEGs de preview dos layouts em data/brand/layout-previews/.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { IMAGE_LAYOUTS, type ImageLayoutId } from "./imageLayouts.js";
import { watermarkProductImage } from "./imageWatermark.js";

export function layoutPreviewDir(): string {
  return path.join(path.dirname(config.databasePath), "brand", "layout-previews");
}

export function layoutPreviewPath(
  layout: Exclude<ImageLayoutId, "auto">,
): string {
  return path.join(layoutPreviewDir(), `${layout}.jpg`);
}

async function sampleProductPng(): Promise<Buffer> {
  const svg = `
  <svg width="640" height="640" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#F4F6FA"/>
        <stop offset="100%" stop-color="#E2E8F0"/>
      </linearGradient>
    </defs>
    <rect width="640" height="640" fill="url(#g)"/>
    <rect x="120" y="160" width="400" height="280" rx="28" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="3"/>
    <circle cx="320" cy="280" r="54" fill="#94A3B8" fill-opacity="0.35"/>
    <text x="320" y="290" text-anchor="middle"
      font-family="Arial Black, Arial, sans-serif" font-size="28" fill="#334155">PRODUTO</text>
    <text x="320" y="400" text-anchor="middle"
      font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#64748B">preview do layout</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const SAMPLE_BY_LAYOUT: Record<
  Exclude<ImageLayoutId, "auto">,
  { groupName: string; tagline: string; category: string }
> = {
  classic: {
    groupName: "Careca VIP | Achadinhos",
    tagline: "Achadinhos do dia pra comprar agora",
    category: "geral",
  },
  neon: {
    groupName: "Careca VIP | TCG",
    tagline: "Pokémon, Yu-Gi-Oh, sleeves e colecionáveis",
    category: "tcg",
  },
  pulse: {
    groupName: "Careca VIP | Eletrônicos",
    tagline: "Eletrônicos com o menor preço",
    category: "eletronicos",
  },
  hearth: {
    groupName: "Careca VIP | Casa",
    tagline: "Casa e decoração com desconto",
    category: "casa",
  },
  studio: {
    groupName: "Careca VIP | Moda",
    tagline: "Peças top sem esvaziar a carteira",
    category: "moda",
  },
};

export async function ensureLayoutPreview(
  layout: Exclude<ImageLayoutId, "auto">,
  force = false,
): Promise<string> {
  const dest = layoutPreviewPath(layout);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 20_000) {
    return dest;
  }
  fs.mkdirSync(layoutPreviewDir(), { recursive: true });
  const sample = SAMPLE_BY_LAYOUT[layout];
  const product = await sampleProductPng();
  const buf = await watermarkProductImage({
    imageBuffer: product,
    groupName: sample.groupName,
    tagline: sample.tagline,
    category: sample.category,
    layout,
    discountPct: 35,
    inviteUrl: "https://chat.whatsapp.com/preview",
  });
  fs.writeFileSync(dest, buf);
  return dest;
}

export async function ensureAllLayoutPreviews(force = false): Promise<
  Array<{ id: string; path: string; url: string }>
> {
  const out: Array<{ id: string; path: string; url: string }> = [];
  for (const layout of IMAGE_LAYOUTS) {
    const p = await ensureLayoutPreview(layout.id, force);
    out.push({
      id: layout.id,
      path: p,
      url: `/api/layouts/${layout.id}/preview`,
    });
  }
  return out;
}
