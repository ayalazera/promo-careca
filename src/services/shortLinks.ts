/** Link curto no post: meli.la sem query e URL de grupo configurável. */

export function cleanAffiliateUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (/^meli\.la$/i.test(u.hostname)) {
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    }
    return raw;
  } catch {
    return raw.split("?")[0] || raw;
  }
}

export async function shortenHttpUrl(longUrl: string): Promise<string> {
  const long = String(longUrl || "").trim();
  if (!/^https?:\/\//i.test(long)) {
    throw new Error("URL precisa começar com https://");
  }
  if (/meli\.la\//i.test(long)) return cleanAffiliateUrl(long);

  const encoded = encodeURIComponent(long);
  const endpoints = [
    `https://is.gd/create.php?format=simple&url=${encoded}`,
    `https://tinyurl.com/api-create.php?url=${encoded}`,
  ];
  let last = "encurtador indisponível";
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(12_000),
      });
      const text = (await res.text()).trim();
      if (res.ok && /^https?:\/\/\S+$/i.test(text) && text.length < long.length) {
        return text;
      }
      last = text.slice(0, 180) || `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(last);
}
