import { expect, it, vi } from "vitest";
import { readArchived } from "./hubspot-archived";
import { HubspotReader } from "./hubspot-reader";

it("keeps the archived IDs omitted by HubSpot batch/read, with every property group (17 Nov regression)", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method !== "GET")
      return Response.json(
        { results: [{ id: "1" }], errors: [{ category: "OBJECT_NOT_FOUND" }] },
        { status: 207 },
      );
    const url = new URL(input instanceof Request ? input.url : input);
    const names = (url.searchParams.get("properties") ?? "").split(",");
    return Response.json({
      results: ["1", "2"].map((id) => ({
        id,
        archived: true,
        properties: Object.fromEntries(
          names.map((name) => [name, `${id}-${name}`]),
        ),
      })),
    });
  });
  const reader = new HubspotReader("synthetic-token", {
    fetcher,
    delay: async () => {},
  });
  const pages = [];
  for await (const page of readArchived(
    reader,
    "deals",
    Array.from({ length: 209 }, (_, i) => `property_${i}`),
  ))
    pages.push(page);
  expect(pages[0]).toHaveLength(2);
  expect(pages[0]?.[1]?.properties?.property_208).toBe("2-property_208");
  expect(Object.keys(pages[0]?.[1]?.properties ?? {})).toHaveLength(209);
  expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
    true,
  );
});
