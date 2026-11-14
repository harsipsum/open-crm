import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { activity, conversionEvent, dealResearch, sdrTimer } from "@/db/schema";
import type {
  ConversionEventName,
  ConversionPlatform,
  ConversionStatus,
  ResearchKind,
  ResearchStatus,
  VisApp,
} from "@/shared/vis";

// VisCRM's work on a deal: research requests, the SDR's first-call timer and
// the offline conversions. Every read and write takes the organization and
// filters by it (AGENTS.md, Tenancy).
// --- Research ----------------------------------------------------------------

async function research(organizationId: string, dealId: string) {
  return db
    .select()
    .from(dealResearch)
    .where(
      and(
        eq(dealResearch.organizationId, organizationId),
        eq(dealResearch.dealId, dealId),
      ),
    )
    .orderBy(asc(dealResearch.requestedAt));
}

/** Opens a research request; false when this kind is already on the deal. */
async function requestResearch(
  organizationId: string,
  dealId: string,
  kind: ResearchKind,
) {
  const inserted = await db
    .insert(dealResearch)
    .values({ id: crypto.randomUUID(), organizationId, dealId, kind })
    .onConflictDoNothing()
    .returning({ id: dealResearch.id });
  return inserted.length > 0;
}

async function completeResearch(
  organizationId: string,
  dealId: string,
  kind: ResearchKind,
  result: {
    status: Exclude<ResearchStatus, "PENDING">;
    provider: string;
    tool: string | null;
    costUsd: number;
    summary: string | null;
    data: unknown;
    error: string | null;
    filledByApp: VisApp | null;
  },
) {
  const updated = await db
    .update(dealResearch)
    .set({ ...result, completedAt: new Date().toISOString() })
    .where(
      and(
        eq(dealResearch.organizationId, organizationId),
        eq(dealResearch.dealId, dealId),
        eq(dealResearch.kind, kind),
        // Once: a finished request (and what it cost) is never rewritten.
        eq(dealResearch.status, "PENDING"),
      ),
    )
    .returning({ id: dealResearch.id });
  return updated.length > 0;
}

/** Says why a request still waits (no provider yet), leaving it PENDING. */
async function noteResearchWait(
  organizationId: string,
  dealId: string,
  kind: ResearchKind,
  error: string,
) {
  await db
    .update(dealResearch)
    .set({ error })
    .where(
      and(
        eq(dealResearch.organizationId, organizationId),
        eq(dealResearch.dealId, dealId),
        eq(dealResearch.kind, kind),
        eq(dealResearch.status, "PENDING"),
      ),
    );
}

// --- SDR timers --------------------------------------------------------------

async function insertTimer(values: typeof sdrTimer.$inferInsert) {
  await db.insert(sdrTimer).values(values).onConflictDoNothing();
}

async function timer(organizationId: string, dealId: string) {
  const [found] = await db
    .select({
      id: sdrTimer.id,
      taskActivityId: sdrTimer.taskActivityId,
      ownerId: sdrTimer.ownerId,
      dueAt: sdrTimer.dueAt,
      escalateAt: sdrTimer.escalateAt,
      status: sdrTimer.status,
      doneAt: sdrTimer.doneAt,
      escalatedAt: sdrTimer.escalatedAt,
      escalatedToId: sdrTimer.escalatedToId,
      taskCompletedAt: activity.completedAt,
    })
    .from(sdrTimer)
    .leftJoin(activity, eq(activity.id, sdrTimer.taskActivityId))
    .where(
      and(
        eq(sdrTimer.organizationId, organizationId),
        eq(sdrTimer.dealId, dealId),
      ),
    )
    .limit(1);
  return found ?? null;
}

/** Open timers whose task the SDR has ticked off: they are done. */
async function closeCompletedTimers(organizationId: string) {
  const done = await db
    .select({ id: sdrTimer.id, completedAt: activity.completedAt })
    .from(sdrTimer)
    .innerJoin(activity, eq(activity.id, sdrTimer.taskActivityId))
    .where(
      and(
        eq(sdrTimer.organizationId, organizationId),
        inArray(sdrTimer.status, ["OPEN", "ESCALATED"]),
        sql`${activity.completedAt} is not null`,
      ),
    );
  for (const row of done) {
    await db
      .update(sdrTimer)
      .set({ status: "DONE", doneAt: row.completedAt })
      .where(
        and(
          eq(sdrTimer.organizationId, organizationId),
          eq(sdrTimer.id, row.id),
        ),
      );
  }
  return done.length;
}

/** Open timers past their escalation time, oldest first. */
async function timersToEscalate(organizationId: string, now: string) {
  return db
    .select({
      id: sdrTimer.id,
      dealId: sdrTimer.dealId,
      ownerId: sdrTimer.ownerId,
      dueAt: sdrTimer.dueAt,
    })
    .from(sdrTimer)
    .where(
      and(
        eq(sdrTimer.organizationId, organizationId),
        eq(sdrTimer.status, "OPEN"),
        lte(sdrTimer.escalateAt, now),
      ),
    )
    .orderBy(asc(sdrTimer.escalateAt))
    .limit(50);
}

/** Marks a timer escalated, once: false when someone else did first. */
async function markEscalated(
  organizationId: string,
  id: string,
  escalatedToId: string | null,
  at: string,
) {
  const moved = await db
    .update(sdrTimer)
    .set({ status: "ESCALATED", escalatedAt: at, escalatedToId })
    .where(
      and(
        eq(sdrTimer.organizationId, organizationId),
        eq(sdrTimer.id, id),
        eq(sdrTimer.status, "OPEN"),
      ),
    )
    .returning({ id: sdrTimer.id });
  return moved.length > 0;
}

// --- Offline conversions -----------------------------------------------------

async function insertConversion(values: {
  organizationId: string;
  dealId: string;
  platform: ConversionPlatform;
  event: ConversionEventName;
  stageName: string;
  value: number | null;
  currency: string | null;
  clickId: string | null;
  status: ConversionStatus;
  payload: unknown;
  response: string | null;
}) {
  const inserted = await db
    .insert(conversionEvent)
    .values({ id: crypto.randomUUID(), ...values })
    .onConflictDoNothing()
    .returning({ id: conversionEvent.id });
  return inserted.length > 0;
}

async function conversions(organizationId: string, dealId: string) {
  return db
    .select()
    .from(conversionEvent)
    .where(
      and(
        eq(conversionEvent.organizationId, organizationId),
        eq(conversionEvent.dealId, dealId),
      ),
    )
    .orderBy(asc(conversionEvent.createdAt));
}

async function conversionKeys(organizationId: string, dealId: string) {
  const rows = await db
    .select({
      platform: conversionEvent.platform,
      event: conversionEvent.event,
    })
    .from(conversionEvent)
    .where(
      and(
        eq(conversionEvent.organizationId, organizationId),
        eq(conversionEvent.dealId, dealId),
      ),
    );
  return new Set(rows.map((row) => `${row.platform}:${row.event}`));
}

export const VisWorkRepository = {
  research,
  requestResearch,
  completeResearch,
  noteResearchWait,
  insertTimer,
  timer,
  closeCompletedTimers,
  timersToEscalate,
  markEscalated,
  insertConversion,
  conversions,
  conversionKeys,
};
