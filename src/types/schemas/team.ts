import { z } from "zod";
import { CRM_ROLES } from "@/shared/crm-roles";

export const setMemberRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(CRM_ROLES),
  managerId: z.string().min(1).nullable(),
});

export const setMemberLeftSchema = z.object({
  userId: z.string().min(1),
  left: z.boolean(),
  /** Hands the leaver's open deals and live contacts to this member. */
  handTo: z.string().min(1).nullable(),
});

export const listAuditSchema = z.object({
  before: z.string().nullable().default(null),
});
