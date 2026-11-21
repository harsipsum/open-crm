import {
  type AnyColumn,
  and,
  count,
  eq,
  exists,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { db } from "@/db";
import { activity, contact, crmRole, deal } from "@/db/schema";
import { runBatch } from "@/db/runBatch";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { loadTeam } from "@/server/features/access/access";
import { UserFacingError } from "@/server/lib/errors";
import type { CrmRole } from "@/shared/crm-roles";

// Settings → Members: each member's CRM role, manager and status, and the
// leaver handover. The gateway owns who is a member; this owns what they see.

interface TeamRow {
  userId: string;
  name: string;
  email: string;
  role: CrmRole;
  /** The gateway made them owner or admin: always a CRM admin. */
  fixedAdmin: boolean;
  managerId: string | null;
  leftAt: string | null;
}

async function getTeam(organizationId: string): Promise<TeamRow[]> {
  const [members, team] = await Promise.all([
    AuthRepository.listPeople(organizationId),
    loadTeam(organizationId),
  ]);
  return members.map((m) => {
    const row = team.find((t) => t.userId === m.userId);
    const fixedAdmin = /(^|,)\s*(owner|admin)\s*(,|$)/.test(m.role);
    return {
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: row?.role ?? "seller",
      fixedAdmin,
      managerId: row?.managerId ?? null,
      leftAt: row?.leftAt ?? null,
    };
  });
}

async function memberOf(organizationId: string, userId: string) {
  const team = await getTeam(organizationId);
  const row = team.find((t) => t.userId === userId);
  if (!row)
    throw new UserFacingError(
      "NOT_FOUND",
      "That member isn't in this workspace.",
    );
  return { team, row };
}

async function upsert(
  organizationId: string,
  actorId: string,
  userId: string,
  patch: Partial<{
    role: CrmRole;
    managerId: string | null;
    leftAt: string | null;
  }>,
) {
  const at = new Date().toISOString();
  await db
    .insert(crmRole)
    .values({
      organizationId,
      userId,
      ...patch,
      updatedById: actorId,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [crmRole.organizationId, crmRole.userId],
      set: { ...patch, updatedById: actorId, updatedAt: at },
    });
}

async function setMemberRole(
  organizationId: string,
  actorId: string,
  input: { userId: string; role: CrmRole; managerId: string | null },
) {
  const { team, row } = await memberOf(organizationId, input.userId);
  if (row.fixedAdmin && input.role !== "admin") {
    throw new UserFacingError(
      "VALIDATION_ERROR",
      "Star OS owners and admins are always CRM admins. Change their role on Star OS.",
    );
  }
  if (input.managerId) {
    const manager = team.find((t) => t.userId === input.managerId);
    if (
      !manager ||
      manager.userId === input.userId ||
      manager.role === "seller"
    ) {
      throw new UserFacingError(
        "VALIDATION_ERROR",
        "Pick a manager or admin as their manager.",
      );
    }
  }
  await upsert(organizationId, actorId, input.userId, {
    role: input.role,
    managerId: input.managerId,
  });
  return getTeam(organizationId);
}

/**
 * Marks a member as left (their records fall into the shared pool at once)
 * or back. With `handTo`, their open deals and live contacts go to that
 * member in the same step. Returns how many records moved.
 */
async function setMemberLeft(
  organizationId: string,
  actorId: string,
  input: { userId: string; left: boolean; handTo: string | null },
) {
  const { team, row } = await memberOf(organizationId, input.userId);
  if (input.left && input.userId === actorId) {
    throw new UserFacingError(
      "VALIDATION_ERROR",
      "Another admin marks you as left.",
    );
  }
  if (input.left && row.fixedAdmin) {
    throw new UserFacingError(
      "VALIDATION_ERROR",
      "Remove a Star OS owner or admin on Star OS first.",
    );
  }
  const at = new Date().toISOString();
  const leftAt = input.left ? (row.leftAt ?? at) : null;
  const mark = (tx: typeof db) =>
    tx
      .insert(crmRole)
      .values({
        organizationId,
        userId: input.userId,
        leftAt,
        updatedById: actorId,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [crmRole.organizationId, crmRole.userId],
        set: { leftAt, updatedById: actorId, updatedAt: at },
      });
  if (!input.left || !input.handTo) {
    await runBatch((tx) => [mark(tx)]);
    return {
      team: await getTeam(organizationId),
      moved: { deals: 0, contacts: 0, tasks: 0 },
    };
  }
  const heir = team.find((t) => t.userId === input.handTo);
  if (!heir || heir.leftAt || heir.userId === input.userId) {
    throw new UserFacingError(
      "VALIDATION_ERROR",
      "Hand their records to a working member.",
    );
  }
  const openDeals = and(
    eq(deal.organizationId, organizationId),
    eq(deal.ownerId, input.userId),
    isNull(deal.archivedAt),
    isNull(deal.closedAt),
  );
  const liveContacts = and(
    eq(contact.organizationId, organizationId),
    eq(contact.ownerId, input.userId),
    isNull(contact.archivedAt),
  );
  // Their open follow-ups go with the book, so none waits on someone gone.
  // A task on a record another working member owns stays a leaver's task:
  // the heir can't see that record, and its owner can complete it.
  const others = team
    .filter((t) => !t.leftAt && t.userId !== input.userId)
    .map((t) => t.userId)
    .filter((id) => id !== heir.userId);
  const heirSees = (table: typeof deal | typeof contact, id: AnyColumn) =>
    or(
      isNull(id),
      exists(
        db
          .select({ one: table.id })
          .from(table)
          .where(
            and(
              eq(table.id, id),
              eq(table.organizationId, organizationId),
              or(isNull(table.ownerId), notInArray(table.ownerId, others)),
            ),
          ),
      ),
    );
  const openTasks = and(
    eq(activity.organizationId, organizationId),
    eq(activity.createdById, input.userId),
    eq(activity.type, "TASK"),
    isNull(activity.completedAt),
    heirSees(deal, activity.dealId),
    heirSees(contact, activity.contactId),
  );
  const [[deals], [contacts], [tasks]] = await Promise.all([
    db.select({ n: count() }).from(deal).where(openDeals),
    db.select({ n: count() }).from(contact).where(liveContacts),
    db.select({ n: count() }).from(activity).where(openTasks),
  ]);
  await runBatch((tx) => [
    tx
      .update(activity)
      .set({ createdById: heir.userId, updatedAt: at })
      .where(openTasks),
    tx
      .update(deal)
      .set({ ownerId: heir.userId, updatedAt: at })
      .where(openDeals),
    tx
      .update(contact)
      .set({ ownerId: heir.userId, updatedAt: at })
      .where(liveContacts),
    mark(tx),
  ]);
  const moved = {
    deals: deals?.n ?? 0,
    contacts: contacts?.n ?? 0,
    tasks: tasks?.n ?? 0,
  };
  return { team: await getTeam(organizationId), moved };
}

export const TeamService = { getTeam, setMemberRole, setMemberLeft };
