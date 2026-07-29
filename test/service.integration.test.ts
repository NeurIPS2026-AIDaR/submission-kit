import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AIDaRDatabase } from "../src/database.js";
import { MockGithubGateway } from "../src/github/mock.js";
import { AIDaRService } from "../src/service.js";
import { packageProject } from "../src/cli/client.js";
import { buildApi } from "../src/api.js";

const roots: string[] = [];
const databases: AIDaRDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "aidar-service-test-"));
  roots.push(root);
  const config = loadConfig({
    databasePath: ":memory:",
    tempRoot: root,
    tokenHmacSecret: "test-hmac-secret-that-is-long-enough",
    adminToken: "test-admin-token",
    githubMode: "mock"
  });
  const database = new AIDaRDatabase(":memory:");
  databases.push(database);
  const github = new MockGithubGateway(database);
  return { root, config, database, github, service: new AIDaRService(database, github, config) };
}

describe("private review loop", () => {
  it("submits, isolates, reviews, responds, revises, and publishes", async () => {
    const { root, database, github, service } = harness();
    const packageOne = await packageProject(resolve("test/fixtures/valid-submission"), { privacyStoreDirectory: join(root, "privacy"), tempRoot: root });
    const slot = service.createSubmission("OPENREVIEW-TEST-001");
    const submitted = await service.submit(slot.author_token, packageOne.archive, packageOne.digest, "initial-key");
    expect(submitted.status).toBe("under_review");
    expect(github.operations.slice(0, 6)).toEqual([
      "create_private_repository", "disable_actions", "write_review_shell",
      "create_submission_branch", "create_snapshot_commit", "open_pull_request"
    ]);

    const operationCount = github.operations.length;
    const replay = await service.submit(slot.author_token, packageOne.archive, packageOne.digest, "initial-key");
    expect(replay).toEqual(submitted);
    expect(github.operations).toHaveLength(operationCount);
    await expect(service.submit(slot.author_token, packageOne.archive, packageOne.digest, "new-key")).rejects.toThrow("already exists");

    await service.assignReviewer(slot.submission_id, "reviewer-one");
    const reviewId = github.injectReview(slot.submission_id, "reviewer-one", {
      type: "inline_comment",
      path: "results/metrics.json",
      line: 2,
      body: "Explain how this value maps to the manuscript."
    });
    const reviews = await service.reviews(slot.author_token);
    expect(reviews.reviews[0]).toMatchObject({ id: reviewId, reviewer_login: "reviewer-one", path: "results/metrics.json" });
    await service.respond(slot.author_token, "The result and claim now use the same identifier.", reviewId);
    expect(github.repositories.get(slot.submission_id)?.responses).toHaveLength(1);
    await expect(service.respond(slot.author_token, "Contact person@example.org")).rejects.toThrow("privacy checks");

    const revisedRoot = join(root, "revision");
    cpSync(resolve("test/fixtures/valid-submission"), revisedRoot, { recursive: true });
    unlinkSync(join(revisedRoot, "results", "obsolete.txt"));
    writeFileSync(join(revisedRoot, "results", "revision.json"), "{\"revision\":2}\n");
    const revision = await packageProject(revisedRoot, { privacyStoreDirectory: join(root, "privacy"), tempRoot: root });
    const revised = await service.revise(slot.author_token, revision.archive, revision.digest, "revision-key");
    expect(revised.revision).toBe(2);
    const repo = github.repositories.get(slot.submission_id)!;
    expect(repo.files.has("results/obsolete.txt")).toBe(false);
    expect(repo.files.has("results/revision.json")).toBe(true);

    const second = service.createSubmission("OPENREVIEW-TEST-002");
    await service.submit(second.author_token, packageOne.archive, packageOne.digest, "second-initial-key");
    await service.assignReviewer(second.submission_id, "reviewer-two");
    expect(github.canAccess(slot.submission_id, "reviewer-two")).toBe(false);
    expect(github.canAccess(second.submission_id, "reviewer-one")).toBe(false);
    expect(() => github.injectReview(slot.submission_id, "reviewer-two", { body: "unauthorized" })).toThrow("does not have access");

    await service.decide(slot.submission_id, "accepted");
    const published = await service.publish(slot.submission_id, revision.archive, revision.digest, "pilot-paper");
    expect(published.publication_pull_request_number).toBe(1);

    const stored = database.raw.prepare("SELECT author_token_hmac FROM submissions WHERE id = ?").get(slot.submission_id) as { author_token_hmac: string };
    expect(stored.author_token_hmac).not.toContain(slot.author_token);
  });

  it("keeps private repository coordinates out of the author API", async () => {
    const { config, service } = harness();
    const app = await buildApi(service, config);
    const registration = await app.inject({
      method: "POST",
      url: "/v1/author/submissions",
      payload: { openreview_url: "https://openreview.net/forum?id=API_TEST_001" }
    });
    expect(registration.statusCode).toBe(200);
    const slot = registration.json() as { submission_id: string; author_token: string };
    expect(slot.submission_id).toMatch(/^[0-9a-f]{12}$/);
    expect(slot.author_token).toMatch(/^aidar_sub_/);
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/author/submissions",
      payload: { openreview_url: "https://openreview.net/forum?id=API_TEST_001#discussion" }
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: expect.stringContaining("already has") });
    const packaged = await packageProject(resolve("test/fixtures/valid-submission"), { privacyStoreDirectory: join(config.tempRoot, "privacy"), tempRoot: config.tempRoot });
    await service.submit(slot.author_token, packaged.archive, packaged.digest, "api-key");
    const response = await app.inject({ method: "GET", url: "/v1/author/status", headers: { authorization: `Bearer ${slot.author_token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("repository");
    expect(response.body).not.toContain("submission-");
    const invalid = await app.inject({ method: "GET", url: "/v1/author/status", headers: { authorization: "Bearer invalid" } });
    expect(invalid.statusCode).toBe(401);
    await app.close();
  });
});
