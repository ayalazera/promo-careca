export type IncomingDeal = {
  external_id: string;
  source: string;
  title: string;
  description: string;
  category: string;
  price: number;
  old_price: number | null;
  currency: string;
  coupon: string | null;
  image_url: string | null;
  product_url: string;
  affiliate_url: string;
  /** Comissão / GANHOS EXTRAS (%) quando veio do Hub */
  commission_pct?: number | null;
};
