import type { EnsuredUserContext } from "@/middleware/ensure-user/types";
import type { Access } from "@/server/features/access/access";
import { AppError, UserFacingError } from "@/server/lib/errors";
import { canAssignOthers, canExport } from "@/shared/crm-roles";
import {
  hasOrgPermission,
  type OrgPermissionRequest,
} from "@/shared/org-permissions";

/** Throws FORBIDDEN unless the caller's gateway role grants `permissions`. */
export function requireOrgPermission(
  context: Pick<EnsuredUserContext, "role">,
  permissions: OrgPermissionRequest,
): void {
  if (!hasOrgPermission(context.role, permissions)) {
    throw new AppError("FORBIDDEN");
  }
}

/**
 * Throws FORBIDDEN unless the caller may give a record to `ownerId`: anyone
 * may take a record for themselves or drop it into the shared pool (null);
 * giving it to someone else is for managers and admins.
 */
export function requireAssignable(
  context: { userId: string; access: Access },
  ownerId: string | null | undefined,
): void {
  if (ownerId == null || ownerId === context.userId) return;
  if (!canAssignOthers(context.access.role)) {
    throw new UserFacingError(
      "FORBIDDEN",
      "Sellers own what they take. A manager or admin gives records to someone else.",
    );
  }
}

/** Throws FORBIDDEN unless the caller is a manager or admin. */
export function requireExport(context: { access: Access }): void {
  if (!canExport(context.access.role)) {
    throw new UserFacingError(
      "FORBIDDEN",
      "Exports are for managers and admins.",
    );
  }
}

/** Throws FORBIDDEN unless the caller is a CRM admin. */
export function requireCrmAdmin(context: { access: Access }): void {
  if (context.access.role !== "admin") throw new AppError("FORBIDDEN");
}
