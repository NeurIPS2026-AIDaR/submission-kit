import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { safeExtractArchive } from "../src/archive.js";
import { DEFAULT_LIMITS, packageProject } from "../src/cli/client.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function maliciousArchive(name: string): Promise<Buffer> {
  const pack = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const output = pack.pipe(gzip);
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolvePromise, reject) => {
    output.on("end", resolvePromise);
    output.on("error", reject);
  });
  pack.entry({ name }, "bad");
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe("deterministic and safe archives", () => {
  it("creates the same digest for the same package", async () => {
    const privacy = mkdtempSync(join(tmpdir(), "aidar-privacy-test-"));
    roots.push(privacy);
    const first = await packageProject(resolve("test/fixtures/valid-submission"), { privacyStoreDirectory: privacy });
    const second = await packageProject(resolve("test/fixtures/valid-submission"), { privacyStoreDirectory: privacy });
    expect(first.digest).toBe(second.digest);
    expect(first.archive.equals(second.archive)).toBe(true);
  });

  it.each(["../escape", "/absolute", "a/../escape", ".git/config", ".github/workflows/run.yml", "bad\u001bname"])("rejects unsafe archive path %s", async (name) => {
    const root = mkdtempSync(join(tmpdir(), "aidar-extract-test-"));
    roots.push(root);
    await expect(safeExtractArchive(await maliciousArchive(name), root, DEFAULT_LIMITS)).rejects.toThrow();
  });

  it("extracts the valid deterministic package", async () => {
    const privacy = mkdtempSync(join(tmpdir(), "aidar-privacy-test-"));
    roots.push(privacy);
    const packaged = await packageProject(resolve("test/fixtures/valid-submission"), { privacyStoreDirectory: privacy });
    const root = mkdtempSync(join(tmpdir(), "aidar-extract-test-"));
    roots.push(root);
    const files = await safeExtractArchive(packaged.archive, root, DEFAULT_LIMITS);
    expect(files).toContain("aidar.yaml");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("Anonymous AIDaR");
  });

  it("redacts only a temporary snapshot, keeps aliases stable, and emits a term-safe report", async () => {
    const root = mkdtempSync(join(tmpdir(), "aidar-redaction-test-"));
    roots.push(root);
    const project = join(root, "project");
    const privacy = join(root, "owner-only");
    mkdirSync(project);
    writeFileSync(join(project, ".aidar-private-identities.txt"), "Dr Ada\n");
    writeFileSync(join(project, "Dr Ada notes.txt"), "Dr Ada can be reached at ada@example.org.\n");
    writeFileSync(join(project, "opaque.bin"), Buffer.from([0xff, 0x00, 0x81]));

    const first = await packageProject(project, { privacyStoreDirectory: privacy, tempRoot: root });
    const firstExtract = join(root, "first");
    const firstFiles = await safeExtractArchive(first.archive, firstExtract, DEFAULT_LIMITS);
    const redactedName = firstFiles.find((file) => file.endsWith(" notes.txt"));
    expect(redactedName).toBeTruthy();
    const redactedText = readFileSync(join(firstExtract, redactedName!), "utf8");
    expect(redactedName).not.toContain("Dr Ada");
    expect(redactedText).not.toContain("Dr Ada");
    expect(redactedText).not.toContain("ada@example.org");
    expect(redactedText).toMatch(/aidar-identity-[0-9a-f]{12}/);
    expect(redactedText).toMatch(/aidar-email-[0-9a-f]{12}/);
    expect(firstFiles).not.toContain(".aidar-private-identities.txt");
    expect(readFileSync(join(project, "Dr Ada notes.txt"), "utf8")).toContain("Dr Ada");
    expect(first.summary).not.toContain("Dr Ada");
    expect(first.summary).not.toContain("ada@example.org");
    expect(first.summary).toContain("unsupported_or_uninspected=1");

    writeFileSync(join(project, "revision.txt"), "A second mention of Dr Ada.\n");
    const second = await packageProject(project, { privacyStoreDirectory: privacy, tempRoot: root });
    const secondExtract = join(root, "second");
    await safeExtractArchive(second.archive, secondExtract, DEFAULT_LIMITS);
    const secondText = readFileSync(join(secondExtract, "revision.txt"), "utf8");
    expect(secondText.match(/aidar-identity-[0-9a-f]{12}/)?.[0]).toBe(redactedText.match(/aidar-identity-[0-9a-f]{12}/)?.[0]);
    expect(statSync(privacy).mode & 0o777).toBe(0o700);
    expect(statSync(join(privacy, "redactions.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(project)).not.toContain("redactions.json");
  });

  it("refuses to place a redaction profile inside the submitted project", async () => {
    const root = mkdtempSync(join(tmpdir(), "aidar-profile-location-test-"));
    roots.push(root);
    writeFileSync(join(root, "notes.txt"), "Safe text.\n");
    await expect(packageProject(root, { privacyStoreDirectory: join(root, ".private") })).rejects.toThrow("outside the submitted project");
  });
});
