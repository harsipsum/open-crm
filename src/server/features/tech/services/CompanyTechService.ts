import { CompanyRepository } from "@/server/features/companies/repositories/CompanyRepository";
import { CompanyTechRepository } from "@/server/features/tech/repositories/CompanyTechRepository";
import { AppError, UserFacingError } from "@/server/lib/errors";
import { safeHostname, safeHttpUrl } from "@/shared/safe-url";
import { techProductKey } from "@/shared/tech";
import type { AddCompanyTechInput } from "@/types/schemas/tech";

// A company's tech stack. It is the company's, so whoever sees and edits the
// company (every member: companies are shared) sees and edits its stack.
// Lines are archived, never deleted.

async function requireCompany(organizationId: string, companyId: string) {
  const found = await CompanyRepository.findById(organizationId, companyId);
  if (!found) {
    throw new AppError("NOT_FOUND", `No company with id ${companyId}.`);
  }
  return found;
}

/** The company, when its stack may change: an archived company's may not. */
async function requireOpenCompany(organizationId: string, companyId: string) {
  const found = await requireCompany(organizationId, companyId);
  if (found.archivedAt) {
    throw new UserFacingError(
      "CONFLICT",
      "This company is archived. Restore it to change its tech stack.",
    );
  }
  return found;
}

type Row = Awaited<
  ReturnType<typeof CompanyTechRepository.listForCompany>
>[number];

/**
 * A line as people see it. An email line's source names a mailbox and a
 * message, so it never leaves the server; a public line shows its page.
 */
function shown(row: Row) {
  const { source, ...rest } = row;
  const publicUrl = row.origin === "public" ? safeHttpUrl(source) : null;
  return {
    ...rest,
    publicUrl,
    publicHost: publicUrl ? safeHostname(publicUrl) : null,
  };
}

export type CompanyTechLine = ReturnType<typeof shown>;

async function list(organizationId: string, companyId: string) {
  await requireCompany(organizationId, companyId);
  const rows = await CompanyTechRepository.listForCompany(
    organizationId,
    companyId,
  );
  return rows.map(shown);
}

async function add(
  organizationId: string,
  userId: string,
  input: AddCompanyTechInput,
) {
  await requireOpenCompany(organizationId, input.companyId);
  const product = input.product.trim().replace(/\s+/g, " ");
  const team = input.origin === "team";
  const now = new Date().toISOString();
  const { id, created } = await CompanyTechRepository.insert({
    organizationId,
    companyId: input.companyId,
    product,
    productKey: techProductKey(product),
    category: input.category ?? null,
    origin: input.origin,
    verified: team,
    source: team ? null : (input.source ?? null),
    observedAt: now.slice(0, 10),
    enteredById: userId,
    confirmedById: team ? userId : null,
    confirmedAt: team ? now : null,
  });
  // A member saying the company runs a product it already lists confirms it.
  if (!created && team) {
    await CompanyTechRepository.confirm(organizationId, id, userId);
  }
  const line = await CompanyTechRepository.findById(organizationId, id);
  if (!line) throw new Error("Tech line missing after insert");
  return { ...shown(line), created };
}

async function confirm(organizationId: string, userId: string, id: string) {
  const line = await CompanyTechRepository.findById(organizationId, id);
  if (!line || line.archivedAt) {
    throw new AppError("NOT_FOUND", `No tech line with id ${id}.`);
  }
  await requireOpenCompany(organizationId, line.companyId);
  await CompanyTechRepository.confirm(organizationId, id, userId);
  const confirmed = await CompanyTechRepository.findById(organizationId, id);
  if (!confirmed) throw new Error("Tech line missing after confirm");
  return shown(confirmed);
}

async function archive(organizationId: string, userId: string, id: string) {
  const line = await CompanyTechRepository.findById(organizationId, id);
  if (!line || line.archivedAt) {
    throw new AppError("NOT_FOUND", `No tech line with id ${id}.`);
  }
  await requireOpenCompany(organizationId, line.companyId);
  await CompanyTechRepository.archive(organizationId, id, userId);
  return { id, product: line.product, companyId: line.companyId };
}

/** Brings an archived line back, as it was: the undo for archive. */
async function restore(organizationId: string, id: string) {
  const line = await CompanyTechRepository.findById(organizationId, id);
  if (!line || !line.archivedAt) {
    throw new AppError("NOT_FOUND", `No archived tech line with id ${id}.`);
  }
  await requireOpenCompany(organizationId, line.companyId);
  const restored = await CompanyTechRepository.restore(organizationId, id);
  if (!restored) {
    throw new UserFacingError(
      "CONFLICT",
      `${line.product} is listed again already, so the archived line stays archived.`,
    );
  }
  const back = await CompanyTechRepository.findById(organizationId, id);
  if (!back) throw new Error("Tech line missing after restore");
  return shown(back);
}

export const CompanyTechService = { list, add, confirm, archive, restore };
