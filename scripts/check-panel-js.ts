/**
 * Garante que o JS do painel parseia (botões dependem disso).
 * Uso: npx tsx scripts/check-panel-js.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const htmlPath = path.resolve("public/index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const start = html.indexOf("<script>");
const end = html.lastIndexOf("</script>");
if (start < 0 || end < 0) {
  console.error("FAIL sem bloco <script> em public/index.html");
  process.exit(1);
}
const script = html.slice(start + 8, end);
const tmp = "/tmp/promo-panel-check.js";
fs.writeFileSync(tmp, script);
const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
if (r.status !== 0) {
  console.error("FAIL JS do painel não parseia — nenhum botão vai funcionar:");
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
if (!script.includes("document.getElementById('tabs').addEventListener")) {
  console.error("FAIL listener das abas sumiu");
  process.exit(1);
}
console.log("ok painel JS parseia (", script.split("\n").length, "linhas)");
