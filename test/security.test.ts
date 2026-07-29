import { describe, expect, it } from "vitest";
import { createSubmissionToken, redactError, tokenHmac } from "../src/security.js";

describe("token security", () => {
  it("generates high-entropy scoped token material and stores only an HMAC", () => {
    const token = createSubmissionToken();
    const verifier = tokenHmac(token, "server-secret");
    expect(token).toMatch(/^aidar_sub_[A-Za-z0-9_-]{43}$/);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(verifier).not.toContain(token);
    expect(tokenHmac(token, "other-secret")).not.toBe(verifier);
  });

  it("redacts error detail for logs", () => {
    expect(redactError(new Error("secret value"))).toBe("Error");
  });
});
