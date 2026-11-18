import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  user,
  company,
  contact,
  deal,
  activity,
  member,
  hubspotObject,
  crmRole,
} from "@/db/schema";

// The gateway's people are stored in the `user` table, keyed by the gateway's
// `sub`, so every CRM table that references a person (owners, authors,
// deciders) resolves the same way. Only the email ever changes here.
//
// An email is one gateway account's at a time. The gateway deletes the
// account of a member it removes from their last organization, so inviting
// them again brings them back under a new id with the same email: the old
// row keeps the records it is on and gives the address up, in the batch
// that writes it onto the new one, so the unique email never locks them out.
function deriveUserName(email: string) {
  return email.split("@")[0] || "CRM";
}

export async function ensureUserRecord(userId: string, userEmail: string) {
  const existing = await db.query.user.findFirst({
    columns: { email: true },
    where: eq(user.id, userId),
  });
  if (existing?.email === userEmail) return userEmail;

  const imported = await db
    .select({ id: user.id, organizationId: hubspotObject.organizationId })
    .from(hubspotObject)
    .innerJoin(user, eq(user.id, hubspotObject.targetId))
    .where(
      and(
        eq(hubspotObject.objectType, "owners"),
        eq(user.email, userEmail),
        sql`${user.id} like 'hs:%:owners:%'`,
      ),
    );

  await runBatch((tx) => [
    tx
      .update(user)
      // An address nobody sends from, unique to the row giving it up.
      .set({ email: sql<string>`${user.id} || '@replaced.invalid'` })
      .where(and(eq(user.email, userEmail), ne(user.id, userId))),
    existing
      ? tx
          .update(user)
          .set({ email: userEmail, name: deriveUserName(userEmail) })
          .where(eq(user.id, userId))
      : // Concurrent first-load requests can all see "no row" and race to
        // insert the same row. Every unique index is an arbiter, so the
        // losers are no-ops on either one.
        tx
          .insert(user)
          .values({
            id: userId,
            name: deriveUserName(userEmail),
            email: userEmail,
            emailVerified: true,
          })
          .onConflictDoNothing(),
    ...imported.flatMap((owner) => [
      tx
        .update(company)
        .set({ ownerId: userId })
        .where(
          and(
            eq(company.organizationId, owner.organizationId),
            eq(company.ownerId, owner.id),
          ),
        ),
      tx
        .update(contact)
        .set({ ownerId: userId })
        .where(
          and(
            eq(contact.organizationId, owner.organizationId),
            eq(contact.ownerId, owner.id),
          ),
        ),
      tx
        .update(deal)
        .set({ ownerId: userId })
        .where(
          and(
            eq(deal.organizationId, owner.organizationId),
            eq(deal.ownerId, owner.id),
          ),
        ),
      tx
        .update(activity)
        .set({ createdById: userId })
        .where(
          and(
            eq(activity.organizationId, owner.organizationId),
            eq(activity.createdById, owner.id),
          ),
        ),
      tx
        .update(member)
        .set({ userId })
        .where(
          and(
            eq(member.organizationId, owner.organizationId),
            eq(member.userId, owner.id),
          ),
        ),
      // The placeholder's CRM role, team and rotation become theirs, unless
      // they already have their own row.
      tx
        .insert(crmRole)
        .select(
          tx
            .select({
              organizationId: crmRole.organizationId,
              userId: sql<string>`${userId}`.as("user_id"),
              role: crmRole.role,
              managerId: crmRole.managerId,
              leftAt: crmRole.leftAt,
              inRotation: crmRole.inRotation,
              updatedById: crmRole.updatedById,
              updatedAt: crmRole.updatedAt,
            })
            .from(crmRole)
            .where(
              and(
                eq(crmRole.organizationId, owner.organizationId),
                eq(crmRole.userId, owner.id),
              ),
            ),
        )
        .onConflictDoNothing(),
      tx
        .update(hubspotObject)
        .set({ targetId: userId })
        .where(
          and(
            eq(hubspotObject.objectType, "owners"),
            eq(hubspotObject.organizationId, owner.organizationId),
            eq(hubspotObject.targetId, owner.id),
          ),
        ),
    ]),
  ]);
  return userEmail;
}
