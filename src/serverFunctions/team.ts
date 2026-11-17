import { createServerFn } from "@tanstack/react-start";
import { requireCrmAdmin } from "@/server/auth/org-gate";
import { listAudit } from "@/server/features/access/AuditRepository";
import { TeamService } from "@/server/features/access/TeamService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import {
  listAuditSchema,
  setMemberLeftSchema,
  setMemberRoleSchema,
} from "@/types/schemas/team";

/** Settings → Members: each member's CRM role, manager and status. */
export const getTeam = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    requireCrmAdmin(context);
    return TeamService.getTeam(context.organizationId);
  });

export const setMemberRole = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(setMemberRoleSchema)
  .handler(async ({ data, context }) => {
    requireCrmAdmin(context);
    return TeamService.setMemberRole(
      context.organizationId,
      context.userId,
      data,
    );
  });

/** The leaver handover: mark someone as left, optionally handing their book on. */
export const setMemberLeft = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(setMemberLeftSchema)
  .handler(async ({ data, context }) => {
    requireCrmAdmin(context);
    return TeamService.setMemberLeft(
      context.organizationId,
      context.userId,
      data,
    );
  });

/** The audit log, newest first, 100 at a time. */
export const getAuditLog = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(listAuditSchema)
  .handler(async ({ data, context }) => {
    requireCrmAdmin(context);
    const rows = await listAudit(context.organizationId, data.before);
    return rows.map((row) => ({
      ...row,
      detail: JSON.stringify(row.detail ?? {}),
    }));
  });
