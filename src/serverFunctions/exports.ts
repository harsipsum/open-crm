import { createServerFn } from "@tanstack/react-start";
import { requireCrmAdmin } from "@/server/auth/org-gate";
import { recordAudit } from "@/server/features/access/AuditRepository";
import { ExportService } from "@/server/features/exports/services/ExportService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { exportPageSchema } from "@/types/schemas/exports";

// Settings → General's full export, for CRM admins: the browser asks for
// each dataset a page at a time and zips the CSVs itself. Each dataset's
// first page lands in the audit log.

export const getExportPage = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(exportPageSchema)
  .handler(async ({ data, context }) => {
    requireCrmAdmin(context);
    if (data.cursor === null) {
      await recordAudit({
        organizationId: context.organizationId,
        actorId: context.userId,
        actorKind: "member",
        action: `export-all:${data.dataset}`,
        recordId: null,
        detail: {},
        outcome: "ok",
      });
    }
    return ExportService.page(
      { organizationId: context.organizationId, crmRole: context.access.role },
      data.dataset,
      data.cursor,
    );
  });
