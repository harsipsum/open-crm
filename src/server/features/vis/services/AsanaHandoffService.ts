import { z } from "zod";
import { DealService } from "@/server/features/deals/services/DealService";
import { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { ORDER_TYPE_LABELS, PRODUCT_LABELS } from "@/shared/vis";

// Won goes to Asana with every field filled, under the service identity
// whose token ASANA_TOKEN holds (not a person's account). The task lands in
// ASANA_PROJECT_GID's "New Orders" section with the intake project's fields,
// matched by name: Total Contract Value, Order Type, License Revenue,
// Implementation Value, Implementation Reqd?, Product, Asana License Type,
// No. Of Users, Freshworks Products. A field the project lacks (a free
// workspace has no custom fields) is written as a "Field: value" line at the
// top of the description instead, so nothing is lost either way. The deal's
// contacts, its source and its CRM link go in the description too.
//
// Each won deal is handed off once (asana_handoff); a failed call keeps its
// error on the deal until a person retries it.

const ASANA = "https://app.asana.com/api/1.0";
const SECTION = "New Orders";

const settingsAnswer = z.object({
  data: z.array(
    z.object({
      custom_field: z.object({
        gid: z.string(),
        name: z.string(),
        resource_subtype: z.string(),
        enum_options: z
          .array(z.object({ gid: z.string(), name: z.string() }))
          .nullish(),
      }),
    }),
  ),
});
const sectionsAnswer = z.object({
  data: z.array(z.object({ gid: z.string(), name: z.string() })),
});
const taskAnswer = z.object({
  data: z.object({ gid: z.string(), permalink_url: z.string().nullish() }),
});

type FieldValue = number | string | string[] | null;

async function asana(token: string, path: string, init?: RequestInit) {
  const response = await fetch(`${ASANA}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Asana ${path} answered ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as unknown;
}

/**
 * The project's custom fields. A workspace on Asana's free plan has none and
 * answers 402 for them: every value then goes in the description.
 */
async function customFields(token: string, projectGid: string) {
  const response = await fetch(
    `${ASANA}/projects/${projectGid}/custom_field_settings?opt_fields=custom_field.name,custom_field.resource_subtype,custom_field.enum_options.name`,
    {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    },
  );
  if (response.status === 402) return [];
  if (!response.ok) {
    throw new Error(`Asana custom fields answered ${response.status}`);
  }
  return settingsAnswer.parse(await response.json()).data;
}

/** The intake fields' values for this deal, by the project's field names. */
async function fieldValues(organizationId: string, dealId: string) {
  const found = await DealService.getDeal(organizationId, dealId);
  const lead = await VisRepository.attribution(organizationId, dealId);
  const sold = await VisRepository.order(organizationId, dealId);
  const users = sold?.users ?? lead?.users ?? null;
  const values: Record<string, FieldValue> = {
    "Total Contract Value": found.amount,
    "Order Type": lead ? ORDER_TYPE_LABELS[lead.orderType] : null,
    "License Revenue": sold?.licenseRevenue ?? null,
    "Implementation Value": sold?.implementationValue ?? null,
    "Implementation Reqd?":
      sold?.implementationRequired === undefined ||
      sold?.implementationRequired === null
        ? null
        : sold.implementationRequired
          ? "Yes"
          : "No",
    Product: lead?.product ? PRODUCT_LABELS[lead.product] : null,
    "Asana License Type":
      sold?.asanaLicenseType ?? (lead?.product === "ASANA" ? null : "N/A"),
    "No. Of Users": users,
    "Freshworks Products":
      lead?.product === "FRESHWORKS" ? (sold?.freshworksProducts ?? null) : [],
  };
  return { found, lead, values };
}

function shown(value: FieldValue) {
  if (value === null) return "(missing)";
  return Array.isArray(value) ? value.join(", ") || "None" : String(value);
}

/** Sets what the project has as custom fields; the rest go in the text. */
function mapFields(
  settings: z.infer<typeof settingsAnswer>["data"],
  values: Record<string, FieldValue>,
) {
  const custom: Record<string, unknown> = {};
  const inText: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = settings.find(
      (row) =>
        row.custom_field.name.trim().toLowerCase() === name.toLowerCase(),
    )?.custom_field;
    const options = field?.enum_options ?? [];
    const option = (label: string) =>
      options.find(
        (row) => row.name.trim().toLowerCase() === label.toLowerCase(),
      )?.gid;
    if (field && value !== null) {
      if (field.resource_subtype === "number" && typeof value === "number") {
        custom[field.gid] = value;
        continue;
      }
      if (
        field.resource_subtype === "enum" &&
        typeof value === "string" &&
        option(value)
      ) {
        custom[field.gid] = option(value);
        continue;
      }
      // Every value must match an option; otherwise the line goes in the
      // text, so nothing is dropped.
      if (
        field.resource_subtype === "multi_enum" &&
        Array.isArray(value) &&
        value.every((label) => option(label))
      ) {
        custom[field.gid] = value.map(option);
        continue;
      }
    }
    inText.push(`${name}: ${shown(value)}`);
  }
  return { custom, inText };
}

/** Hands one won deal off; the task's gid and link, or why it failed. */
async function handOff(
  organizationId: string,
  dealId: string,
  origin: string | null,
) {
  const token = await getOptionalEnvValue("ASANA_TOKEN");
  const projectGid = await getOptionalEnvValue("ASANA_PROJECT_GID");
  if (!token || !projectGid) return null;
  // Only this organization's won deal is ever claimed: getDeal refuses
  // another organization's id before anything is written.
  const deal = await DealService.getDeal(organizationId, dealId);
  if (deal.stage !== "CLOSED_WON") return null;
  if (!(await VisRepository.claimHandoff(organizationId, dealId, projectGid))) {
    return null;
  }
  try {
    const { found, lead, values } = await fieldValues(organizationId, dealId);
    const settings = await customFields(token, projectGid);
    const sections = sectionsAnswer.parse(
      await asana(token, `/projects/${projectGid}/sections?opt_fields=name`),
    ).data;
    const section = sections.find((row) => row.name === SECTION);
    const { custom, inText } = mapFields(settings, values);
    const people = await VisRepository.dealPeople(
      organizationId,
      dealId,
      lead?.contactId ?? null,
    );
    const contacts = people.map((person) =>
      [
        [person.firstName, person.lastName].filter(Boolean).join(" "),
        person.title,
        person.email,
        person.phone,
        person.role,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    const missing = Object.entries(values)
      .filter(([, value]) => value === null)
      .map(([name]) => name);
    const notes = [
      ...inText,
      ...(inText.length ? [""] : []),
      `Company: ${found.company.name}${found.company.domain ? ` (${found.company.domain})` : ""}`,
      `Contacts:`,
      ...(contacts.length
        ? contacts.map((line) => `- ${line}`)
        : ["- (none on the deal)"]),
      `Source: ${lead ? [lead.source, lead.campaign, lead.creativeId].filter(Boolean).join(" · ") : "unknown"}`,
      `Deal owner: ${found.owner.name ?? found.owner.email}`,
      ...(origin ? [`CRM: ${origin}/deals/${dealId}`] : []),
      ...(missing.length
        ? ["", `Missing at handoff: ${missing.join(", ")}`]
        : []),
    ].join("\n");
    const productLabel = lead?.product ? PRODUCT_LABELS[lead.product] : "Deal";
    const orderLabel = lead ? ORDER_TYPE_LABELS[lead.orderType] : "New";
    const task = taskAnswer.parse(
      await asana(token, "/tasks", {
        method: "POST",
        body: JSON.stringify({
          data: {
            name: `${found.company.name} - ${productLabel} - ${orderLabel}`,
            notes,
            projects: [projectGid],
            ...(Object.keys(custom).length ? { custom_fields: custom } : {}),
            ...(section
              ? { memberships: [{ project: projectGid, section: section.gid }] }
              : {}),
          },
        }),
      }),
    ).data;
    await VisRepository.finishHandoff(organizationId, dealId, {
      taskGid: task.gid,
      taskUrl: task.permalink_url ?? null,
      error: null,
    });
    console.log("[vis] won handed to asana", {
      organizationId,
      dealId,
      taskGid: task.gid,
    });
    return task.gid;
  } catch (error) {
    // Kept with its error, not retried every minute (no burn): a person
    // retries it from the deal once the cause is fixed.
    const message =
      error instanceof Error ? error.message.slice(0, 300) : "unknown";
    await VisRepository.finishHandoff(organizationId, dealId, {
      taskGid: null,
      taskUrl: null,
      error: message,
    });
    console.error("[vis] asana handoff failed", { organizationId, dealId });
    return null;
  }
}

/** A person retries a handoff that failed. */
async function retry(
  organizationId: string,
  dealId: string,
  origin: string | null,
) {
  const found = await VisRepository.handoff(organizationId, dealId);
  if (found?.taskGid) return found.taskGid;
  // Only a handoff that failed is let go; one still in flight stays put.
  if (
    found &&
    !(await VisRepository.releaseFailedHandoff(organizationId, dealId))
  ) {
    return null;
  }
  return handOff(organizationId, dealId, origin);
}

export const AsanaHandoffService = { handOff, retry };
