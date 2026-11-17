import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { asanaHandoff, asanaWonQueue } from "@/db/schema";

async function eligible(organizationId: string, dealId: string) {
  const rows = await db
    .select({ id: asanaWonQueue.dealId })
    .from(asanaWonQueue)
    .where(
      and(
        eq(asanaWonQueue.organizationId, organizationId),
        eq(asanaWonQueue.dealId, dealId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
async function pending(organizationId: string) {
  return db
    .select({ dealId: asanaWonQueue.dealId })
    .from(asanaWonQueue)
    .leftJoin(
      asanaHandoff,
      and(
        eq(asanaHandoff.organizationId, organizationId),
        eq(asanaHandoff.dealId, asanaWonQueue.dealId),
      ),
    )
    .where(
      and(
        eq(asanaWonQueue.organizationId, organizationId),
        isNull(asanaHandoff.dealId),
      ),
    )
    .orderBy(asanaWonQueue.createdAt)
    .limit(10);
}
async function today(organizationId: string) {
  const start = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(asanaHandoff)
    .where(
      and(
        eq(asanaHandoff.organizationId, organizationId),
        gte(asanaHandoff.createdAt, start),
      ),
    );
  return row?.count ?? 0;
}
export const AsanaQueueRepository = { eligible, pending, today };
