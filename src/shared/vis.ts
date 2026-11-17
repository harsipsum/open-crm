// Star CRM: the lead-to-won layer on top of the CRM (sources and click ids set
// at first touch, per-app write keys, research, SDR timers, the won handoff
// and offline conversions). Shared by the server and the deal panel.

/** The sibling apps that write into the CRM, each with its own key. */
export const VIS_APPS = [
  "VISINBOX",
  "VISAGENT",
  "VISPROPOSALS",
  "VISWEB",
] as const;
export type VisApp = (typeof VIS_APPS)[number];

/** What a key may do. A key carries only its app's scopes. */
export const VIS_SCOPES = [
  "leads:write",
  "deals:read",
  "notes:write",
  "stage:write",
  "research:write",
] as const;
export type VisScope = (typeof VIS_SCOPES)[number];

export const APP_SCOPES: Record<VisApp, readonly VisScope[]> = {
  // Inbound conversations: new leads and what was said.
  VISINBOX: ["leads:write", "deals:read", "notes:write"],
  // The website agent: leads, its qualification and its research.
  VISAGENT: [
    "leads:write",
    "deals:read",
    "notes:write",
    "stage:write",
    "research:write",
  ],
  // Proposals read the deal, file versions as notes and move the stage.
  VISPROPOSALS: ["deals:read", "notes:write", "stage:write"],
  // The website forms, called from the site's own server: new leads only, so
  // a key taken from that host can add a lead and read or change nothing.
  VISWEB: ["leads:write"],
};

/** Where a lead first came from, set by the system, never typed. */
export const LEAD_SOURCES = [
  "WEB_FORM",
  "WEB_CHAT",
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "LINKEDIN",
  "GOOGLE_ADS",
  "META_ADS",
  "LINKEDIN_ADS",
  "REFERRAL",
  "COLD_CALL",
  "EVENT",
  "OTHER",
] as const;
type LeadSource = (typeof LEAD_SOURCES)[number];

/** Sources where the person reached out, which get the 5-minute call. */
export const INBOUND_SOURCES: readonly LeadSource[] = [
  "WEB_FORM",
  "WEB_CHAT",
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "LINKEDIN",
  "GOOGLE_ADS",
  "META_ADS",
  "LINKEDIN_ADS",
];

/**
 * A phone number as Star CRM matches it: E.164, "+" and digits only, so a
 * WhatsApp sender (+971501234567) and a form ("00971 50 123 4567") are the
 * same person. Null when there aren't enough digits to be a number.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** The products Vistar resells (HubSpot "Product / Solution"). */
export const PRODUCTS = ["CLEARTAX", "ASANA", "FRESHWORKS", "LARK"] as const;
export type Product = (typeof PRODUCTS)[number];
export const PRODUCT_LABELS: Record<Product, string> = {
  CLEARTAX: "ClearTax",
  ASANA: "Asana",
  FRESHWORKS: "Freshworks",
  LARK: "Lark",
};

/** HubSpot "Deal Type"; the Asana intake project calls it Order Type. */
export const ORDER_TYPES = ["NEW", "RENEWAL", "UPGRADE"] as const;
type OrderType = (typeof ORDER_TYPES)[number];
export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  NEW: "New",
  RENEWAL: "Renewal",
  UPGRADE: "Upgrade",
};

/** The Asana intake project's own options (read 15 Nov 2026, schema only). */
export const ASANA_LICENSE_TYPES = [
  "Starter",
  "Advanced",
  "Enterprise",
  "Enterprise+",
  "N/A",
] as const;
export const FRESHWORKS_PRODUCTS = [
  "Freshservice",
  "Freshsales",
  "Freshdesk",
] as const;
export type FreshworksProduct = (typeof FRESHWORKS_PRODUCTS)[number];

export const CONSENT_STATES = ["GRANTED", "DENIED", "UNKNOWN"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

/**
 * Vistar's HubSpot Sales Pipeline (portal 9344866), read 15 Nov 2026 ~00:30
 * Dubai: the names, order and outcomes as HubSpot has them.
 */
export const VISTAR_PIPELINE = {
  name: "Sales Pipeline",
  stages: [
    "Lead Generated",
    "Initial Meeting / Demo",
    "On Hold",
    "MQL",
    "SQL",
    "Technical Demo / POC / Integration Discussion",
    "Proposal Discussion / Budget Qualified",
    "Best Case",
    "Forecast Commit",
    "Deal Won",
    "Deal Lost",
  ],
} as const;

/**
 * The stages Star CRM acts on, by name: a new lead lands at `intake`; reaching
 * `qualified` or any later open stage runs the person research and the
 * brief and sends the qualified-lead conversion; `won` hands off to Asana
 * and sends the purchase conversion.
 */
export const STAGE_ROLES = {
  intake: "Lead Generated",
  qualified: "SQL",
  won: "Deal Won",
  lost: "Deal Lost",
} as const;

/** The SDR promise: call an inbound lead within 5 minutes, escalate at 24 h. */
export const SDR_CALL_MINUTES = 5;
export const SDR_ESCALATE_HOURS = 24;

export const RESEARCH_KINDS = ["COMPANY", "PERSON", "BRIEF"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];
export const RESEARCH_STATUSES = [
  "PENDING",
  "DONE",
  "NOT_FOUND",
  "FAILED",
] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const CONVERSION_PLATFORMS = ["GOOGLE", "META", "LINKEDIN"] as const;
export type ConversionPlatform = (typeof CONVERSION_PLATFORMS)[number];
export const CONVERSION_EVENTS = ["QUALIFIED_LEAD", "PURCHASE"] as const;
export type ConversionEventName = (typeof CONVERSION_EVENTS)[number];
export const CONVERSION_STATUSES = [
  "PENDING",
  "DRY_RUN",
  "SENT",
  "SKIPPED",
  "FAILED",
] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];

export const SDR_TIMER_STATUSES = ["OPEN", "DONE", "ESCALATED"] as const;
