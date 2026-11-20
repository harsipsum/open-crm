// A company's tech stack: the systems it runs, each line with where we
// learned it. A line the team entered is verified; one from an email or a
// public page is not, until a member confirms it.

export const TECH_CATEGORIES = [
  "ERP",
  "CRM",
  "ACCOUNTING",
  "ITSM",
  "COLLABORATION",
  "E_INVOICING",
  "OTHER",
] as const;
export type TechCategory = (typeof TECH_CATEGORIES)[number];

export const TECH_CATEGORY_LABELS: Record<TechCategory, string> = {
  ERP: "ERP",
  CRM: "CRM",
  ACCOUNTING: "Accounting",
  ITSM: "ITSM",
  COLLABORATION: "Collaboration",
  E_INVOICING: "E-invoicing",
  OTHER: "Other",
};

/** team: a member entered it; email: read from the team's mail; public: a public page. */
export const TECH_ORIGINS = ["team", "email", "public"] as const;

/** One product per company, whatever its case or spacing. */
export function techProductKey(product: string): string {
  return product.trim().replace(/\s+/g, " ").toLowerCase();
}
