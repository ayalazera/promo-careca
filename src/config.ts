import "dotenv/config";
import path from "node:path";

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const config = {
  port: num(process.env.PORT, 3847),
  databasePath: path.resolve(
    process.cwd(),
    process.env.DATABASE_PATH || "./data/promo.db",
  ),
  authDir: path.resolve(
    process.cwd(),
    process.env.AUTH_DIR || "./data/whatsapp-auth",
  ),
  /** Alinhado à cadência semana 1 (12–20 min). */
  defaultIntervalMinutes: num(process.env.DEFAULT_INTERVAL_MINUTES, 12),
  antiBan: {
    minDelaySec: num(process.env.ANTIBAN_MIN_DELAY_SEC, 90),
    maxDelaySec: num(process.env.ANTIBAN_MAX_DELAY_SEC, 240),
    maxPerHour: num(process.env.ANTIBAN_MAX_PER_HOUR, 5),
    maxPerDay: num(process.env.ANTIBAN_MAX_PER_DAY, 40),
    maxGroupsPerWave: num(process.env.ANTIBAN_MAX_GROUPS_PER_WAVE, 1),
    cooldownAfterWaveMin: num(process.env.ANTIBAN_COOLDOWN_AFTER_WAVE_MIN, 12),
    quietStartHour: num(process.env.ANTIBAN_QUIET_START, 22),
    quietEndHour: num(process.env.ANTIBAN_QUIET_END, 9),
    warmupDays: num(process.env.ANTIBAN_WARMUP_DAYS, 14),
    warmupMaxPerDay: num(process.env.ANTIBAN_WARMUP_MAX_PER_DAY, 40),
    sameTextCooldownMin: num(process.env.ANTIBAN_SAME_TEXT_COOLDOWN_MIN, 180),
  },
  amazon: {
    partnerTag: process.env.AMAZON_PARTNER_TAG || "",
    accessKey: process.env.AMAZON_ACCESS_KEY || "",
    secretKey: process.env.AMAZON_SECRET_KEY || "",
  },
  mercadoLivre: {
    accessToken: process.env.ML_ACCESS_TOKEN || "",
    affiliateTag: process.env.ML_AFFILIATE_TAG || "",
    refreshToken: process.env.ML_REFRESH_TOKEN || "",
    clientId: process.env.ML_CLIENT_ID || "",
    clientSecret: process.env.ML_CLIENT_SECRET || "",
  },
  credentialsSecret: process.env.CREDENTIALS_SECRET || "",
  demoMode: bool(process.env.DEMO_MODE, true),
};

export const CATEGORIES = [
  { id: "eletronicos", label: "Eletrônicos", emoji: "📱" },
  { id: "games", label: "Games", emoji: "🎮" },
  { id: "tcg", label: "Cartas TCG", emoji: "🃏" },
  { id: "casa", label: "Casa & Cozinha", emoji: "🏠" },
  { id: "geral", label: "Geral", emoji: "🔥" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];
