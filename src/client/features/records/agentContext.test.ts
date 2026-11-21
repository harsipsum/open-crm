import { describe, expect, it } from "vitest";
import {
  crmAgentContext,
  crmAppKey,
} from "@/client/features/records/agentContext";

describe("crmAppKey", () => {
  it("is the hostname's first label, so a staging copy names itself", () => {
    expect(crmAppKey("crm.apps.ralveto.com")).toBe("crm");
    expect(crmAppKey("crmlab.apps.ralveto.com")).toBe("crmlab");
    expect(crmAppKey("localhost")).toBe("crm");
    expect(crmAppKey("127.0.0.1")).toBe("crm");
    expect(crmAppKey("bad_label.apps.ralveto.com")).toBe("crm");
  });
});

describe("what the CRM tells the page framing it", () => {
  it("names the record on top of the sheets and, on /deals, the list's filters but not its search text", () => {
    expect(
      crmAgentContext({
        pathname: "/deals",
        search: {
          record: "company:c1,deal:d1",
          tab: "activity",
          q: "acme",
          fields: { region: { contains: "north" } },
          owner: ["u1", "u2"],
          status: "open",
          stage: ["DEMO_BOOKED", "CONTRACT_SENT"],
          closing: [],
          page: 2,
        },
      }),
    ).toEqual({
      route: "/deals",
      selection: { kind: "deal", id: "d1" },
      filters: {
        status: "open",
        stage: "DEMO_BOOKED,CONTRACT_SENT",
        owner: "u1,u2",
      },
    });

    // Another page: its open sheet, no deal filters; nothing open is null.
    expect(
      crmAgentContext({
        pathname: "/companies",
        search: { record: "contact:p1", stage: ["DEMO_BOOKED"] },
      }),
    ).toEqual({
      route: "/companies",
      selection: { kind: "contact", id: "p1" },
      filters: {},
    });
    expect(
      crmAgentContext({ pathname: "/deals", search: { stage: ["NOPE"] } }),
    ).toEqual({ route: "/deals", selection: null, filters: {} });
  });
});
