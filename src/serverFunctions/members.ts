import { createServerFn } from "@tanstack/react-start";
import {
  AuthRepository,
  isImportPlaceholder,
} from "@/server/auth/repositories/AuthRepository";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

/**
 * The organization's members who have opened the CRM: owner pickers,
 * "assigned to" filters and Settings → Members. The gateway owns the real
 * list (invitations, roles, removals); this is its mirror. An import's
 * stand-in owner comes back marked `placeholder`: its records still show its
 * name, and no picker offers it.
 */
export const listMembers = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) =>
    (await AuthRepository.listMembers(context.organizationId)).map(
      (member) => ({ ...member, placeholder: isImportPlaceholder(member) }),
    ),
  );
