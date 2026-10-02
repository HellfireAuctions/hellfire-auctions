// Plan definitions shared by the server and the admin pages (no server-only code here).
export const BILLING_NAMES = {
  BLAZE: "Hellfire Auctions Blaze",
  INFERNO: "Hellfire Auctions Inferno",
};

export const PLANS = {
  SPARK: {
    key: "SPARK",
    name: "Spark",
    price: 0,
    monthlyLimit: 10,
    emails: false,
    branding: true,
    hotBadge: false,
  },
  BLAZE: {
    key: "BLAZE",
    name: "Blaze",
    price: 10,
    monthlyLimit: 90,
    emails: true,
    branding: false,
    hotBadge: false,
  },
  INFERNO: {
    key: "INFERNO",
    name: "Inferno",
    price: 25,
    monthlyLimit: Infinity,
    emails: true,
    branding: false,
    hotBadge: true,
  },
};

export const HOT_BID_THRESHOLD = 10;
export const TRIAL_DAYS = 7;
