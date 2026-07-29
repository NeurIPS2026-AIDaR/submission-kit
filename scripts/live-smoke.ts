import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { AIDaRDatabase } from "../src/database.js";
import { LiveGithubGateway } from "../src/github/live.js";
import { AIDaRService } from "../src/service.js";
import { packageProject } from "../src/cli/client.js";

if (process.env.AIDAR_LIVE_CONFIRM !== "CREATE_TEST_REPOSITORIES") {
  throw new Error("Set AIDAR_LIVE_CONFIRM=CREATE_TEST_REPOSITORIES to authorize live test repository creation");
}
if (process.env.AIDAR_GITHUB_MODE !== "live") throw new Error("Set AIDAR_GITHUB_MODE=live");
const reviewerOne = process.env.AIDAR_LIVE_REVIEWER_ONE;
const reviewerTwo = process.env.AIDAR_LIVE_REVIEWER_TWO;
if (!reviewerOne) throw new Error("Set AIDAR_LIVE_REVIEWER_ONE to a known test account");

const config = loadConfig();
const database = new AIDaRDatabase(config.databasePath);
const github = new LiveGithubGateway(config.github!);
const service = new AIDaRService(database, github, config);
const fixture = resolve("test/fixtures/valid-submission");
const packageData = await packageProject(fixture);
const scratch = mkdtempSync(join(tmpdir(), "aidar-live-smoke-"));

try {
  const first = service.createSubmission("LIVE-SMOKE-001");
  await service.submit(first.author_token, packageData.archive, packageData.digest, "live-initial-1");
  await service.assignReviewer(first.submission_id, reviewerOne);

  const firstAdmin = service.adminStatus(first.submission_id);
  let secondSummary: Record<string, unknown> | undefined;
  if (reviewerTwo) {
    const second = service.createSubmission("LIVE-SMOKE-002");
    await service.submit(second.author_token, packageData.archive, packageData.digest, "live-initial-2");
    await service.assignReviewer(second.submission_id, reviewerTwo);
    const secondAdmin = service.adminStatus(second.submission_id);
    secondSummary = { submission_id: second.submission_id, repository: secondAdmin.repository, reviewer: reviewerTwo };
  }
  process.stdout.write(`${JSON.stringify({
    phase: "WAITING_FOR_HUMAN_REVIEW",
    first: { submission_id: first.submission_id, repository: firstAdmin.repository, reviewer: reviewerOne },
    second: secondSummary,
    required_manual_checks: [
      reviewerTwo ? "Accept both collaborator invitations." : "Confirm the named reviewer has repository access.",
      reviewerTwo ? "Confirm that each reviewer cannot open the other repository." : "Cross-repository isolation is not tested in single-repository mode.",
      "Submit one review on the first pull request.",
      "Confirm that Actions is disabled and that the App bot owns the submission commit."
    ]
  }, null, 2)}\n`);

  const waitMs = Number(process.env.AIDAR_LIVE_WAIT_MS ?? 1_800_000);
  const deadline = Date.now() + waitMs;
  let reviews = await service.reviews(first.author_token);
  while (!reviews.reviews.length && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
    reviews = await service.reviews(first.author_token);
  }
  if (!reviews.reviews.length) throw new Error("No live review arrived before AIDAR_LIVE_WAIT_MS expired");

  await service.respond(first.author_token, "The anonymous author received this review through the AIDaR relay.");
  const revisionRoot = join(scratch, "revision");
  cpSync(fixture, revisionRoot, { recursive: true });
  unlinkSync(join(revisionRoot, "results", "obsolete.txt"));
  writeFileSync(join(revisionRoot, "results", "live-revision.json"), "{\"revision\":2}\n");
  const revision = await packageProject(revisionRoot);
  await service.revise(first.author_token, revision.archive, revision.digest, "live-revision-1");
  process.stdout.write(`${JSON.stringify({
    phase: "LIVE_LOOP_COMPLETE",
    submission_id: first.submission_id,
    repository: firstAdmin.repository,
    pull_request_number: 1,
    review_items_relayed: reviews.reviews.length,
    revision: service.getSubmission(first.submission_id).revision,
    next: "Inspect the pull request, confirm file deletion, remove reviewer access, and remove the test repositories after evidence capture."
  }, null, 2)}\n`);
} finally {
  database.close();
  rmSync(scratch, { recursive: true, force: true });
}
