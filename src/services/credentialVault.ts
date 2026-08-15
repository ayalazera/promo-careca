import crypto from "node:crypto";
import { config } from "../config.js";
import { affiliateDefaultsFromEnv } from "../affiliateCatalog.js";
import { getSetting, setSetting } from "../db/index.js";

export type AmazonCreds = {
  accessKey: string;
  secretKey: string;
  partnerTag: string;
  host: string;
  region: string;
};

export type MercadoLivreCreds = {
  accessToken: string;
  refreshToken: string;
  /** @deprecated no programa novo: use creatorUsername + links meli.la por produto */
  affiliateTag: string;
  /** Usuário do perfil social/criador, ex.: ocarafmz */
  creatorUsername: string;
  clientId: string;
  clientSecret: string;
  /** Cookie completo da sessão logada no Hub / createLink (F12 → Rede) */
  hubCookie: string;
  /** Header x-csrf-token da requisição createLink */
  hubCsrf: string;
  /** Etiqueta de afiliado usada no createLink (ex.: whatsapp, ocarafmz) */
  hubTag: string;
};

export type ShopeeCreds = {
  appId: string;
  secret: string;
  affiliateId: string;
};

export type MagaluCreds = {
  token: string;
  partnerId: string;
};

export type AwinCreds = {
  publisherId: string;
  apiKey: string;
};

type VaultShape = {
  amazon?: AmazonCreds;
  mercadolivre?: MercadoLivreCreds;
  shopee?: ShopeeCreds;
  magalu?: MagaluCreds;
  awin?: AwinCreds;
};

