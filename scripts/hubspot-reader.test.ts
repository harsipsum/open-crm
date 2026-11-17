import { describe, expect, it, vi } from "vitest";
import { HubspotReader } from "./hubspot-reader";

describe("HubSpot read-only migration API", () => {
  it("refuses a mutation before calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reader = new HubspotReader("synthetic-token", { fetcher });
    await expect(
      reader.request("/crm/v3/objects/contacts", { properties: {} }),
    ).rejects.toThrow("write refused");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("backs off on rate limits and stops at the configured call cap", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { policyName: "SECONDLY" },
          { status: 429, headers: { "retry-after": "2" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const delay = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    const reader = new HubspotReader("synthetic-token", {
      fetcher,
      delay,
      maxRequests: 2,
    });
    await reader.request("/crm/v3/owners/");
    expect(delay).toHaveBeenCalledWith(2000);
    expect(reader.calls).toBe(2);
    await expect(reader.request("/crm/v3/owners/")).rejects.toThrow(
      "cap reached",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("stops before consuming the reserved daily headroom", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { results: [] },
          { headers: { "x-hubspot-ratelimit-daily-remaining": "999" } },
        ),
      );
    const reader = new HubspotReader("synthetic-token", { fetcher });
    await expect(reader.request("/crm/v3/owners/")).rejects.toThrow("headroom");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
