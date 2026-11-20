import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { TECH_CATEGORIES, TECH_ORIGINS } from "../shared/tech";
import { organization, user } from "./auth.schema";
import { isoNow, timestamp } from "./columns";
import { company } from "./crm.schema";

/**
 * One system a company runs (its ERP, CRM, accounting, ...), with where we
 * learned it. Custom fields hold one value per company with no source, so the
 * stack is its own table: each line keeps its origin, its source, when it was
 * seen, who entered it and who confirmed it. Lines are archived, never
 * deleted. One live line per product per company.
 */
export const companyTech = sqliteTable(
  "company_tech",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    companyId: text("company_id")
      .notNull()
      .references(() => company.id, { onDelete: "cascade" }),
    product: text("product").notNull(),
    // The product lowercased with its spaces collapsed, for the one-per-company rule.
    productKey: text("product_key").notNull(),
    category: text("category", { enum: TECH_CATEGORIES }),
    origin: text("origin", { enum: TECH_ORIGINS }).notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    // A public page's URL; for an email, an opaque reference to the message
    // (mailbox, date and message id), never its subject or text.
    source: text("source"),
    // The day the line was seen: the email's date, the page's read date.
    observedAt: timestamp("observed_at"),
    enteredById: text("entered_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    confirmedById: text("confirmed_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at"),
    archivedById: text("archived_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("company_tech_live_product_uidx")
      .on(table.organizationId, table.companyId, table.productKey)
      .where(sql`${table.archivedAt} is null`),
    index("company_tech_company_idx").on(table.companyId),
    index("company_tech_entered_by_idx").on(table.enteredById),
    index("company_tech_confirmed_by_idx").on(table.confirmedById),
    index("company_tech_archived_by_idx").on(table.archivedById),
  ],
);
