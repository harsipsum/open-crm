import { env } from "cloudflare:workers";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { member, user } from "@/db/auth.schema";
import { company, contact } from "@/db/crm.schema";
import { ActivityService } from "@/server/features/activities/services/ActivityService";
import { CompanyService } from "@/server/features/companies/services/CompanyService";
import { ContactRepository } from "@/server/features/contacts/repositories/ContactRepository";
import { ContactService } from "@/server/features/contacts/services/ContactService";
import { DealService } from "@/server/features/deals/services/DealService";
import { forOrganization } from "@/server/lib/gateway-attribution";
import { inboxEngine } from "./inboxRoute";

// OpenCRM is the source of truth for people and deals; the Inbox owns the
// conversations. Each minute (cron.ts) the CRM pulls the Inbox engine's link
// queue and, in its own D1, for each conversation:
//  - finds the contact by phone, then email, then handle (X handle on the
//    contact's twitter_url), or creates one;
//  - only for a lead the agent qualified (every required answer captured),
//    creates a deal at QUALIFIED_TO_BUY under "Direct enquiries", owned by
//    the routed salesperson when they are a member, else the organization's
//    owner, with the contact on it;
//  - writes a NOTE on the timeline saying where it came from (provenance);
// and reports the ids back, so the Inbox shows the link. Nothing here sends a
// message to anyone.
const DIRECT_COMPANY = "Direct enquiries";

type Pending = {
  conv: string;
  channel: string;
  account: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  handle: string | null;
  demo: boolean;
  qualified: boolean;
  record: Record<string, unknown>;
  source: Record<string, unknown> | null;
  owner: { email?: string; crmOwnerEmail?: string; why?: string } | null;
  assignee: string | null;
  contactId: string | null;
  dealId: string | null;
  summary: string;
};
type Linked = {
  conv: string;
  contactId?: string;
  dealId?: string;
  matchedBy?: string;
  ownerEmail?: string;
  error?: string;
};

const CHANNEL: Record<string, string> = {
  wa: "WhatsApp",
  ig: "Instagram",
  fb: "Messenger",
  li: "LinkedIn",
  x: "X",
  igc: "Instagram comment",
};

async function engineFetch(path: string, init?: RequestInit): Promise<unknown> {
  const engine = inboxEngine();
  if (!engine) return null;
  const response = await fetch(`${engine.url}/inbox-api/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${engine.token}`,
      "content-type": "application/json",
      "x-inbox-actor": "opencrm-sync",
    },
  });
  if (!response.ok)
    throw new Error(`inbox engine ${response.status} on ${path}`);
  return response.json();
}

export async function runInboxCrmSync(): Promise<{ linked: number }> {
  const organizationId = env.EVERY_APP_ORG_ID;
  if (!organizationId || !inboxEngine()) return { linked: 0 };
  const clients = (await engineFetch("clients")) as {
    clients: string[];
  } | null;
  let linked = 0;
  for (const client of clients?.clients ?? []) {
    const pending = (await engineFetch(`c/${client}/crm/pending`)) as {
      items: Pending[];
    };
    if (!pending?.items?.length) continue;
    const results: Linked[] = [];
    for (const item of pending.items) {
      try {
        results.push(
          await forOrganization(organizationId, () =>
            linkOne(organizationId, client, item),
          ),
        );
        linked++;
      } catch (error) {
        results.push({
          conv: item.conv,
          error: String((error as Error)?.message ?? error),
        });
      }
    }
    await engineFetch(`c/${client}/crm/linked`, {
      method: "POST",
      body: JSON.stringify({ results }),
    });
  }
  return { linked };
}

const digits = (value: string | null | undefined) =>
  String(value ?? "").replace(/\D/g, "");

async function organizationOwner(organizationId: string): Promise<string> {
  const rows = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(member.createdAt));
  const owner = rows.find((row) => row.role === "owner") ?? rows[0];
  if (!owner) throw new Error("the organization has no members yet");
  return owner.userId;
}

