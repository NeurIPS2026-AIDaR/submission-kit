import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AIDaRDatabase } from "../src/database.js";

describe("database security", () => {
  it("limits the database file to its owner", () => {
    const root = mkdtempSync(join(tmpdir(), "aidar-database-test-"));
    const path = join(root, "aidar.sqlite");
    const database = new AIDaRDatabase(path);

    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
