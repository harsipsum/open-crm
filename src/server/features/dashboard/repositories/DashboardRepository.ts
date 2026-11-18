import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import { dealAccessCondition } from "@/server/features/access/access";
import { activity, company, deal, user } from "@/db/schema";
import { alias } from "drizzle-orm/sqlite-core";
import { countedIn } from "@/server/features/currency/repositories/DealConversionRepository";
import { OPEN_DEAL_STAGES } from "@/shared/deal-stages";

// The deal figures behind Home. Money only ever adds up base amounts counted
// in the reporting currency (DealConversionRepository's countedIn); counts
// take every deal. Archived deals stay out of every figure, as they stay out
// of every list. Days compare as text: a date-only bound ("2026-10-01")
// orders before every timestamp of that day.

/** Whose deals: the organization's live ones, or one owner's of them. */
export type DealScope = { organizationId: string; ownerId: string | null };

export function dealsInScope(scope: DealScope): SQL {
  return (
    and(
      eq(deal.organizationId, scope.organizationId),
      dealAccessCondition(),
      isNull(deal.archivedAt),
      scope.ownerId ? eq(deal.ownerId, scope.ownerId) : undefined,
    ) ?? sql`false`
  );
}

/** Open deals by stage: how many, and what those counted in `base` add up to. */
async function openByStage(scope: DealScope, base: string) {
  return db
    .select({
      stage: deal.stage,
      deals: count(),
      value:
        sql<number>`coalesce(sum(case when ${countedIn(base)} then ${deal.baseAmount} end), 0)`.mapWith(
          Number,
        ),
    })
    .from(deal)
    .where(and(dealsInScope(scope), inArray(deal.stage, OPEN_DEAL_STAGES)))
    .groupBy(deal.stage);
}

/** Deals created or closed on or after `since`: the trend and the rates. */
async function createdOrClosedSince(scope: DealScope, since: string) {
  return db
    .select({
      stage: deal.stage,
      baseAmount: deal.baseAmount,
      baseCurrency: deal.baseCurrency,
      createdAt: deal.createdAt,
      closedAt: deal.closedAt,
    })
    .from(deal)
    .where(
      and(
        dealsInScope(scope),
        or(gte(deal.createdAt, since), gte(deal.closedAt, since)),
      ),
    );
}

/** Open deals counted in `base` expected to close on a day in [from, to). */
async function closingBetween(
  scope: DealScope,
  base: string,
  from: string,
  to: string,
) {
  const [row] = await db
    .select({
      deals: count(),
      value: sql<number>`coalesce(sum(${deal.baseAmount}), 0)`.mapWith(Number),
    })
    .from(deal)
    .where(
      and(
        dealsInScope(scope),
        inArray(deal.stage, OPEN_DEAL_STAGES),
        gte(deal.expectedCloseDate, from),
        lt(deal.expectedCloseDate, to),
        countedIn(base),
      ),
    );
  return row ?? { deals: 0, value: 0 };
}

/**
 * The biggest open deals by their value in `base`, soonest close breaking
 * ties. A deal not counted in `base` has no value here and comes last, so a
 * stale figure never takes a place.
 */
async function biggestOpen(scope: DealScope, base: string, limit: number) {
  const value = sql<
    number | null
  >`case when ${countedIn(base)} then ${deal.baseAmount} end`;
  const rows = await db
    .select({
      id: deal.id,
      name: deal.name,
      stage: deal.stage,
      amount: deal.amount,
      currency: deal.currency,
      baseAmount: value,
      expectedCloseDate: deal.expectedCloseDate,
      stageChangedAt: deal.stageChangedAt,
      followUpAt: sql<
        string | null
      >`(select min(${activity.dueAt}) from ${activity}
        where ${activity.organizationId} = ${deal.organizationId}
          and ${activity.dealId} = ${deal.id}
          and ${activity.type} = 'TASK'
          and ${activity.completedAt} is null)`,
      companyId: company.id,
      companyName: company.name,
      iconUrl: company.iconUrl,
      iconDarkUrl: company.iconDarkUrl,
      iconTone: company.iconTone,
      ownerId: user.id,
      ownerName: user.name,
      ownerEmail: user.email,
      ownerImage: user.image,
    })
    .from(deal)
    .innerJoin(
      company,
      and(
        eq(company.id, deal.companyId),
        eq(company.organizationId, deal.organizationId),
      ),
    )
    .innerJoin(user, eq(user.id, deal.ownerId))
    .where(and(dealsInScope(scope), inArray(deal.stage, OPEN_DEAL_STAGES)))
    .orderBy(
      sql`(${value} is null)`,
      desc(value),
      sql`(${deal.expectedCloseDate} is null)`,
      asc(deal.expectedCloseDate),
      asc(deal.id),
    )
    .limit(limit);
  return rows.map(
    ({
      companyId,
      companyName,
      iconUrl,
      iconDarkUrl,
      iconTone,
      ownerId,
      ownerName,
      ownerEmail,
      ownerImage,
      ...row
    }) => ({
      ...row,
      company: {
        id: companyId,
        name: companyName,
        iconUrl,
        iconDarkUrl,
        iconTone,
      },
      owner: {
        id: ownerId,
        name: ownerName,
        email: ownerEmail,
        image: ownerImage,
      },
    }),
  );
}

