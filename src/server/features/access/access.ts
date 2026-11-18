import { AsyncLocalStorage } from "node:async_hooks";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import {
  activity,
  contact,
  crmRole,
  deal,
  dealContact,
  member,
} from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import type { CrmRole } from "@/shared/crm-roles";

// Record scoping. Every server function a member calls runs inside their
// Access (src/serverFunctions/middleware.ts), and the deal and contact
// repositories narrow every read and write by it:
//
// - admins (the gateway's owners and admins, and members made admin in
//   Settings → Members) see everything;
// - managers see their own records and their team's;
// - sellers see their own;
// - everyone sees the shared pool: records with no owner, or owned by someone
//   who is not a working member (a leaver, a HubSpot-era owner).
//
// Work no member started (a sibling app's key, the cron) has no Access and
// is not narrowed: its key or schedule is its authority.

export interface Access {
  userId: string;
  organizationId: string;
  role: CrmRole;
  /** Admins see every record. */
  seeAll: boolean;
  /** Owners whose records this member sees and changes. */
  visibleOwnerIds: string[];
  /** Working members: anyone else's records are in the shared pool. */
  workingOwnerIds: string[];
}

const accessStore = new AsyncLocalStorage<Access>();

export function runWithAccess<T>(access: Access, fn: () => T): T {
  return accessStore.run(access, fn);
}

/** The Access of the member this request is for; undefined for app and cron work. */
export function currentAccess(): Access | undefined {
  return accessStore.getStore();
}

function isGatewayAdmin(gatewayRole: string) {
  return gatewayRole
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === "owner" || part === "admin");
}

interface TeamMember {
  userId: string;
  role: CrmRole;
  managerId: string | null;
  leftAt: string | null;
  gatewayRole: string;
}

/** The organization's members with their CRM role, team and status. */
export async function loadTeam(organizationId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({
      userId: member.userId,
      gatewayRole: member.role,
      role: crmRole.role,
      managerId: crmRole.managerId,
      leftAt: crmRole.leftAt,
    })
    .from(member)
    .leftJoin(
      crmRole,
      and(
        eq(crmRole.organizationId, member.organizationId),
        eq(crmRole.userId, member.userId),
      ),
    )
    .where(eq(member.organizationId, organizationId));
  return rows.map((row) => ({
    userId: row.userId,
    gatewayRole: row.gatewayRole,
    role: isGatewayAdmin(row.gatewayRole) ? "admin" : (row.role ?? "seller"),
    managerId: row.managerId,
    leftAt: row.leftAt,
  }));
}

/** What `userId` (signed in with `gatewayRole`) sees, given the team; FORBIDDEN once they have left. */
function accessFor(
  organizationId: string,
  userId: string,
  gatewayRole: string,
  team: TeamMember[],
): Access {
  const me = team.find((row) => row.userId === userId);
  // A member marked as left keeps no access, whatever their gateway seat.
  if (me?.leftAt) throw new AppError("FORBIDDEN");
  const role: CrmRole = isGatewayAdmin(gatewayRole)
    ? "admin"
    : (me?.role ?? "seller");
  const working = team.filter((row) => !row.leftAt).map((row) => row.userId);
  if (!working.includes(userId)) working.push(userId);
  const visible =
    role === "manager"
      ? [
          userId,
          ...team
            .filter((row) => row.managerId === userId)
            .map((row) => row.userId),
        ]
      : [userId];
  return {
    userId,
    organizationId,
    role,
    seeAll: role === "admin",
    visibleOwnerIds: [...new Set(visible)],
    workingOwnerIds: [...new Set(working)],
  };
}

export async function resolveAccess(context: {
  userId: string;
  organizationId: string;
  role: string;
}): Promise<Access> {
  const team = await loadTeam(context.organizationId);
  return accessFor(context.organizationId, context.userId, context.role, team);
}

/** Throws FORBIDDEN unless the work is an admin's, an app key's or the cron's. */
export function assertSeesAll(): void {
  const access = currentAccess();
  if (access && !access.seeAll) throw new AppError("FORBIDDEN");
}

/**
 * The activities the current member may see and change: those not filed on a
 * contact or deal they can't see. An activity on a company alone is shared,
 * like the company. Undefined for all.
 */