async function memberByEmail(
  organizationId: string,
  email: string | undefined | null,
) {
  if (!email) return null;
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(sql`lower(${user.email})`, email.toLowerCase()),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

async function findContact(organizationId: string, item: Pending) {
  const phone = digits(item.phone);
  if (phone.length >= 8) {
    const tail = phone.slice(-9);
    const rows = await db
      .select({ id: contact.id, phone: contact.phone })
      .from(contact)
      .where(
        and(
          eq(contact.organizationId, organizationId),
          isNull(contact.archivedAt),
          sql`replace(replace(replace(replace(replace(${contact.phone}, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') like ${"%" + tail}`,
        ),
      )
      .limit(1);
    if (rows[0]) return { id: rows[0].id, matchedBy: "phone" };
  }
  if (item.email) {
    const found = await ContactRepository.findLiveByEmail(
      organizationId,
      item.email.toLowerCase(),
    );
    if (found) return { id: found.id, matchedBy: "email" };
  }
  if (item.handle && item.channel === "x") {
    const handle = item.handle.replace(/^@/, "").toLowerCase();
    const rows = await db
      .select({ id: contact.id })
      .from(contact)
      .where(
        and(
          eq(contact.organizationId, organizationId),
          isNull(contact.archivedAt),
          sql`lower(${contact.twitterUrl}) like ${"%/" + handle}`,
        ),
      )
      .limit(1);
    if (rows[0]) return { id: rows[0].id, matchedBy: "handle" };
  }
  return null;
}

async function directCompany(organizationId: string, ownerId: string) {
  const rows = await db
    .select({ id: company.id })
    .from(company)
    .where(
      and(
        eq(company.organizationId, organizationId),
        eq(company.name, DIRECT_COMPANY),
        isNull(company.archivedAt),
      ),
    )
    .limit(1);
  if (rows[0]) return rows[0].id;
  const created = await CompanyService.createCompany(organizationId, {
    name: DIRECT_COMPANY,
    ownerId,
  });
  return created.id;
}

function provenance(client: string, item: Pending, what: string) {
  return [
    what,
    `Source: OpenCRM Inbox (client ${client}, ${CHANNEL[item.channel] ?? item.channel} ${item.account}, conversation ${item.conv})${item.demo ? " — DEMO data" : ""}.`,
    item.source ? `Lead source: ${JSON.stringify(item.source)}` : "",
    Object.keys(item.record ?? {}).length
      ? `Captured by the agent: ${JSON.stringify(item.record)}`
      : "",
    "",
    item.summary,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function linkOne(
  organizationId: string,
  client: string,
  item: Pending,
): Promise<Linked> {
  const fallbackOwner = await organizationOwner(organizationId);
  const routedOwner =
    (await memberByEmail(
      organizationId,
      item.owner?.crmOwnerEmail ?? item.owner?.email,
    )) ?? (await memberByEmail(organizationId, item.assignee));
  const ownerId = routedOwner ?? fallbackOwner;
  let contactId = item.contactId;
  let matchedBy: string | undefined;
  if (!contactId) {
    const found = await findContact(organizationId, item);
    if (found) {
      contactId = found.id;
      matchedBy = found.matchedBy;
    } else {
      const display = (item.name || item.handle || "").trim();
      const [first, ...rest] = display.split(/\s+/);
      const created = await ContactService.createContact(organizationId, {
        firstName:
          `${item.demo ? "[demo] " : ""}${first || `${CHANNEL[item.channel] ?? "Inbox"} lead`}`.slice(
            0,
            100,
          ),
        lastName: rest.join(" ") || undefined,
        phone: item.phone ?? undefined,
        email: item.email ?? undefined,
        ownerId: routedOwner,
      });
      contactId = created.id;
      matchedBy = "created";
    }
    await ActivityService.createActivity(organizationId, ownerId, {
      type: "NOTE",
      contactId,
      subject: `${CHANNEL[item.channel] ?? "Inbox"} conversation linked`,
      body: provenance(
        client,
        item,
        `Conversation linked to this contact (${matchedBy}).`,
      ).slice(0, 9000),
    });
  }
  let dealId = item.dealId;
  if (item.qualified && !dealId) {
    const companyId = await directCompany(organizationId, ownerId);
    const need = String(item.record?.need ?? "enquiry").slice(0, 80);
    const deal = await DealService.createDeal(organizationId, {
      name: `${item.name || item.handle || "Inbox lead"}: ${need}`.slice(
        0,
        200,
      ),
      companyId,
      ownerId,
      stage: "QUALIFIED_TO_BUY",
    });
    dealId = deal.id;
    await DealService.attachContact(organizationId, { dealId, contactId });
    await ActivityService.createActivity(organizationId, ownerId, {
      type: "NOTE",
      dealId,
      contactId,
      subject: "Qualified by the Inbox agent",
      body: provenance(
        client,
        item,
        `Qualified lead${item.owner?.why ? `, routed: ${item.owner.why}` : ""}.`,
      ).slice(0, 9000),
    });
  }
  const ownerEmail = item.owner?.crmOwnerEmail ?? item.owner?.email;
  return {
    conv: item.conv,
    contactId,
    dealId: dealId ?? undefined,
    matchedBy,
    ownerEmail,
  };
}
