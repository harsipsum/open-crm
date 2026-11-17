import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organization } from "./auth.schema";
import { deal } from "./crm.schema";

// Lossless source properties and the migration ledger. These rows never grant
// access or enroll records in background automations.
export const hubspotObject = sqliteTable(
  "hubspot_object",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    portalId: text("portal_id").notNull(),
    objectType: text("object_type").notNull(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>().notNull(),
    importedAt: text("imported_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.portalId, t.objectType, t.sourceId],
    }),
    index("hubspot_target_idx").on(t.organizationId, t.targetId),
  ],
);

// Every direction and label survives independently of primary-company fields.
export const hubspotAssociation = sqliteTable(
  "hubspot_association",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    portalId: text("portal_id").notNull(),
    fromType: text("from_type").notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type").notNull(),
    toId: text("to_id").notNull(),
    typeId: text("type_id").notNull(),
    category: text("category").notNull(),
    label: text("label"),
  },
  (t) => [
    primaryKey({
      columns: [
        t.organizationId,
        t.portalId,
        t.fromType,
        t.fromId,
        t.toType,
        t.toId,
        t.category,
        t.typeId,
      ],
    }),
  ],
);

// Only a real stage transition inserts this row. The importer never does.
export const asanaWonQueue = sqliteTable("asana_won_queue", {
  dealId: text("deal_id")
    .primaryKey()
    .references(() => deal.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
});
