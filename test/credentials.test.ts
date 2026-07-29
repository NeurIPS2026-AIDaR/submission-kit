import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAuthorCredential, saveAuthorCredential } from "../src/cli/credentials.js";

describe("author credential store", () => {
  it("stores multiple self-service submissions outside the project with owner-only access", () => {
    const root = mkdtempSync(join(tmpdir(), "aidar-credentials-test-"));
    const credentials = join(root, "credentials");
    const project = join(root, "project");
    try {
      saveAuthorCredential({
        submissionId: "111111111111",
        server: "https://aidar.example/",
        projectPath: project,
        authorToken: `aidar_sub_${"a".repeat(43)}`,
        createdAt: "2026-07-29T10:00:00.000Z"
      }, credentials);
      saveAuthorCredential({
        submissionId: "222222222222",
        server: "https://aidar.example",
        projectPath: project,
        authorToken: `aidar_sub_${"b".repeat(43)}`,
        createdAt: "2026-07-29T11:00:00.000Z"
      }, credentials);

      expect(loadAuthorCredential({ server: "https://aidar.example", projectPath: project }, credentials).submissionId).toBe("222222222222");
      expect(loadAuthorCredential({ server: "https://aidar.example", submissionId: "111111111111" }, credentials).authorToken).toBe(`aidar_sub_${"a".repeat(43)}`);
      expect(statSync(credentials).mode & 0o777).toBe(0o700);
      expect(statSync(join(credentials, "credentials.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(credentials, "credentials.json"), "utf8")).not.toContain("author name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
