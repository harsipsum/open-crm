import {
  dealListSearchSchema,
  type DealListSearch,
} from "@/client/features/deals/dealSearch";
import {
  appSearchSchema,
  parseStack,
} from "@/client/features/records/recordStack";
import type { ContextSnapshot } from "@/client/lib/everyapp-context";

// What the CRM tells the page framing it (src/client/lib/everyapp-context.ts):
// the page, the record on top of the sheets, and on /deals the list's
// filters. Read from the URL, which holds all three.

/**
 * The deals list's filters the framing page hears: fixed choices and member
 * ids. Never the search text or custom field values, which are free text.
 */
export const CRM_CONTEXT_FILTERS = [
  "status",
  "stage",
  "closing",
  "owner",
  "archived",
] as const;

/** What is open, from the router's location. */
export function crmAgentContext(location: {
  pathname: string;
  search: object;
}): ContextSnapshot {
  const top = parseStack(appSearchSchema.parse(location.search).record).at(-1);
  return {
    route: location.pathname,
    selection: top ? { kind: top.kind, id: top.id } : null,
    filters:
      location.pathname === "/deals"
        ? dealFilters(dealListSearchSchema.parse(location.search))
        : {},
  };
}

/** The filters set, as text: a list's choices joined by commas. */
function dealFilters(search: DealListSearch): Record<string, string> {
  const values = {
    status: search.status,
    stage: search.stage?.join(","),
    closing: search.closing?.join(","),
    owner: search.owner?.join(","),
    archived: search.archived ? "true" : undefined,
  } satisfies Record<(typeof CRM_CONTEXT_FILTERS)[number], string | undefined>;
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}
