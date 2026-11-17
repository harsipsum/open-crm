import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// Composio Instant, as Star CRM's research calls it: a tool-router session per
// organization (its user id is viscrm-<organization>), one tool call per
// request, and what Composio charged for it (instant_charge, an exact USD
// amount). The answers' shapes are read through Zod, wherever the provider
// nests them. A project without Instant on answers NoActiveConnection: that
// is a wait (ProviderWait), not a failure.
const COMPOSIO = "https://backend.composio.dev/api/v3.1";
export const COMPANY_TOOL = "LEADMAGIC_ENRICH_COMPANY_V1";
export const PERSON_TOOL = "PROSPEO_ENRICH_PERSON";

const sessions = new Map<string, string>();

const sessionAnswer = z.object({ session_id: z.string() });
const executeAnswer = z.object({
  data: z.unknown().optional(),
  error: z.unknown().optional(),
  successful: z.boolean().optional(),
  instant_charge: z
    .object({ amount: z.union([z.string(), z.number()]) })
    .partial()
    .nullish(),
});

export class ProviderWait extends Error {}

async function composioSession(apiKey: string, organizationId: string) {
  const cached = sessions.get(organizationId);
  if (cached) return cached;
  const response = await fetch(`${COMPOSIO}/tool_router/session`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      user_id: `viscrm-${organizationId}`,
      toolkits: { enable: ["leadmagic", "prospeo"] },
      instant: { return_instant_charge: true },
    }),
  });
  if (!response.ok) {
    throw new ProviderWait(`Composio session refused (${response.status}).`);
  }
  const { session_id } = sessionAnswer.parse(await response.json());
  sessions.set(organizationId, session_id);
  return session_id;
}

/** Runs one Instant tool; its answer and what Composio charged for it. */
export async function runInstant(
  organizationId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const apiKey = await getOptionalEnvValue("COMPOSIO_API_KEY");
  if (!apiKey) throw new ProviderWait("COMPOSIO_API_KEY is not set.");
  const session = await composioSession(apiKey, organizationId);
  const response = await fetch(
    `${COMPOSIO}/tool_router/session/${session}/execute`,
    {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ tool_slug: tool, arguments: args }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    // No Instant account on the project yet: a wait for the relay, not a fail.
    if (text.includes("NoActiveConnection")) {
      throw new ProviderWait(
        "Composio Instant is off for this project: waiting for the relay.",
      );
    }
    throw new Error(`Composio ${tool} answered ${response.status}`);
  }
  const answer = executeAnswer.parse(JSON.parse(text));
  const amount = Number(answer.instant_charge?.amount ?? 0);
  // A 200 can still say the tool failed: that is a failure (with whatever
  // it cost), never an empty "not found".
  const failed =
    answer.successful === false || answer.error
      ? typeof answer.error === "string"
        ? answer.error.slice(0, 300)
        : "The provider reported a failure."
      : null;
  return {
    data: answer.data,
    costUsd: Number.isFinite(amount) ? amount : 0,
    failed,
  };
}

const companyData = z
  .object({
    companyName: z.string().nullish(),
    company_name: z.string().nullish(),
    industry: z.string().nullish(),
    employeeCount: z.number().nullish(),
    employee_count: z.number().nullish(),
    headquarter: z
      .object({ country: z.string().nullish(), city: z.string().nullish() })
      .partial()
      .nullish(),
    country: z.string().nullish(),
    description: z.string().nullish(),
    revenue: z.unknown().optional(),
  })
  .partial()
  .loose();

/** What a company answer says, wherever the provider nests it. */
export function readCompany(data: unknown) {
  const candidate =
    z.object({ data: z.unknown() }).safeParse(data).data?.data ?? data;
  const parsed = companyData.safeParse(candidate);
  if (!parsed.success) return null;
  const row = parsed.data;
  const name = row.companyName ?? row.company_name ?? null;
  const headcount = row.employeeCount ?? row.employee_count ?? null;
  const country = row.headquarter?.country ?? row.country ?? null;
  if (!name && headcount === null && !country) return null;
  return {
    name,
    industry: row.industry ?? null,
    headcount,
    country,
    city: row.headquarter?.city ?? null,
    description: row.description?.slice(0, 600) ?? null,
  };
}

const personData = z
  .object({
    person: z
      .object({
        full_name: z.string().nullish(),
        current_job_title: z.string().nullish(),
        linkedin_url: z.string().nullish(),
        email: z
          .object({ email: z.string().nullish(), status: z.string().nullish() })
          .partial()
          .nullish(),
        mobile: z
          .object({
            mobile: z.string().nullish(),
            status: z.string().nullish(),
          })
          .partial()
          .nullish(),
      })
      .partial()
      .loose()
      .nullish(),
    error: z.unknown().optional(),
    error_code: z.string().nullish(),
  })
  .partial()
  .loose();

export function readPerson(data: unknown) {
  const candidate =
    z.object({ data: z.unknown() }).safeParse(data).data?.data ?? data;
  const person = personData.safeParse(candidate).data?.person;
  if (!person?.full_name && !person?.email?.email) return null;
  return {
    name: person.full_name ?? null,
    title: person.current_job_title ?? null,
    linkedinUrl: person.linkedin_url ?? null,
    email: person.email?.email ?? null,
    mobile: person.mobile?.mobile ?? null,
  };
}

export function companyLine(
  company: NonNullable<ReturnType<typeof readCompany>>,
) {
  return [
    company.name,
    company.industry,
    company.headcount === null ? null : `${company.headcount} staff`,
    [company.city, company.country].filter(Boolean).join(", ") || null,
  ]
    .filter(Boolean)
    .join(", ");
}

export function personLine(person: NonNullable<ReturnType<typeof readPerson>>) {
  return [
    person.name,
    person.title,
    person.email ? "email found" : null,
    person.mobile ? "mobile found" : null,
  ]
    .filter(Boolean)
    .join(", ");
}