function vaultKey(): Buffer {
  const secret =
    process.env.CREDENTIALS_SECRET ||
    process.env.VAULT_SECRET ||
    `promo-local-${config.databasePath}`;
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptJson(data: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey(), iv);
  const plain = Buffer.from(JSON.stringify(data), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

function decryptJson<T>(payload: string): T | null {
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      vaultKey(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(dec.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function readVault(): VaultShape {
  const raw = getSetting("credentials_vault", "");
  if (!raw) return {};
  return decryptJson<VaultShape>(raw) ?? {};
}

function writeVault(vault: VaultShape): void {
  setSetting("credentials_vault", encryptJson(vault));
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

const envAff = affiliateDefaultsFromEnv();

export function getAmazonCreds(): AmazonCreds {
  const v = readVault().amazon;
  return {
    accessKey: v?.accessKey || config.amazon.accessKey,
    secretKey: v?.secretKey || config.amazon.secretKey,
    partnerTag: v?.partnerTag || config.amazon.partnerTag,
    host: v?.host || "webservices.amazon.com.br",
    region: v?.region || "us-east-1",
  };
}

/** ID do Compartilhar do produto (ex.: RLHYPL-3RZ4) — NÃO é ID da conta afiliada. */
function isProductShareId(raw: string): boolean {
  return /^[A-Z0-9]{4,10}-[A-Z0-9]{3,8}$/i.test((raw || "").trim());
}

function sanitizeAffiliateTag(raw: string, fallbackUsername = ""): string {
  const s = (raw || "").trim();
  if (!s || isProductShareId(s) || /^https?:\/\/(?:www\.)?meli\.la\//i.test(s)) {
    return fallbackUsername;
  }
  return s;
}

export function getMercadoLivreCreds(): MercadoLivreCreds {
  const v = readVault().mercadolivre;
  const username =
    (v?.creatorUsername || "").trim() ||
    extractCreatorUsername(v?.affiliateTag || "") ||
    extractCreatorUsername(config.mercadoLivre.affiliateTag || "");
  const rawTag = v?.affiliateTag || config.mercadoLivre.affiliateTag || "";
  return {
    accessToken: v?.accessToken || config.mercadoLivre.accessToken,
    refreshToken: v?.refreshToken || config.mercadoLivre.refreshToken || "",
    affiliateTag: sanitizeAffiliateTag(rawTag, username),
    creatorUsername: username,
    clientId: v?.clientId || config.mercadoLivre.clientId || "",
    clientSecret: v?.clientSecret || config.mercadoLivre.clientSecret || "",
    hubCookie: v?.hubCookie || process.env.ML_HUB_COOKIE || "",
    hubCsrf: v?.hubCsrf || process.env.ML_HUB_CSRF || "",
    hubTag:
      v?.hubTag ||
      process.env.ML_HUB_TAG ||
      sanitizeAffiliateTag(rawTag, username),
  };
}

function extractCreatorUsername(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  if (isProductShareId(s) || /^https?:\/\/(?:www\.)?meli\.la\//i.test(s)) {
    return "";
  }
  const fromUrl = s.match(
    /mercadolivre\.com\.br\/social\/([a-zA-Z0-9._-]+)/i,
  );
  if (fromUrl?.[1]) return fromUrl[1];
  // username simples — evita confundir com ID de produto TIPO-XXXX
  if (/^@?[a-zA-Z0-9._]{3,40}$/.test(s) && !s.includes("-")) {
    return s.replace(/^@/, "");
  }
  return "";
}

export function getShopeeCreds(): ShopeeCreds {
  const v = readVault().shopee;
  return {
    appId: v?.appId || envAff.shopee.appId,
    secret: v?.secret || envAff.shopee.secret,
    affiliateId: v?.affiliateId || envAff.shopee.affiliateId,
  };
}

export function getMagaluCreds(): MagaluCreds {
  const v = readVault().magalu;
  return {
    token: v?.token || envAff.magalu.token,
    partnerId: v?.partnerId || envAff.magalu.partnerId,
  };
}

export function getAwinCreds(): AwinCreds {
  const v = readVault().awin;
  return {
    publisherId: v?.publisherId || envAff.awin.publisherId,
    apiKey: v?.apiKey || envAff.awin.apiKey,
  };
}

export function amazonConfigured(): boolean {
  const c = getAmazonCreds();
  return Boolean(c.accessKey && c.secretKey && c.partnerTag);
}

export function mlConfigured(): boolean {
  const c = getMercadoLivreCreds();
  // Automação real = sessão do Hub; rótulo sozinho não conta como "pronto"
  return Boolean(
    (c.hubCookie && c.hubCsrf && (c.hubTag || c.affiliateTag)) ||
      c.accessToken ||
      (c.clientId && c.clientSecret) ||
      c.creatorUsername,
  );
}

export function shopeeConfigured(): boolean {
  const c = getShopeeCreds();
  return Boolean(c.appId && c.secret && c.affiliateId);
}

export function magaluConfigured(): boolean {
  const c = getMagaluCreds();
  return Boolean(c.token || c.partnerId);
}

export function awinConfigured(): boolean {
  const c = getAwinCreds();
  return Boolean(c.publisherId);
}

export function getCredentialsPublicStatus() {
  const amazon = getAmazonCreds();
  const ml = getMercadoLivreCreds();
  const shopee = getShopeeCreds();
  const magalu = getMagaluCreds();
  const awin = getAwinCreds();
  return {
    storage: "AES-256-GCM (cofre local) + fallback .env",
    note: "Nunca pedimos senha da conta pessoal. Só chaves/tokens de afiliado oficiais.",
    amazon: {
      configured: amazonConfigured(),
      partnerTag: amazon.partnerTag || null,
      accessKeyMasked: mask(amazon.accessKey),
      host: amazon.host,
      region: amazon.region,
    },
    mercadolivre: {
      configured: mlConfigured(),
      creatorUsername: ml.creatorUsername || null,
      profileUrl: ml.creatorUsername
        ? `https://www.mercadolivre.com.br/social/${ml.creatorUsername}`
        : null,
      affiliateTag: ml.affiliateTag || null,
      hubTag: ml.hubTag || null,
      accessTokenMasked: mask(ml.accessToken),
      hasRefreshToken: Boolean(ml.refreshToken),
      hasOAuthApp: Boolean(ml.clientId && ml.clientSecret),
      hubSession: Boolean(ml.hubCookie && ml.hubCsrf),
      hubCookieMasked: mask(ml.hubCookie),
      hasHubCsrf: Boolean(ml.hubCsrf),
      linkMode: ml.hubCookie && ml.hubCsrf ? "hub_auto" : "hub_manual",
      note: ml.hubCookie
        ? "Sessão do Hub salva: a ferramenta pode listar GANHOS EXTRAS e gerar meli.la."
        : "Para automação: cole Cookie + CSRF do Hub (F12 → createLink).",
      hubUrl:
        "https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true",
    },
    shopee: {
      configured: shopeeConfigured(),
      appIdMasked: mask(shopee.appId),
      affiliateId: shopee.affiliateId || null,
    },
    magalu: {
      configured: magaluConfigured(),
      partnerId: magalu.partnerId || null,
      tokenMasked: mask(magalu.token),
    },
    awin: {
      configured: awinConfigured(),
      publisherId: awin.publisherId || null,
      apiKeyMasked: mask(awin.apiKey),
    },
  };
}

export function saveAmazonCreds(input: Partial<AmazonCreds>): void {
  const current = getAmazonCreds();
  const vault = readVault();
  vault.amazon = {
    accessKey: input.accessKey?.trim() || current.accessKey,
    secretKey: input.secretKey?.trim() || current.secretKey,
    partnerTag: input.partnerTag?.trim() || current.partnerTag,
    host: input.host?.trim() || current.host || "webservices.amazon.com.br",
    region: input.region?.trim() || current.region || "us-east-1",
  };
  writeVault(vault);
}

export function saveMercadoLivreCreds(input: Partial<MercadoLivreCreds>): void {
  const current = getMercadoLivreCreds();
  const vault = readVault();
  const creatorUsername =
    extractCreatorUsername(input.creatorUsername || "") ||
    extractCreatorUsername(input.affiliateTag || "") ||
    current.creatorUsername;
  const incomingTag = (input.affiliateTag || "").trim();
  // Nunca persistir ID de produto / meli.la como tag da conta
  const affiliateTag = sanitizeAffiliateTag(
    incomingTag || creatorUsername || current.affiliateTag,
    creatorUsername,
  );
  vault.mercadolivre = {
    accessToken: input.accessToken?.trim() || current.accessToken,
    refreshToken: input.refreshToken?.trim() || current.refreshToken,
    affiliateTag,
    creatorUsername,
    clientId: input.clientId?.trim() || current.clientId,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
    hubCookie:
      input.hubCookie !== undefined
        ? String(input.hubCookie).trim()
        : current.hubCookie,
    hubCsrf:
      input.hubCsrf !== undefined
        ? String(input.hubCsrf).trim()
        : current.hubCsrf,
    hubTag:
      input.hubTag !== undefined
        ? String(input.hubTag).trim()
        : current.hubTag || creatorUsername,
  };
  writeVault(vault);
  if (input.hubCookie !== undefined || input.hubCsrf !== undefined) {
    setSetting("hub_session_alert", "");
  }
}

export function saveShopeeCreds(input: Partial<ShopeeCreds>): void {
  const current = getShopeeCreds();
  const vault = readVault();
  vault.shopee = {
    appId: input.appId?.trim() || current.appId,
    secret: input.secret?.trim() || current.secret,
    affiliateId: input.affiliateId?.trim() || current.affiliateId,
  };
  writeVault(vault);
}

export function saveMagaluCreds(input: Partial<MagaluCreds>): void {
  const current = getMagaluCreds();
  const vault = readVault();
  vault.magalu = {
    token: input.token?.trim() || current.token,
    partnerId: input.partnerId?.trim() || current.partnerId,
  };
  writeVault(vault);
}

export function saveAwinCreds(input: Partial<AwinCreds>): void {
  const current = getAwinCreds();
  const vault = readVault();
  vault.awin = {
    publisherId: input.publisherId?.trim() || current.publisherId,
    apiKey: input.apiKey?.trim() || current.apiKey,
  };
  writeVault(vault);
}

export function clearProviderCreds(
  provider: "amazon" | "mercadolivre" | "shopee" | "magalu" | "awin",
): void {
  const vault = readVault();
  delete vault[provider];
  writeVault(vault);
}
