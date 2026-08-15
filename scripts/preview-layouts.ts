import fs from "node:fs";
import path from "node:path";
import { getDb, setSetting } from "../src/db/index.js";
import { watermarkProductImage } from "../src/services/imageWatermark.js";
import { resolveDealPrices } from "../src/services/dealDisplay.js";

setSetting("ml_pix_percent", "0");
const deal = getDb().prepare("SELECT * FROM deals WHERE id=1560").get() as {
  image_url?: string;
};
const pct = resolveDealPrices(
  getDb().prepare("SELECT * FROM deals WHERE id=1560").get() as never,
).discountPct;
const outDir = path.join("data", "brand", "layout-previews");
fs.mkdirSync(outDir, { recursive: true });

const layouts = ["classic", "neon", "pulse", "hearth", "studio"] as const;
for (const layout of layouts) {
  const buf = await watermarkProductImage({
    imageUrl: deal.image_url,
    groupName: "Careca VIP | Casa",
    tagline: "Casa e decoração com desconto",
    category: "casa",
    layout,
    discountPct: pct,
    inviteUrl: "https://chat.whatsapp.com/KFTf7jBkEZk7GVpD5JlCw6",
  });
  const dest = path.join(outDir, `${layout}.jpg`);
  fs.writeFileSync(dest, buf);
  console.log("ok", layout, buf.length, dest);
}
