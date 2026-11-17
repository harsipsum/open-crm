import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization } from "./auth.schema";
import { isoNow, timestamp } from "./columns";
import { CRM_ROLES } from "../shared/crm-roles";

// Who sees what in the CRM, and what everyone changed. Both tables are
// additive: no existing table changes shape.

/**
 * A member's CRM role, team and status, set in Settings → Members. A member
 * with no row is a seller; the gateway's owners and admins are always admins
 * (src/server/features/access/access.ts). `managerId` puts a seller on a
 * manager's team. `leftAt` marks someone who left: everything they owned
 * falls into the shared pool at once.
 */
export const crmRole = sqliteTable(
  "crm_role",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role", { enum: CRM_ROLES }).notNull().default("seller"),
    managerId: text("manager_id"),
    leftAt: timestamp("left_at"),
    updatedById: text("updated_by_id"),
    updatedAt: timestamp("updated_at").notNull().default(isoNow),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

/**
 * One row per write: who (a member, or a sibling app by its key), which
 * server function or API route, which record, and the input's ids. Never the
 * input's free text.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorKind: text("actor_kind", { enum: ["member", "app"] }).notNull(),
    action: text("action").notNull(),
    recordId: text("record_id"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    outcome: text("outcome", { enum: ["ok", "error"] }).notNull(),
    at: timestamp("at").notNull().default(isoNow),
  },
  (table) => [
    index("audit_log_org_at_idx").on(table.organizationId, table.at),
    index("audit_log_org_record_idx").on(table.organizationId, table.recordId),
  ],
);
