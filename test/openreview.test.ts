import { describe, expect, it } from "vitest";
import { normalizeOpenReviewUrl } from "../src/openreview.js";

describe("OpenReview forum URL", () => {
  it("normalizes an official forum URL", () => {
    expect(normalizeOpenReviewUrl("https://openreview.net/forum?id=Abc_123-xyz#discussion"))
      .toBe("https://openreview.net/forum?id=Abc_123-xyz");
  });

  it.each([
    "",
    "http://openreview.net/forum?id=Abc_123",
    "https://example.org/forum?id=Abc_123",
    "https://openreview.net/pdf?id=Abc_123",
    "https://openreview.net/forum?id=x"
  ])("rejects %s", (value) => {
    expect(() => normalizeOpenReviewUrl(value)).toThrow();
  });
});
