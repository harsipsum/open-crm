import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requireExport } from "@/server/auth/org-gate";
import type { Access } from "@/server/features/access/access";

// The audit log: one row per write. Writing it never fails the write it
// records (the write has already happened); a failure is logged instead.

interface AuditEntry {
  organizationId: string;
  actorId: string | null;
  actorKind: "member" | "app";
  action: string;
  recordId: string | null;
  detail: Record<string, unknown>;
  outcome: "ok" | "error";
}

// Input keys worth keeping: ids and the choices a write makes, never free text.
const KEPT_KEYS = [
  "id",
  "dealId",
  "contactId",
  "companyId",
  "ownerId",
  "userId",
  "managerId",
  "stage",
  "role",
  "dataset",
  "pipelineId",
  "listId",
  "type",
  "completed",
  "left",
] as const;

/** The ids and choices in a write's input, as the log keeps them. */
export function auditDetail(data: unknown): {
  recordId: string | null;
  detail: Record<string, unknown>;
} {
  if (typeof data !== "object" || data === null) {
    return { recordId: null, detail: {} };
  }
  const input = data as Record<string, unknown>;
  const detail: Record<string, unknown> = {};
  for (const key of KEPT_KEYS) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      detail[key] = typeof value === "string" ? value.slice(0, 120) : value;
    }
  }
  if (Array.isArray(input.ids)) {
    const ids = input.ids.filter((id): id is string => typeof id === "string");
    detail.count = ids.length;
    detail.ids = ids.slice(0, 50);
  }
  const recordId =
    [input.id, input.dealId, input.contactId, input.companyId].find(
      (value): value is string => typeof value === "string",
    ) ?? null;
  return { recordId, detail };
}

export async function recordAudit(entry: AuditEntry) {
  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      ...entry,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[audit] write failed", {
      organizationId: entry.organizationId,
      action: entry.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The latest audit rows of the organization, newest first. */
export async function listAudit(
  organizationId: string,
  before: string | null,
  limit = 100,
) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.organizationId, organizationId),
        before ? lt(auditLog.at, before) : undefined,
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(limit);
}

/**
 * Checks the caller may export, and logs the export once, on its first page.
 */
export async function auditExport(
  context: { organizationId: string; userId: string; access: Access },
  dataset: string,
  page: number,
) {
  requireExport(context);
  if (page !== 1) return;
  await recordAudit({
    organizationId: context.organizationId,
    actorId: context.userId,
    actorKind: "member",
    action: `export:${dataset}`,
    recordId: null,
    detail: {},
    outcome: "ok",
  });
}
