import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { AIDaRDatabase } from "../src/database.js";
import { MockGithubGateway } from "../src/github/mock.js";
import { AIDaRService } from "../src/service.js";
import { packageProject } from "../src/cli/client.js";

const tempRoot = mkdtempSync(join(tmpdir(), "aidar-local-pilot-"));
const database = new AIDaRDatabase(":memory:");

try {
  const config = loadConfig({
    databasePath: ":memory:",
    tempRoot,
    tokenHmacSecret: "local-pilot-hmac-secret-with-sufficient-length",
    adminToken: "local-pilot-admin",
    githubMode: "mock"
  });
  const github = new MockGithubGateway(database);
  const service = new AIDaRService(database, github, config);
  const fixture = resolve("test/fixtures/valid-submission");
  const packageOptions = { privacyStoreDirectory: join(tempRoot, "privacy"), tempRoot };
  const initialPackage = await packageProject(fixture, packageOptions);

  const first = service.createSubmission("OPENREVIEW-PILOT-001");
  await service.submit(first.author_token, initialPackage.archive, initialPackage.digest, "pilot-initial-1");
  await service.assignReviewer(first.submission_id, "reviewer-one");
  const formalId = github.injectReview(first.submission_id, "reviewer-one", {
    type: "review",
    state: "CHANGES_REQUESTED",
    body: "Clarify the mapping from the manuscript claim to the result."
  });
  github.injectReview(first.submission_id, "reviewer-one", {
    type: "inline_comment",
    path: "claims/claims.json",
    line: 7,
    body: "Add the analysis file to this evidence link."
  });
  github.injectReview(first.submission_id, "reviewer-one", {
    type: "comment",
    body: "The artifact layout is easy to inspect."
  });
  const relayedReviews = await service.reviews(first.author_token);
  await service.respond(first.author_token, "The revision adds a direct result-to-code link.", formalId);

  const revisionRoot = join(tempRoot, "revision");
  cpSync(fixture, revisionRoot, { recursive: true });
  unlinkSync(join(revisionRoot, "results", "obsolete.txt"));
  writeFileSync(join(revisionRoot, "results", "revision.json"), "{\"revision\":2,\"claim_id\":\"claim-1\"}\n");
  const revisionPackage = await packageProject(revisionRoot, packageOptions);
  await service.revise(first.author_token, revisionPackage.archive, revisionPackage.digest, "pilot-revision-1");

  const second = service.createSubmission("OPENREVIEW-PILOT-002");
  await service.submit(second.author_token, initialPackage.archive, initialPackage.digest, "pilot-initial-2");
  await service.assignReviewer(second.submission_id, "reviewer-two");

  const firstRepo = github.repositories.get(first.submission_id)!;
  const evidence = {
    result: "PASS",
    github_mode: "mock",
    submissions: 2,
    first_submission_id: first.submission_id,
    checks: {
      author_used_no_github_credential: true,
      opaque_repository_name: firstRepo.name === `submission-${first.submission_id}`,
      actions_disabled: firstRepo.actionsEnabled === false,
      pull_request_opened: firstRepo.pullNumber === 1,
      relayed_review_items: relayedReviews.reviews.length,
      author_response_posted_by_relay: firstRepo.responses.length === 1,
      revision_number: service.getSubmission(first.submission_id).revision,
      deleted_file_absent_after_revision: !firstRepo.files.has("results/obsolete.txt"),
      new_file_present_after_revision: firstRepo.files.has("results/revision.json"),
      reviewer_one_cannot_read_second: !github.canAccess(second.submission_id, "reviewer-one"),
      reviewer_two_cannot_read_first: !github.canAccess(first.submission_id, "reviewer-two")
    },
    operation_sequence: github.operations
  };
  if (Object.values(evidence.checks).some((value) => value === false)) throw new Error("One or more local pilot checks failed");
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  database.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
