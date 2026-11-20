import { z } from "zod";
import { requireCrmAdmin } from "@/server/auth/org-gate";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { crmTool } from "@/server/everyapp/crm-tool";
import { currentAccess } from "@/server/features/access/access";
import { listAudit } from "@/server/features/access/AuditRepository";
import { TeamService } from "@/server/features/access/TeamService";
import { UserFacingError } from "@/server/lib/errors";
import { CRM_ROLES } from "@/shared/crm-roles";

// Settings > Members and Settings > Audit log, for an AI client: a member's
// CRM role, manager and leaver mark, and who changed what. CRM admins only,
// the same check the screens make (serverFunctions/team.ts). Handing a
// leaver's whole book to someone stays on the screen: it moves many records
// at once, like the bulk tools the gateway holds. The CRM is at the
// gateway's 100 tools an app, so the team's read is part of list_members.

const NOT_ADMIN = "Only a CRM admin can do that.";

/**
 * Throws FORBIDDEN unless the caller is a CRM admin: requireCrmAdmin, the
 * check the screens make, with a message that says which role it takes.
 */
function requireAdminCaller(): void {
  const access = currentAccess();
  if (access?.role === "admin") return requireCrmAdmin({ access });
  throw new UserFacingError("FORBIDDEN", NOT_ADMIN);
}

/** A member as list_members shows them to a CRM admin. */
export const crmMemberOutput = z.object({
  role: z
    .enum(CRM_ROLES)
    .describe(
      "admin sees every record, manager their team's, seller their own.",
    ),
  fixedAdmin: z
    .boolean()
    .describe(
      "A Star OS owner or admin: always a CRM admin, changed on Star OS.",
    ),
  managerId: z.string().nullable(),
  leftAt: z.string().nullable(),
});

/** Each member's CRM role by user id, for a CRM admin; null for anyone else. */
export async function crmTeamFor(
  organizationId: string,
): Promise<Map<string, z.infer<typeof crmMemberOutput>> | null> {
  if (currentAccess()?.role !== "admin") return null;
  const team = await TeamService.getTeam(organizationId);
  return new Map(
    team.map((row) => [
      row.userId,
      {
        role: row.role,
        fixedAdmin: row.fixedAdmin,
        managerId: row.managerId,
        leftAt: row.leftAt,
      },
    ]),
  );
}

const AUDIT_PAGE = 100;

export const teamTools = {
  update_member: crmTool({
    description:
      "Change a member's CRM role, their manager (a manager or admin, or null), or mark them as left (their records fall into the shared pool at once) or back. Only what is given changes. Star OS owners and admins stay CRM admins. Handing a leaver's deals and contacts to one person is done on the CRM's Members screen. CRM admins only; list_members shows each member's CRM role to them.",
    risk: "write",
    input: z
      .object({
        userId: z.string().min(1).describe("From list_members."),
        role: z.enum(CRM_ROLES).optional(),
        managerId: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Their manager's user id, or null for none."),
        left: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ userId: z.string() }).extend(crmMemberOutput.shape),
    handler: async ({ userId, role, managerId, left }, context) => {
      requireAdminCaller();
      const { organizationId } = context;
      if (role !== undefined || managerId !== undefined) {
        const current = (await TeamService.getTeam(organizationId)).find(
          (row) => row.userId === userId,
        );
        await TeamService.setMemberRole(organizationId, context.userId, {
          userId,
          role: role ?? current?.role ?? "seller",
          managerId:
            managerId === undefined ? (current?.managerId ?? null) : managerId,
        });
      }
      if (left !== undefined) {
        await TeamService.setMemberLeft(organizationId, context.userId, {
          userId,
          left,
          handTo: null,
        });
      }
      const row = (await TeamService.getTeam(organizationId)).find(
        (r) => r.userId === userId,
      );
      if (!row) {
        throw new UserFacingError(
          "NOT_FOUND",
          "That member isn't in this workspace.",
        );
      }
      return {
        userId,
        role: row.role,
        fixedAdmin: row.fixedAdmin,
        managerId: row.managerId,
        leftAt: row.leftAt,
      };
    },
  }),

  list_audit_log: crmTool({
    description:
      "The CRM audit log, newest first, 100 a page: who changed what, from a screen (the action is its name), a tool (tool:<name>) or the website intake. Pass the last row's `at` as `before` for the next page. CRM admins only.",
    risk: "read",
    input: z
      .object({
        before: z
          .string()
          .nullable()
          .default(null)
          .describe("An `at` from the previous page, or null for the newest."),
      })
      .strict(),
    output: z.object({
      rows: z.array(
        z.object({
          at: z.string(),
          actorEmail: z
            .string()
            .nullable()
            .describe("Null for an app or a former member."),
          actorKind: z.enum(["member", "app"]),
          action: z.string(),
          recordId: z.string().nullable(),
          outcome: z.enum(["ok", "error"]),
          detail: z
            .string()
            .describe("The ids and choices the write took, as JSON."),
        }),
      ),
      more: z.boolean(),
    }),
    handler: async ({ before }, context) => {
      requireAdminCaller();
      const [rows, members] = await Promise.all([
        listAudit(context.organizationId, before, AUDIT_PAGE),
        AuthRepository.listMembers(context.organizationId),
      ]);
      const emailOf = new Map(members.map((m) => [m.userId, m.email]));
      return {
        rows: rows.map((row) => ({
          at: row.at,
          actorEmail: row.actorId ? (emailOf.get(row.actorId) ?? null) : null,
          actorKind: row.actorKind,
          action: row.action,
          recordId: row.recordId,
          outcome: row.outcome,
          detail: JSON.stringify(row.detail ?? {}),
        })),
        more: rows.length === AUDIT_PAGE,
      };
    },
  }),
};
