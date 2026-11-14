import type { Product } from "@/shared/vis";

// The ICP fit score, 0 to 100, from Vistar's qualification checklist
// (projects/vistar/drafts/20261114-icp-inferred.md in HarsOS, inferred from
// 176 won deals): a GCC entity, 200+ staff (50+ for Asana and Lark), a
// product-fit signal, a buyer role, and a decision inside six months. Each
// reason it gives is one the SDR can read on the deal.

const GCC = new Set([
  "ae",
  "uae",
  "united arab emirates",
  "sa",
  "ksa",
  "saudi arabia",
  "om",
  "oman",
  "bh",
  "bahrain",
  "kw",
  "kuwait",
  "qa",
  "qatar",
]);

const BUYER_ROLE =
  /\b(cfo|finance|financial|controller|accounts?|tax|it|cio|cto|technology|pmo|project|operations|ops|coo|ceo|founder|managing director|md|head|director|vp)\b/i;

const KNOWN_ERP =
  /\b(sap|oracle|dynamics|netsuite|odoo|tally|sage|zoho|focus|ramco|epicor|infor)\b/i;

type FitInput = {
  product: Product | null;
  country: string | null;
  headcount: number | null;
  role: string | null;
  erp: string | null;
  timelineMonths: number | null;
};

export function fitScore(input: FitInput): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const country = input.country?.trim().toLowerCase() ?? "";
  if (GCC.has(country)) {
    score += 25;
    reasons.push("GCC entity");
  } else if (country) {
    reasons.push("Outside the GCC: route to a person, don't qualify");
  } else {
    reasons.push("Country unknown");
  }

  const smallOk = input.product === "ASANA" || input.product === "LARK";
  const floor = smallOk ? 50 : 200;
  if (input.headcount === null) {
    reasons.push("Headcount unknown");
  } else if (input.headcount >= floor) {
    score += input.headcount >= 200 && input.headcount <= 5000 ? 25 : 20;
    reasons.push(`${input.headcount} staff (floor ${floor})`);
  } else {
    reasons.push(`${input.headcount} staff, under the ${floor} floor`);
  }

  if (input.product === "CLEARTAX") {
    if (input.erp && KNOWN_ERP.test(input.erp)) {
      score += 20;
      reasons.push(`E-invoicing on ${input.erp}`);
    } else {
      score += 5;
      reasons.push("ClearTax without a named ERP yet");
    }
  } else if (input.product) {
    score += 15;
    reasons.push("Product fit signal");
  } else {
    reasons.push("No product named");
  }

  if (input.role && BUYER_ROLE.test(input.role)) {
    score += 15;
    reasons.push(`Buyer role: ${input.role}`);
  } else {
    reasons.push("Ask who owns the decision");
  }

  if (input.timelineMonths !== null && input.timelineMonths <= 6) {
    score += 15;
    reasons.push(`Decision within ${input.timelineMonths} months`);
  } else if (input.timelineMonths !== null) {
    reasons.push(`Decision in ${input.timelineMonths} months: nurture`);
  } else {
    reasons.push("Timing unknown");
  }

  return { score: Math.min(score, 100), reasons };
}
