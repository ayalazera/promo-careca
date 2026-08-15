import sharp from "sharp";
import http from "node:http";
import { watermarkProductImage } from "../src/services/imageWatermark.ts";

async function main() {
  const img = await sharp({
    create: { width: 640, height: 800, channels: 3, background: "#c8cdd8" },
  })
    .jpeg()
    .toBuffer();
  const srv = http.createServer((_req, res) => {
    res.setHeader("content-type", "image/jpeg");
    res.end(img);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const buf = await watermarkProductImage({
    imageUrl: `http://127.0.0.1:${port}/p.jpg`,
    handle: "@carecavip.tech",
    tagline: "AS MELHORES OFERTAS EM UM SÓ LUGAR!",
    groupName: "Careca VIP | Eletrônicos",
    category: "eletronicos",
    inviteUrl: "https://chat.whatsapp.com/KFTf7jBkEZk7GV",
    logoPath: "/agent/promo-autonomo/data/brand/logo.png",
  });
  const out = "/tmp/promo-card-preview.jpg";
  await sharp(buf).toFile(out);
  const meta = await sharp(buf).metadata();
  console.log("bytes", buf.length, "size", meta.width, meta.height);
  if (meta.width !== 1080 || meta.height !== 1080) {
    throw new Error(`arte deve ser 1080x1080, veio ${meta.width}x${meta.height}`);
  }
  srv.close();
}

void main();
