import { z } from "zod";
import { currencyCodeSchema } from "@/types/schemas/currency";
import {
  ASANA_LICENSE_TYPES,
  FRESHWORKS_PRODUCTS,
  CONSENT_STATES,
  LEAD_SOURCES,
  ORDER_TYPES,
  PRODUCTS,
  RESEARCH_KINDS,
  VIS_APPS,
} from "@/shared/vis";

const short = (max: number) => z.string().trim().min(1).max(max);
const instant = z.iso.datetime({ offset: true });

/** A new lead, as a sibling app (or a person through a tool) sends it. */
export const leadSchema = z
  .object({
    company: z.object({
      name: short(200),
      domain: short(255).optional(),
    }),
    person: z.object({
      firstName: short(100),
      lastName: short(100).optional(),
      email: z.email().max(320).optional(),
      phone: short(40).optional(),
      title: short(200).optional(),
      /** Which identifiers the channel proved (a WhatsApp sender's phone, an email confirmed by a code). Only these match an existing person. */
      verified: z
        .array(z.enum(["email", "phone"]))
        .max(2)
        .optional(),
    }),
    attribution: z.object({
      source: z.enum(LEAD_SOURCES),
      campaign: short(200).optional(),
      creativeId: short(200).optional(),
      firstTouchAt: instant.optional(),
      landingUrl: z.url().max(2000).optional(),
      utmSource: short(200).optional(),
      utmMedium: short(200).optional(),
      gclid: short(512).optional(),
      fbclid: short(512).optional(),
      ctwaClid: short(512).optional(),
      liFatId: short(512).optional(),
      consent: z.enum(CONSENT_STATES).optional(),
      consentAt: instant.optional(),
    }),
    product: z.enum(PRODUCTS).optional(),
    orderType: z.enum(ORDER_TYPES).optional(),
    qualifier: z
      .object({
        country: short(80).optional(),
        headcount: z.number().int().min(0).max(10_000_000).optional(),
        role: short(200).optional(),
        erp: short(120).optional(),
        timelineMonths: z.number().int().min(0).max(120).optional(),
        users: z.number().int().min(0).max(1_000_000).optional(),
      })
      .optional(),
    /** The app's own id for this submission; sent again, it returns the same deal. */
    externalRef: short(200).optional(),
    dealName: short(200).optional(),
    amount: z.number().min(0).max(999_999_999_999.99).optional(),
    currency: currencyCodeSchema.optional(),
    ownerEmail: z.email().optional(),
    note: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();
export type LeadInput = z.infer<typeof leadSchema>;

export const stageMoveSchema = z
  .object({
    dealId: z.string().min(1),
    stage: short(120),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const noteSchema = z
  .object({
    dealId: z.string().min(1),
    body: z.string().trim().min(1).max(20_000),
  })
  .strict();

/** Research a sibling app ran for the deal (the relay path). */
export const researchFillSchema = z
  .object({
    dealId: z.string().min(1),
    kind: z.enum(RESEARCH_KINDS),
    status: z.enum(["DONE", "NOT_FOUND", "FAILED"]),
    provider: short(80),
    tool: short(120).optional(),
    costUsd: z.number().min(0).max(100),
    summary: z.string().trim().max(5000).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z.string().trim().max(2000).optional(),
  })
  .strict();
export type ResearchFillInput = z.infer<typeof researchFillSchema>;

/** What was sold, from the accepted proposal; only what is given changes. */
export const orderSchema = z
  .object({
    dealId: z.string().min(1),
    licenseRevenue: z.number().min(0).max(999_999_999_999.99).optional(),
    implementationValue: z.number().min(0).max(999_999_999_999.99).optional(),
    implementationRequired: z.boolean().optional(),
    asanaLicenseType: z.enum(ASANA_LICENSE_TYPES).optional(),
    users: z.number().int().min(0).max(1_000_000).optional(),
    freshworksProducts: z.array(z.enum(FRESHWORKS_PRODUCTS)).max(3).optional(),
  })
  .strict();
export type OrderInput = z.infer<typeof orderSchema>;

export const consentSchema = z
  .object({ dealId: z.string().min(1), consent: z.enum(CONSENT_STATES) })
  .strict();

/** Find a person and their deals by email or phone. */
export const lookupSchema = z
  .object({ email: z.email().max(320).optional(), phone: short(40).optional() })
  .strict()
  .refine((query) => query.email || query.phone, {
    message: "Give an email or a phone.",
  });

export const appSchema = z.object({ app: z.enum(VIS_APPS) }).strict();
export const dealIdSchema = z.object({ dealId: z.string().min(1) }).strict();
