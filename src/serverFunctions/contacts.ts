import { createServerFn } from "@tanstack/react-start";
import {
  requireAssignable,
  requireOrgPermission,
} from "@/server/auth/org-gate";
import { auditExport } from "@/server/features/access/AuditRepository";
import { ContactService } from "@/server/features/contacts/services/ContactService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import {
  bulkContactCompanySchema,
  contactListSchema,
  createContactSchema,
  updateContactSchema,
} from "@/types/schemas/contacts";
import {
  bulkIdsSchema,
  bulkOwnerSchema,
  recordIdSchema,
} from "@/types/schemas/records";

// Members work the pipeline: they add, edit, archive and restore contacts.
// Deleting an archived contact forever is for owners and admins.

export const listContacts = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(contactListSchema)
  .handler(async ({ data, context }) => {
    if (data.forExport) await auditExport(context, "contacts", data.page);
    return ContactService.listContacts(context.organizationId, data);
  });

export const getContact = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(recordIdSchema)
  .handler(({ data, context }) =>
    ContactService.getContact(context.organizationId, data.id),
  );

export const createContact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(createContactSchema)
  .handler(({ data, context }) => {
    requireAssignable(context, data.ownerId);
    return ContactService.createContact(context.organizationId, data);
  });

export const updateContact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(updateContactSchema)
  .handler(({ data, context }) => {
    requireAssignable(context, data.ownerId);
    return ContactService.updateContact(context.organizationId, data);
  });

export const archiveContact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(recordIdSchema)
  .handler(({ data, context }) =>
    ContactService.archiveContact(context.organizationId, data.id),
  );

export const restoreContact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(recordIdSchema)
  .handler(({ data, context }) =>
    ContactService.restoreContact(context.organizationId, data.id),
  );

export const purgeContact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(recordIdSchema)
  .handler(({ data, context }) => {
    requireOrgPermission(context, { record: ["purge"] });
    return ContactService.purgeContact(context.organizationId, data.id);
  });

export const bulkAssignContactOwner = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(bulkOwnerSchema)
  .handler(({ data, context }) => {
    requireAssignable(context, data.ownerId);
    return ContactService.bulkAssignOwner(
      context.organizationId,
      data.ids,
      data.ownerId,
    );
  });

export const bulkSetContactCompany = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(bulkContactCompanySchema)
  .handler(({ data, context }) =>
    ContactService.bulkSetCompany(
      context.organizationId,
      data.ids,
      data.companyId,
    ),
  );

export const bulkArchiveContacts = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(bulkIdsSchema)
  .handler(({ data, context }) =>
    ContactService.bulkArchive(context.organizationId, data.ids),
  );

export const bulkRestoreContacts = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(bulkIdsSchema)
  .handler(({ data, context }) =>
    ContactService.bulkRestore(context.organizationId, data.ids),
  );

export const bulkPurgeContacts = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(bulkIdsSchema)
  .handler(({ data, context }) => {
    requireOrgPermission(context, { record: ["purge"] });
    return ContactService.bulkPurge(context.organizationId, data.ids);
  });
