import { z } from "zod";
import { crmTool } from "@/server/everyapp/crm-tool";
import { CompanyTechService } from "@/server/features/tech/services/CompanyTechService";
import { TECH_CATEGORIES, TECH_ORIGINS } from "@/shared/tech";
import { addCompanyTechSchema } from "@/types/schemas/tech";

// A company's tech stack as an AI client sees it: the systems the company
// runs, each with whether the team verified it and where it came from.

const lineOutput = z.object({
  id: z.string(),
  product: z.string(),
  category: z.enum(TECH_CATEGORIES).nullable(),
  origin: z.enum(TECH_ORIGINS),
  verified: z.boolean(),
  publicUrl: z.string().nullable(),
  observedAt: z.string().nullable(),
  enteredByName: z.string().nullable(),
  confirmedByName: z.string().nullable(),
  confirmedAt: z.string().nullable(),
});

const lineId = z.string().describe("A tech line's id, from list_company_tech.");

export const companyTechTools = {
  list_company_tech: crmTool({
    description:
      "A company's tech stack: the systems it runs (ERP, CRM, accounting, ITSM, collaboration, e-invoicing). Each line says whether the team verified it, and where it came from: entered by a member (team), read from the team's email (email), or a public page (public, with its URL).",
    risk: "read",
    input: z.object({ companyId: z.string() }).strict(),
    output: z.object({ lines: z.array(lineOutput) }),
    handler: async ({ companyId }, context) => ({
      lines: await CompanyTechService.list(context.organizationId, companyId),
    }),
  }),
  add_company_tech: crmTool({
    description:
      "Add a system a company runs. origin team (the default) is what the member knows from their own conversations, and is verified. origin public is from a public page, needs its URL as source, and stays unverified until a member confirms it. A product the company already lists is not added twice.",
    risk: "write",
    input: addCompanyTechSchema,
    output: lineOutput.extend({ created: z.boolean() }),
    handler: (input, context) =>
      CompanyTechService.add(context.organizationId, context.userId, input),
  }),
  confirm_company_tech: crmTool({
    description:
      "Mark an unverified tech line verified: the member confirms the company runs it.",
    risk: "write",
    input: z.object({ id: lineId }).strict(),
    output: lineOutput,
    handler: ({ id }, context) =>
      CompanyTechService.confirm(context.organizationId, context.userId, id),
  }),
  archive_company_tech: crmTool({
    description:
      "Archive a tech line the company no longer runs, or that was wrong. It leaves the stack but is kept.",
    risk: "write",
    input: z.object({ id: lineId }).strict(),
    output: z.object({
      id: z.string(),
      product: z.string(),
      companyId: z.string(),
    }),
    handler: ({ id }, context) =>
      CompanyTechService.archive(context.organizationId, context.userId, id),
  }),
};
