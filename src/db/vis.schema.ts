import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth.schema";
import { activity, contact, deal } from "./crm.schema";
import { isoNow, timestamp } from "./columns";
import {
  ASANA_LICENSE_TYPES,
  type FreshworksProduct,
  CONSENT_STATES,
  CONVERSION_EVENTS,
  CONVERSION_PLATFORMS,
  CONVERSION_STATUSES,
  LEAD_SOURCES,
  ORDER_TYPES,
  PRODUCTS,
  RESEARCH_KINDS,
  RESEARCH_STATUSES,
  SDR_TIMER_STATUSES,
  VIS_APPS,
} from "../shared/vis";

// VisCRM's own tables (src/shared/vis.ts says what each value means). All of
// them hang off a deal or the organization, and all are additive: no CRM
// table changes shape.

const organizationId = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

const createdAt = () => timestamp("created_at").notNull().default(isoNow);

/**
 * A sibling app's write key. Only its SHA-256 is kept; the key itself is
 * shown once, when it's minted. One live key per app per organization.
 */
export const visAppKey = sqliteTable(
  "vis_app_key",
  {
    id: text("id").primaryKey(),
    organizationId: organizationId(),
    app: text("app", { enum: VIS_APPS }).notNull(),
    label: text("label").notNull(),
    keyHash: text("key_hash").notNull(),
    // The first characters, so a person can tell keys apart.
    keyPrefix: text("key_prefix").notNull(),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("vis_app_key_hash_uidx").on(table.keyHash),
    uniqueIndex("vis_app_key_organization_app_live_uidx")
      .on(table.organizationId, table.app)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * How a deal's lead first reached the business, and what it said when it
 * did: set by the system when the lead is created, never typed by a person.
 */
export const dealAttribution = sqliteTable(
  "deal_attribution",
  {
    dealId: text("deal_id")
      .primaryKey()
      .references(() => deal.id, { onDelete: "cascade" }),
    organizationId: organizationId(),
    contactId: text("contact_id").references(() => contact.id, {
      onDelete: "set null",
    }),
    source: text("source", { enum: LEAD_SOURCES }).notNull(),
    campaign: text("campaign"),
    creativeId: text("creative_id"),
    firstTouchAt: timestamp("first_touch_at").notNull(),
    landingUrl: text("landing_url"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    gclid: text("gclid"),
    fbclid: text("fbclid"),
    ctwaClid: text("ctwa_clid"),
    liFatId: text("li_fat_id"),
    consent: text("consent", { enum: CONSENT_STATES })
      .notNull()
      .default("UNKNOWN"),
    consentAt: timestamp("consent_at"),
    product: text("product", { enum: PRODUCTS }),
    orderType: text("order_type", { enum: ORDER_TYPES })
      .notNull()
      .default("NEW"),
    // What the lead told the qualifier, which the fit score reads.
    country: text("country"),
    headcount: integer("headcount"),
    role: text("role"),
    erp: text("erp"),
    timelineMonths: integer("timeline_months"),
    users: integer("users"),
    fitScore: integer("fit_score").notNull(),
    fitReasons: text("fit_reasons", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    createdByApp: text("created_by_app", { enum: VIS_APPS }),
    createdAt: createdAt(),
  },
  (table) => [
    index("deal_attribution_organization_source_idx").on(
      table.organizationId,
      table.source,
    ),
  ],
);

/**
 * Research on a deal: the company at intake, the person and the account
 * brief once it's qualified. Each kind once per deal, with what it cost.
 */
export const dealResearch = sqliteTable(
  "deal_research",
  {
    id: text("id").primaryKey(),
    organizationId: organizationId(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deal.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RESEARCH_KINDS }).notNull(),
    status: text("status", { enum: RESEARCH_STATUSES })
      .notNull()
      .default("PENDING"),
    provider: text("provider"),
    tool: text("tool"),
    costUsd: real("cost_usd").notNull().default(0),
    summary: text("summary"),
    data: text("data", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    // A sibling app that filled it (the relay), else the CRM itself.
    filledByApp: text("filled_by_app", { enum: VIS_APPS }),
    requestedAt: timestamp("requested_at").notNull().default(isoNow),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    uniqueIndex("deal_research_deal_kind_uidx").on(table.dealId, table.kind),
    index("deal_research_organization_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

/**
 * The SDR's first-call promise on a deal: the CRM task the SDR sees, when
 * the call is due, and when it escalates if nobody has made it.
 */
export const sdrTimer = sqliteTable(
  "sdr_timer",
  {
    id: text("id").primaryKey(),
    organizationId: organizationId(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deal.id, { onDelete: "cascade" }),
    taskActivityId: text("task_activity_id").references(() => activity.id, {
      onDelete: "set null",
    }),
    ownerId: text("owner_id").references(() => user.id, {
      onDelete: "set null",
    }),
    dueAt: timestamp("due_at").notNull(),
    escalateAt: timestamp("escalate_at").notNull(),
    status: text("status", { enum: SDR_TIMER_STATUSES })
      .notNull()
      .default("OPEN"),
    doneAt: timestamp("done_at"),
    escalatedAt: timestamp("escalated_at"),
    escalatedToId: text("escalated_to_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sdr_timer_deal_uidx").on(table.dealId),
    index("sdr_timer_organization_status_escalate_idx").on(
      table.organizationId,
      table.status,
      table.escalateAt,
    ),
  ],
);

/**
 * One offline conversion a deal earned on one ad platform: the event as it
 * was (or would be) sent, and what the platform said. Each event once per
 * deal per platform.
 */
export const conversionEvent = sqliteTable(
  "conversion_event",
  {
    id: text("id").primaryKey(),
    organizationId: organizationId(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deal.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: CONVERSION_PLATFORMS }).notNull(),
    event: text("event", { enum: CONVERSION_EVENTS }).notNull(),
    stageName: text("stage_name").notNull(),
    value: real("value"),
    currency: text("currency"),
    clickId: text("click_id"),
    status: text("status", { enum: CONVERSION_STATUSES }).notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    response: text("response"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversion_event_deal_platform_event_uidx").on(
      table.dealId,
      table.platform,
      table.event,
    ),
  ],
);

/**
 * What was sold, as the Asana intake project asks for it: set from the
 * accepted proposal (VisProposals) before the deal is won.
 */
export const dealOrder = sqliteTable("deal_order", {
  dealId: text("deal_id")
    .primaryKey()
    .references(() => deal.id, { onDelete: "cascade" }),
  organizationId: organizationId(),
  licenseRevenue: real("license_revenue"),
  implementationValue: real("implementation_value"),
  implementationRequired: integer("implementation_required", {
    mode: "boolean",
  }),
  asanaLicenseType: text("asana_license_type", {
    enum: ASANA_LICENSE_TYPES,
  }),
  users: integer("users"),
  freshworksProducts: text("freshworks_products", { mode: "json" }).$type<
    FreshworksProduct[]
  >(),
  updatedAt: timestamp("updated_at").notNull().default(isoNow),
});

/** The Asana task a won deal was handed off as. */
export const asanaHandoff = sqliteTable("asana_handoff", {
  dealId: text("deal_id")
    .primaryKey()
    .references(() => deal.id, { onDelete: "cascade" }),
  organizationId: organizationId(),
  projectGid: text("project_gid").notNull(),
  taskGid: text("task_gid"),
  taskUrl: text("task_url"),
  error: text("error"),
  createdAt: createdAt(),
});
