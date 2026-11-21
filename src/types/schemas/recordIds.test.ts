import { describe, expect, it } from "vitest";
import { recordFieldsSchema } from "@/types/schemas/fields";
import { recordListsSchema } from "@/types/schemas/lists";

// HubSpot imports carry ids like hs:<org>:<portal>:companies:<11 digits>, up to
// 71 characters on Vistar's CRM (13,332 of 14,568 companies, 21 Nov 2026). A
// 64-character cap failed every field and list read on those records with
// "Check your input and try again."
const hubspotId =
  "hs:yM48gpOCmkUpX4lXzhGkmdAsvcLyIFKt:9344866:companies:60991816592";

describe("record ids", () => {
  it("accepts a HubSpot-imported company id for field values", () => {
    expect(
      recordFieldsSchema.safeParse({ entity: "COMPANY", recordId: hubspotId })
        .success,
    ).toBe(true);
  });

  it("accepts a HubSpot-imported company id for its lists", () => {
    expect(
      recordListsSchema.safeParse({ entity: "COMPANY", id: hubspotId }).success,
    ).toBe(true);
  });

  it("still refuses an id past 128 characters", () => {
    expect(
      recordFieldsSchema.safeParse({
        entity: "COMPANY",
        recordId: "x".repeat(129),
      }).success,
    ).toBe(false);
  });
});
