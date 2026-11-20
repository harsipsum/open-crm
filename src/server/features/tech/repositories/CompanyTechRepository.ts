import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import { companyTech, user } from "@/db/schema";

// A company's tech stack lines. Every read and write is narrowed to the
// organization; the service has checked the company is the organization's.

const enteredBy = alias(user, "entered_by");
const confirmedBy = alias(user, "confirmed_by");

const columns = {
  id: companyTech.id,
  companyId: companyTech.companyId,
  product: companyTech.product,
  category: companyTech.category,
  origin: companyTech.origin,
  verified: companyTech.verified,
  source: companyTech.source,
  observedAt: companyTech.observedAt,
  confirmedAt: companyTech.confirmedAt,
  archivedAt: companyTech.archivedAt,
  createdAt: companyTech.createdAt,
  enteredByName: enteredBy.name,
  confirmedByName: confirmedBy.name,
};

function inOrganization(organizationId: string, id: string) {
  return and(
    eq(companyTech.organizationId, organizationId),
    eq(companyTech.id, id),
  );
}

/** A company's live lines, verified first, then by product. */
async function listForCompany(organizationId: string, companyId: string) {
  return db
    .select(columns)
    .from(companyTech)
    .leftJoin(enteredBy, eq(enteredBy.id, companyTech.enteredById))
    .leftJoin(confirmedBy, eq(confirmedBy.id, companyTech.confirmedById))
    .where(
      and(
        eq(companyTech.organizationId, organizationId),
        eq(companyTech.companyId, companyId),
        isNull(companyTech.archivedAt),
      ),
    )
    .orderBy(desc(companyTech.verified), asc(companyTech.productKey));
}

async function findById(organizationId: string, id: string) {
  const [row] = await db
    .select(columns)
    .from(companyTech)
    .leftJoin(enteredBy, eq(enteredBy.id, companyTech.enteredById))
    .leftJoin(confirmedBy, eq(confirmedBy.id, companyTech.confirmedById))
    .where(inOrganization(organizationId, id))
    .limit(1);
  return row ?? null;
}

type NewLine = Omit<
  typeof companyTech.$inferInsert,
  "id" | "archivedAt" | "archivedById" | "createdAt"
>;

/**
 * Adds a line, or finds the live one the company already has for the
 * product: `created` says which.
 */
async function insert(values: NewLine) {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(companyTech)
    .values({ ...values, id })
    .onConflictDoUpdate({
      target: [
        companyTech.organizationId,
        companyTech.companyId,
        companyTech.productKey,
      ],
      targetWhere: sql`${companyTech.archivedAt} is null`,
      set: { productKey: values.productKey },
    })
    .returning({ id: companyTech.id });
  if (!row) throw new Error("Tech line missing after insert");
  return { id: row.id, created: row.id === id };
}

/** Marks an unverified live line verified by `userId`; null when there is none. */
async function confirm(organizationId: string, id: string, userId: string) {
  const [row] = await db
    .update(companyTech)
    .set({
      verified: true,
      confirmedById: userId,
      confirmedAt: new Date().toISOString(),
    })
    .where(
      and(
        inOrganization(organizationId, id),
        eq(companyTech.verified, false),
        isNull(companyTech.archivedAt),
      ),
    )
    .returning({ id: companyTech.id });
  return row ?? null;
}

/** Archives a live line; null when there is none. */
async function archive(organizationId: string, id: string, userId: string) {
  const [row] = await db
    .update(companyTech)
    .set({ archivedAt: new Date().toISOString(), archivedById: userId })
    .where(
      and(inOrganization(organizationId, id), isNull(companyTech.archivedAt)),
    )
    .returning({ id: companyTech.id });
  return row ?? null;
}

export const CompanyTechRepository = {
  listForCompany,
  findById,
  insert,
  confirm,
  archive,
};