/**
 * Renewals coming up: won deals whose first anniversary falls in [from, to),
 * where the company has no live deal opened since the win (the renewal is not
 * in the pipeline yet). Soonest first, with how many there are in all.
 */
async function renewalsDue(
  scope: DealScope,
  window: { from: string; to: string },
  limit: number,
) {
  const later = alias(deal, "later_deal");
  const yearAgo = (day: string) => sql`date(${day}, '-1 year')`;
  const where = and(
    dealsInScope(scope),
    eq(deal.stage, "CLOSED_WON"),
    gte(deal.closedAt, yearAgo(window.from)),
    lt(deal.closedAt, yearAgo(window.to)),
    notExists(
      db
        .select({ id: later.id })
        .from(later)
        .where(
          and(
            eq(later.organizationId, deal.organizationId),
            eq(later.companyId, deal.companyId),
            ne(later.id, deal.id),
            isNull(later.archivedAt),
            gt(later.createdAt, deal.closedAt),
          ),
        ),
    ),
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: deal.id,
        name: deal.name,
        amount: deal.amount,
        currency: deal.currency,
        closedAt: deal.closedAt,
        renewsOn: sql<string>`date(${deal.closedAt}, '+1 year')`,
        companyId: company.id,
        companyName: company.name,
        iconUrl: company.iconUrl,
        iconDarkUrl: company.iconDarkUrl,
        iconTone: company.iconTone,
        ownerName: user.name,
      })
      .from(deal)
      .innerJoin(
        company,
        and(
          eq(company.id, deal.companyId),
          eq(company.organizationId, deal.organizationId),
        ),
      )
      .leftJoin(user, eq(user.id, deal.ownerId))
      .where(where)
      .orderBy(asc(deal.closedAt), asc(deal.id))
      .limit(limit),
    db.select({ count: count() }).from(deal).where(where),
  ]);
  return {
    count: total?.count ?? 0,
    deals: rows.map(
      ({ companyId, companyName, iconUrl, iconDarkUrl, iconTone, ...row }) => ({
        ...row,
        company: {
          id: companyId,
          name: companyName,
          iconUrl,
          iconDarkUrl,
          iconTone,
        },
      }),
    ),
  };
}

/** A live company to start a deal with, newest first. */
async function firstCompany(organizationId: string) {
  const [row] = await db
    .select({ id: company.id, name: company.name })
    .from(company)
    .where(
      and(
        eq(company.organizationId, organizationId),
        isNull(company.archivedAt),
      ),
    )
    .orderBy(desc(company.createdAt), desc(company.id))
    .limit(1);
  return row ?? null;
}

/** Whether this scope has a live deal, including older closed deals. */
async function hasDeals(scope: DealScope): Promise<boolean> {
  const [row] = await db
    .select({ id: deal.id })
    .from(deal)
    .where(dealsInScope(scope))
    .limit(1);
  return Boolean(row);
}

/** The owner filter is useful only once live deals have different owners. */
async function multipleOwners(organizationId: string): Promise<boolean> {
  const owners = await db
    .selectDistinct({ ownerId: deal.ownerId })
    .from(deal)
    .where(dealsInScope({ organizationId, ownerId: null }))
    .limit(2);
  return owners.length > 1;
}

export const DashboardRepository = {
  firstCompany,
  hasDeals,
  multipleOwners,
  openByStage,
  createdOrClosedSince,
  closingBetween,
  biggestOpen,
  renewalsDue,
};
