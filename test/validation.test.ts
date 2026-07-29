import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/cli/client.js";
import { validateProject } from "../src/validation.js";

const fixture = resolve("test/fixtures/valid-submission");
const roots: string[] = [];

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "aidar-validation-test-"));
  roots.push(root);
  cpSync(fixture, root, { recursive: true });
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("package validation", () => {
  it("accepts the anonymous fixture", () => {
    const result = validateProject(fixture, { limits: DEFAULT_LIMITS });
    expect(result.report.valid).toBe(true);
    expect(result.files).toContain("manuscript/paper.pdf");
  });

  it("accepts arbitrary regular-file submissions without a manifest or manuscript", () => {
    const root = mkdtempSync(join(tmpdir(), "aidar-validation-test-"));
    roots.push(root);
    writeFileSync(join(root, "anything.txt"), "A research artifact.\n");
    const result = validateProject(root, { limits: DEFAULT_LIMITS, identityTerms: [] });
    expect(result.report.valid).toBe(true);
    expect(result.files).toEqual(["anything.txt"]);
    expect(result.report.findings.some((finding) => finding.rule === "required_file")).toBe(false);
  });

  it("rejects an empty submission as an operational error", () => {
    const root = mkdtempSync(join(tmpdir(), "aidar-validation-test-"));
    roots.push(root);
    const result = validateProject(root, { limits: DEFAULT_LIMITS, identityTerms: [] });
    expect(result.report.valid).toBe(false);
    expect(result.report.findings).toContainEqual(expect.objectContaining({ level: "FAIL", rule: "empty_submission" }));
  });

  it("excludes local Git history and the local identity file", () => {
    const root = copyFixture();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "user email value");
    writeFileSync(join(root, ".aidar-private-identities.txt"), "Private Lab\n");
    const result = validateProject(root, { limits: DEFAULT_LIMITS });
    expect(result.report.valid).toBe(true);
    expect(result.files.some((path) => path.startsWith(".git"))).toBe(false);
    expect(result.files).not.toContain(".aidar-private-identities.txt");
  });

  it.each([
    ["workflow", (root: string) => { mkdirSync(join(root, ".github", "workflows"), { recursive: true }); writeFileSync(join(root, ".github", "workflows", "run.yml"), "on: push\n"); }, "github_workflow"],
    ["secret", (root: string) => writeFileSync(join(root, "README.md"), `-----BEGIN ${"PRIVATE KEY"}-----\n`), "private_key"]
  ])("rejects %s", (_label, mutate, rule) => {
    const root = copyFixture();
    mutate(root);
    const result = validateProject(root, { limits: DEFAULT_LIMITS });
    expect(result.report.valid).toBe(false);
    expect(result.report.findings.some((finding) => finding.rule === rule && finding.level === "FAIL")).toBe(true);
  });

  it.each([
    ["identity term", (root: string) => { writeFileSync(join(root, ".aidar-private-identities.txt"), "Private Lab\n"); writeFileSync(join(root, "README.md"), "Private Lab result\n"); }, "identity_redaction_planned"],
    ["email", (root: string) => writeFileSync(join(root, "README.md"), "Contact person@example.org\n"), "email_redaction_planned"],
    ["home path", (root: string) => writeFileSync(join(root, "README.md"), "Path: /Users/private/project\n"), "home_path_redaction_planned"]
  ])("plans redaction for %s instead of rejecting the source", (_label, mutate, rule) => {
    const root = copyFixture();
    mutate(root);
    const result = validateProject(root, { limits: DEFAULT_LIMITS });
    expect(result.report.valid).toBe(true);
    expect(result.report.findings.some((finding) => finding.rule === rule && finding.level === "WARN")).toBe(true);
  });

  it("treats an unsupported binary as explicitly uninspected", () => {
    const root = copyFixture();
    writeFileSync(join(root, "opaque.bin"), Buffer.from([0xff, 0x00, 0x81]));
    const result = validateProject(root, { limits: DEFAULT_LIMITS, identityTerms: [] });
    expect(result.report.valid).toBe(true);
    expect(result.unsupportedBinaryFiles).toContain("opaque.bin");
    expect(result.report.findings).toContainEqual(expect.objectContaining({ level: "WARN", rule: "unsupported_binary", path: "opaque.bin" }));
  });

  it("allows a nested archive as an opaque artifact", () => {
    const root = copyFixture();
    writeFileSync(join(root, "results.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    const result = validateProject(root, { limits: DEFAULT_LIMITS, identityTerms: [] });
    expect(result.report.valid).toBe(true);
    expect(result.files).toContain("results.zip");
    expect(result.unsupportedBinaryFiles).toContain("results.zip");
  });

  it("rejects unredacted privacy patterns in server mode", () => {
    const root = copyFixture();
    writeFileSync(join(root, "README.md"), "Contact person@example.org\n");
    const result = validateProject(root, { limits: DEFAULT_LIMITS, serverMode: true });
    expect(result.report.valid).toBe(false);
    expect(result.report.findings).toContainEqual(expect.objectContaining({ level: "FAIL", rule: "email_address" }));
  });

  it("rejects a symbolic link", () => {
    const root = copyFixture();
    symlinkSync(join(root, "README.md"), join(root, "linked-readme"));
    const result = validateProject(root, { limits: DEFAULT_LIMITS });
    expect(result.report.findings.some((finding) => finding.rule === "symlink")).toBe(true);
  });

  it("rejects hard-linked files", () => {
    const root = copyFixture();
    linkSync(join(root, "README.md"), join(root, "linked-readme"));
    const result = validateProject(root, { limits: DEFAULT_LIMITS });
    expect(result.report.findings.some((finding) => finding.rule === "hard_link")).toBe(true);
  });
});