export function activityAccessCondition(): SQL | undefined {
  const access = currentAccess();
  if (!access || access.seeAll) return undefined;
  return and(
    or(
      isNull(activity.contactId),
      exists(
        db
          .select({ one: contact.id })
          .from(contact)
          .where(
            and(
              eq(contact.id, activity.contactId),
              eq(contact.organizationId, activity.organizationId),
              contactAccessCondition(),
            ),
          ),
      ),
    ),
    or(
      isNull(activity.dealId),
      exists(
        db
          .select({ one: deal.id })
          .from(deal)
          .where(
            and(
              eq(deal.id, activity.dealId),
              eq(deal.organizationId, activity.organizationId),
              dealAccessCondition(),
            ),
          ),
      ),
    ),
  );
}

// The owner tests below read the team from the database by subquery rather
// than binding every owner id: D1 allows 100 bound values per statement, and
// these conditions ride along on statements already near that limit.

/** The member's own records, and their team's when they manage one. */
function ownedByVisible(column: AnyColumn, access: Access): SQL | undefined {
  return or(
    eq(column, access.userId),
    access.role === "manager"
      ? inArray(
          column,
          db
            .select({ id: crmRole.userId })
            .from(crmRole)
            .where(
              and(
                eq(crmRole.organizationId, access.organizationId),
                eq(crmRole.managerId, access.userId),
              ),
            ),
        )
      : undefined,
  );
}

/** Owners who are not working members: their records are the shared pool. */
function ownedByPool(column: AnyColumn, access: Access): SQL {
  return notInArray(
    column,
    db
      .select({ id: member.userId })
      .from(member)
      .where(
        and(
          eq(member.organizationId, access.organizationId),
          notExists(
            db
              .select({ one: crmRole.userId })
              .from(crmRole)
              .where(
                and(
                  eq(crmRole.organizationId, member.organizationId),
                  eq(crmRole.userId, member.userId),
                  isNotNull(crmRole.leftAt),
                ),
              ),
          ),
        ),
      ),
  );
}

/** Rows in the shared pool through `column`; undefined for app and cron work. */
export function poolOwnerCondition(column: AnyColumn): SQL | undefined {
  const access = currentAccess();
  return access ? ownedByPool(column, access) : undefined;
}

/** Rows owned through `column` that the member sees; undefined for all. */
function ownerAccessCondition(column: AnyColumn): SQL | undefined {
  const access = currentAccess();
  if (!access || access.seeAll) return undefined;
  return or(
    isNull(column),
    ownedByVisible(column, access),
    ownedByPool(column, access),
  );
}

/**
 * The tasks the current member may tick off: ones on records they see that
 * they, their team or a leaver set, or that sit on a deal they own.
 */
export function taskAccessCondition(): SQL | undefined {
  const access = currentAccess();
  if (!access || access.seeAll) return undefined;
  return and(
    activityAccessCondition(),
    or(
      ownerAccessCondition(activity.createdById),
      exists(
        db
          .select({ one: deal.id })
          .from(deal)
          .where(
            and(
              eq(deal.id, activity.dealId),
              eq(deal.organizationId, activity.organizationId),
              ownedByVisible(deal.ownerId, access),
            ),
          ),
      ),
    ),
  );
}

/** The deals the current member may see and change; undefined for all. */
export function dealAccessCondition(): SQL | undefined {
  return ownerAccessCondition(deal.ownerId);
}

/**
 * The contacts the current member may see and change: their own, the
 * shared pool, and the people on deals they see. Undefined for all.
 */
export function contactAccessCondition(): SQL | undefined {
  const access = currentAccess();
  if (!access || access.seeAll) return undefined;
  return or(
    ownerAccessCondition(contact.ownerId),
    exists(
      db
        .select({ one: dealContact.dealId })
        .from(dealContact)
        .innerJoin(
          deal,
          and(
            eq(deal.id, dealContact.dealId),
            eq(deal.organizationId, dealContact.organizationId),
          ),
        )
        .where(
          and(
            eq(dealContact.contactId, contact.id),
            eq(dealContact.organizationId, contact.organizationId),
            ownedByVisible(deal.ownerId, access),
          ),
        ),
    ),
  );
}
