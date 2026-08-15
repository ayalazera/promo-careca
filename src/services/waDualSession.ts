/**
 * Segundo número WhatsApp (opcional): TCG em sessão separada.
 * Se wa_auth_tcg_dir não estiver configurado / sem creds, usa o número principal.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getSetting } from "../db/index.js";

export function tcgAuthDir(): string {
  const custom = getSetting("wa_auth_tcg_dir", "").trim();
  if (custom) return custom;
  return path.join(path.dirname(config.authDir), "whatsapp-auth-tcg");
}

export function secondaryWaConfigured(): boolean {
  const dir = tcgAuthDir();
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.existsSync(path.join(dir, "creds.json"));
  } catch {
    return false;
  }
}

export function routeSessionForCategories(categories?: string | null): "primary" | "tcg" {
  const c = String(categories || "").toLowerCase();
  if (/(^|,)\s*tcg\s*(,|$)/.test(c) && secondaryWaConfigured()) return "tcg";
  return "primary";
}

export function dualWaStatus() {
  return {
    primaryAuthDir: config.authDir,
    tcgAuthDir: tcgAuthDir(),
    tcgReady: secondaryWaConfigured(),
    note: secondaryWaConfigured()
      ? "TCG pode usar sessão secundária"
      : "Só 1 número ativo — configure wa_auth_tcg_dir + QR na pasta TCG para dual",
  };
}
