import { describe, expect, it } from "vitest";
import { serverSlug } from "./server-slug";

describe("serverSlug", () => {
  it("makes the suite name one argument the terminal command takes", () => {
    expect(serverSlug("Star OS")).toBe("star-os");
    expect(serverSlug("  ")).toBe("everyapp");
  });
});
