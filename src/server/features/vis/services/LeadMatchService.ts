import { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { phoneKey } from "@/shared/vis";
import type { LeadInput } from "@/types/schemas/vis";

// Who a lead already is: the live contact with its email (first) or its
// E.164 phone, and their open Star CRM deals. Intake joins an open deal only
// on an identifier the sending app says its channel proved.
/**
 * The live contact this lead already is, by email first, then by phone, and
 * which of the two matched.
 */
async function knownPerson(
  organizationId: string,
  email: string | null,
  phone: string | undefined,
) {
  const byEmail = email
    ? await VisRepository.liveContactByEmail(organizationId, email)
    : null;
  if (byEmail) return { ...byEmail, matchedBy: "email" as const };
  const key = phoneKey(phone);
  const byPhone = key
    ? await VisRepository.liveContactByPhone(organizationId, key)
    : null;
  return byPhone ? { ...byPhone, matchedBy: "phone" as const } : null;
}

/** Their newest open Star CRM deal for this product (or any, when none is named). */
async function openDealFor(
  organizationId: string,
  contactId: string,
  input: LeadInput,
) {
  const open = await VisRepository.leadDeals(organizationId, contactId, true);
  return (
    open.find(
      (row) => !input.product || !row.product || row.product === input.product,
    ) ?? null
  );
}

/** What Star CRM already holds for a person, found by email or phone. */
async function lookup(
  organizationId: string,
  query: { email?: string; phone?: string },
) {
  const known = await knownPerson(
    organizationId,
    query.email?.trim().toLowerCase() ?? null,
    query.phone,
  );
  if (!known) return { contactId: null, deals: [] };
  return {
    contactId: known.id,
    deals: await VisRepository.leadDeals(organizationId, known.id, false),
  };
}

export const LeadMatchService = { knownPerson, openDealFor, lookup };
