import crypto from "node:crypto";
import {
  canCallProvider,
  cacheGet,
  cacheSet,
  jitterDelayMs,
  mintAmazonAffiliateUrl,
  recordProviderResult,
} from "./pulseGuard.js";
import { getAmazonCreds } from "./credentialVault.js";
import type { IncomingDeal } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function hashSha256(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function amzDateParts(date = new Date()): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  // ex: 20260812T012800Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Assinatura AWS SigV4 para Product Advertising API 5.0 */
function signPaapiRequest(opts: {
  host: string;
  region: string;
  accessKey: string;
  secretKey: string;
  body: string;
  amzTarget: string;
}): Record<string, string> {
  const service = "ProductAdvertisingAPI";
  const { amzDate, dateStamp } = amzDateParts();
  const canonicalUri = "/paapi5/searchitems";
  const canonicalQuerystring = "";
  const payloadHash = hashSha256(opts.body);
  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${opts.host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${opts.amzTarget}\n`;
  const signedHeaders =
    "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const canonicalRequest = [
    "POST",
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashSha256(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${opts.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    host: opts.host,
    "x-amz-date": amzDate,
    "x-amz-target": opts.amzTarget,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function mapAmazonCategory(searchIndex: string): string {
  if (searchIndex === "VideoGames") return "games";
  if (searchIndex === "Electronics") return "eletronicos";
  if (searchIndex === "ToysAndGames") return "tcg";
  return "geral";
}

export async function searchAmazonDeals(
  keywords: string,
  searchIndex = "Electronics",
): Promise<IncomingDeal[]> {
  const creds = getAmazonCreds();
  if (!creds.accessKey || !creds.secretKey || !creds.partnerTag) return [];

  const cacheKey = `amazon:search:${searchIndex}:${keywords.toLowerCase()}`;
  const cached = cacheGet(cacheKey) as IncomingDeal[] | null;
  if (cached?.length) return cached;

  const gate = canCallProvider("amazon");
  if (!gate.ok) return [];

  await sleep(jitterDelayMs("amazon"));

  const bodyObj = {
    PartnerTag: creds.partnerTag,
    PartnerType: "Associates",
    Keywords: keywords,
    SearchIndex: searchIndex,
    ItemCount: 5,
    Resources: [
      "Images.Primary.Large",
      "ItemInfo.Title",
      "ItemInfo.Features",
      "Offers.Listings.Price",
      "Offers.Listings.SavingBasis",
    ],
  };
  const body = JSON.stringify(bodyObj);
  const amzTarget = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems";
  const headers = signPaapiRequest({
    host: creds.host,
    region: creds.region,
    accessKey: creds.accessKey,
    secretKey: creds.secretKey,
    body,
    amzTarget,
  });

  const started = Date.now();
  try {
    const res = await fetch(`https://${creds.host}/paapi5/searchitems`, {
      method: "POST",
      headers,
      body,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      recordProviderResult("amazon", {
        ok: false,
        status: res.status,
        latencyMs,
        detail: await res.text().then((t) => t.slice(0, 180)),
      });
      return [];
    }
    const json = (await res.json()) as {
      SearchResult?: {
        Items?: Array<{
          ASIN?: string;
          DetailPageURL?: string;
          Images?: { Primary?: { Large?: { URL?: string } } };
          ItemInfo?: {
            Title?: { DisplayValue?: string };
            Features?: { DisplayValues?: string[] };
          };
          Offers?: {
            Listings?: Array<{
              Price?: { Amount?: number; Currency?: string };
              SavingBasis?: { Amount?: number };
            }>;
          };
        }>;
      };
    };

    recordProviderResult("amazon", {
      ok: true,
      status: 200,
      latencyMs,
      detail: keywords,
    });

    const items = json.SearchResult?.Items ?? [];
    const deals: IncomingDeal[] = items
      .filter((i) => i.ASIN)
      .map((i) => {
        const price = i.Offers?.Listings?.[0]?.Price?.Amount ?? 0;
        const old = i.Offers?.Listings?.[0]?.SavingBasis?.Amount ?? null;
        const title = i.ItemInfo?.Title?.DisplayValue || i.ASIN!;
        const features = i.ItemInfo?.Features?.DisplayValues?.[0] || "";
        const productUrl =
          i.DetailPageURL || `https://www.amazon.com.br/dp/${i.ASIN}`;
        return {
          external_id: i.ASIN!,
          source: "amazon",
          title,
          description: features.slice(0, 180),
          category: mapAmazonCategory(searchIndex),
          price,
          old_price: old,
          currency: i.Offers?.Listings?.[0]?.Price?.Currency || "BRL",
          coupon: null,
          image_url: i.Images?.Primary?.Large?.URL || null,
          product_url: productUrl,
          // Mint local: não gasta cota só para gerar link
          affiliate_url: mintAmazonAffiliateUrl(productUrl, creds.partnerTag),
        };
      })
      .filter((d) => d.price > 0);

    cacheSet(cacheKey, deals, 180); // 3h — reduz calor da API
    return deals;
  } catch (err) {
    recordProviderResult("amazon", {
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
