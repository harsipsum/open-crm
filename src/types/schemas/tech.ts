import { z } from "zod";
import { TECH_CATEGORIES } from "@/shared/tech";

export const companyTechListSchema = z.object({
  companyId: z.string().min(1),
});

/**
 * A line a member adds: from what they know (team, verified), or from a
 * public page (unverified, with its URL).
 */
export const addCompanyTechSchema = z
  .object({
    companyId: z.string().min(1),
    product: z.string().trim().min(1).max(120),
    category: z.enum(TECH_CATEGORIES).optional(),
    origin: z.enum(["team", "public"]).default("team"),
    source: z.string().trim().url().max(2000).optional(),
  })
  .refine((input) => input.origin !== "public" || input.source, {
    message: "A public line needs the URL it came from.",
    path: ["source"],
  });
export type AddCompanyTechInput = z.output<typeof addCompanyTechSchema>;

export const companyTechIdSchema = z.object({ id: z.string().min(1) });
