import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { AIDaRDatabase } from "./database.js";
import { safeExtractArchive, snapshotDirectory } from "./archive.js";
import { createSubmissionToken, sha256, tokenHmac } from "./security.js";
import { stageValidatedProject, validateProject, validateRelayText } from "./validation.js";
import { normalizeOpenReviewUrl } from "./openreview.js";
import type { GithubGateway, ReviewItem, SubmissionRecord } from "./types.js";

export class AIDaRService {
  constructor(
    readonly database: AIDaRDatabase,
    readonly github: GithubGateway,
    readonly config: AppConfig
  ) {}

  createSubmission(externalId?: string, actor = "admin"): { submission_id: string; author_token: string; status: string } {
    const id = randomBytes(6).toString("hex");
    const token = createSubmissionToken();
    const now = new Date().toISOString();
    this.database.raw.prepare(`
      INSERT INTO submissions (id, external_id, author_token_hmac, status, created_at, updated_at)
      VALUES (?, ?, ?, 'awaiting_submission', ?, ?)
    `).run(id, externalId ?? null, tokenHmac(token, this.config.tokenHmacSecret), now, now);
    this.event(id, "submission_created", actor);
    return { submission_id: id, author_token: token, status: "awaiting_submission" };
  }

  createSelfServiceSubmission(openReviewUrl: string): { submission_id: string; author_token: string; status: string } {
    const normalized = normalizeOpenReviewUrl(openReviewUrl);
    try {
      return this.createSubmission(normalized, "self_service");
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: submissions\.external_id/.test(error.message)) {
        throw new Error("This OpenReview forum URL already has an AIDaR submission; use the saved credential to revise it");
      }
      throw error;
    }
  }

  authenticateAuthor(token: string): SubmissionRecord {
    const record = this.database.raw.prepare("SELECT * FROM submissions WHERE author_token_hmac = ?").get(tokenHmac(token, this.config.tokenHmacSecret)) as unknown as SubmissionRecord | undefined;
    if (!record || record.revoked_at) throw new Error("Invalid or revoked author token");
    return record;
  }

  getSubmission(id: string): SubmissionRecord {
    const record = this.database.raw.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as unknown as SubmissionRecord | undefined;
    if (!record) throw new Error("Submission does not exist");
    return record;
  }

  revokeToken(id: string): void {
    this.getSubmission(id);
    const now = new Date().toISOString();
    this.database.raw.prepare("UPDATE submissions SET revoked_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    this.event(id, "author_token_revoked", "admin");
  }

  async submit(token: string, archive: Buffer, claimedDigest: string, idempotencyKey: string): Promise<Record<string, unknown>> {
    const record = this.authenticateAuthor(token);
    const replay = this.idempotencyRecord(idempotencyKey);
    if (replay) {
      if (replay.submission_id !== record.id || !JSON.parse(replay.response_json).repository_created) throw new Error("Idempotency key belongs to a different request");
      return this.ingest(record, archive, claimedDigest, idempotencyKey, false);
    }
    if (record.revision !== 0) throw new Error("Initial submission already exists; use revise");
    return this.ingest(record, archive, claimedDigest, idempotencyKey, false);
  }

  async revise(token: string, archive: Buffer, claimedDigest: string, idempotencyKey: string): Promise<Record<string, unknown>> {
    const record = this.authenticateAuthor(token);
    const replay = this.idempotencyRecord(idempotencyKey);
    if (replay) {
      const response = JSON.parse(replay.response_json) as Record<string, unknown>;
      if (replay.submission_id !== record.id || Number(response.revision) < 2) throw new Error("Idempotency key belongs to a different request");
      return this.ingest(record, archive, claimedDigest, idempotencyKey, true);
    }
    if (record.revision < 1) throw new Error("Initial submission does not exist; use submit");
    if (record.status !== "under_review") throw new Error("Submission is not open for revision");
    return this.ingest(record, archive, claimedDigest, idempotencyKey, true);
  }

  private async ingest(record: SubmissionRecord, archive: Buffer, claimedDigest: string, idempotencyKey: string, revision: boolean): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{64}$/i.test(claimedDigest)) throw new Error("Package digest is invalid");
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("A valid Idempotency-Key is required");
    const digest = sha256(archive);
    if (digest !== claimedDigest.toLowerCase()) throw new Error("Package digest does not match the received archive");
    const prior = this.idempotencyRecord(idempotencyKey);
    if (prior) {
      if (prior.submission_id !== record.id) throw new Error("Idempotency key belongs to another submission");
      if (prior.request_sha256 !== digest) throw new Error("Idempotency key was reused with a different package");
      return JSON.parse(prior.response_json) as Record<string, unknown>;
    }

    const extraction = mkdtempSync(join(this.config.tempRoot, "aidar-upload-"));
    let serverStage: string | undefined;
    try {
      await safeExtractArchive(archive, extraction, this.config.limits);
      const validation = validateProject(extraction, { limits: this.config.limits, tempRoot: this.config.tempRoot, serverMode: true });
      if (!validation.report.valid) {
        const rules = validation.report.findings.filter((finding) => finding.level === "FAIL").map((finding) => finding.rule);
        throw new Error(`Server validation failed: ${[...new Set(rules)].join(", ")}`);
      }
      serverStage = stageValidatedProject(validation, { limits: this.config.limits, tempRoot: this.config.tempRoot, serverMode: true });
      const stageValidation = validateProject(serverStage, { limits: this.config.limits, tempRoot: this.config.tempRoot, serverMode: true });
      const files = stageValidation.files;
      const snapshot = snapshotDirectory(serverStage, files, digest);
      const nextRevision = revision ? record.revision + 1 : 1;
      let result: Record<string, unknown>;
      if (revision) {
        const githubResult = await this.github.revise(record, snapshot, nextRevision);
        result = { submission_id: record.id, status: "under_review", revision: nextRevision, package_sha256: digest };
        this.database.raw.prepare(`UPDATE submissions SET branch_head_sha = ?, revision = ?, package_sha256 = ?, updated_at = ? WHERE id = ?`)
          .run(githubResult.headSha, nextRevision, digest, new Date().toISOString(), record.id);
        this.event(record.id, "revision_submitted", "author", githubResult.headSha, digest);
      } else {
        const githubResult = await this.github.createSubmission(record.id, snapshot);
        result = { submission_id: record.id, status: "under_review", revision: 1, package_sha256: digest, repository_created: true, pull_request_number: githubResult.pullNumber };
        this.database.raw.prepare(`
          UPDATE submissions SET status = 'under_review', repo_id = ?, repo_name = ?, pr_number = ?, branch_head_sha = ?, revision = 1, package_sha256 = ?, updated_at = ? WHERE id = ?
        `).run(githubResult.repoId, githubResult.repoName, githubResult.pullNumber, githubResult.headSha, digest, new Date().toISOString(), record.id);
        this.event(record.id, "initial_submission", "author", githubResult.headSha, digest);
      }
      this.database.raw.prepare(`INSERT INTO idempotency_keys (key, submission_id, request_sha256, response_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(idempotencyKey, record.id, digest, JSON.stringify(result), new Date().toISOString());
      return result;
    } finally {
      rmSync(extraction, { recursive: true, force: true });
      if (serverStage) rmSync(serverStage, { recursive: true, force: true });
    }
  }

  status(token: string): Record<string, unknown> {
    const record = this.authenticateAuthor(token);
    return { submission_id: record.id, status: record.status, revision: record.revision, package_sha256: record.package_sha256, updated_at: record.updated_at };
  }

  async reviews(token: string): Promise<{ submission_id: string; reviews: ReviewItem[] }> {
    const record = this.authenticateAuthor(token);
    if (record.revision < 1) throw new Error("Submission has not been uploaded");
    return { submission_id: record.id, reviews: await this.github.listReviews(record) };
  }

  async respond(token: string, body: string, replyTo?: number | null): Promise<Record<string, unknown>> {
    const record = this.authenticateAuthor(token);
    if (record.status !== "under_review") throw new Error("Submission is not open for author responses");
    const bytes = Buffer.byteLength(body, "utf8");
    if (!body.trim() || bytes > this.config.limits.maxResponseBytes) throw new Error("Response is empty or exceeds the configured limit");
    const unsafeRules = validateRelayText(body).filter((finding) => finding.level === "FAIL").map((finding) => finding.rule);
    if (unsafeRules.length) throw new Error(`Author response failed privacy checks: ${[...new Set(unsafeRules)].join(", ")}`);
    const commentId = await this.github.postResponse(record, body, replyTo);
    this.database.raw.prepare(`INSERT INTO responses (id, submission_id, github_comment_id, reply_to_review_comment_id, body_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), record.id, commentId, replyTo ?? null, sha256(body), new Date().toISOString());
    this.event(record.id, "author_response", "author", String(commentId), sha256(body));
    return { submission_id: record.id, posted: true, github_comment_id: commentId };
  }

  async assignReviewer(id: string, login: string): Promise<Record<string, unknown>> {
    const record = this.getSubmission(id);
    if (record.revision < 1) throw new Error("Submission has not been uploaded");
    if (record.status !== "under_review") throw new Error("Submission is not open for reviewer assignment");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw new Error("GitHub login is invalid");
    const assigned = await this.github.assignReviewer(record, login);
    const now = new Date().toISOString();
    this.database.raw.prepare(`
      INSERT INTO reviewers (submission_id, github_login, state, invited_at, review_requested_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(submission_id, github_login) DO UPDATE SET state = excluded.state, invited_at = excluded.invited_at, review_requested_at = excluded.review_requested_at, removed_at = NULL
    `).run(id, login, assigned.state, now, assigned.state === "review_requested" ? now : null);
    this.event(id, "reviewer_assigned", "admin", login);
    return { submission_id: id, github_login: login, state: assigned.state };
  }

  async syncReviewer(id: string, login: string): Promise<Record<string, unknown>> {
    const record = this.getSubmission(id);
    if (record.status !== "under_review") throw new Error("Submission is not open for reviewer assignment");
    const assigned = await this.github.syncReviewer(record, login);
    const now = new Date().toISOString();
    this.database.raw.prepare(`UPDATE reviewers SET state = ?, accepted_at = ?, review_requested_at = ? WHERE submission_id = ? AND github_login = ?`)
      .run(assigned.state, now, now, id, login);
    return { submission_id: id, github_login: login, state: assigned.state };
  }

  async removeReviewer(id: string, login: string): Promise<void> {
    const record = this.getSubmission(id);
    await this.github.removeReviewer(record, login);
    const now = new Date().toISOString();
    this.database.raw.prepare("UPDATE reviewers SET state = 'removed', removed_at = ? WHERE submission_id = ? AND github_login = ?").run(now, id, login);
    this.event(id, "reviewer_removed", "admin", login);
  }

  async decide(id: string, decision: "accepted" | "rejected"): Promise<Record<string, unknown>> {
    const record = this.getSubmission(id);
    if (record.status !== "under_review") throw new Error("Submission is not under review");
    if (decision === "rejected") await this.github.closeReview(record);
    const now = new Date().toISOString();
    this.database.raw.prepare("UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?").run(decision, now, id);
    this.event(id, `decision_${decision}`, "admin");
    return { submission_id: id, status: decision };
  }

  adminStatus(id: string): Record<string, unknown> {
    const record = this.getSubmission(id);
    const reviewers = this.database.raw.prepare(`
      SELECT github_login, state, invited_at, accepted_at, review_requested_at, removed_at
      FROM reviewers WHERE submission_id = ? ORDER BY github_login
    `).all(id);
    return {
      submission_id: record.id,
      external_id: record.external_id,
      status: record.status,
      revision: record.revision,
      package_sha256: record.package_sha256,
      repository: record.repo_name,
      pull_request_number: record.pr_number,
      reviewers
    };
  }

  async publish(id: string, archive: Buffer, claimedDigest: string, publicSlug: string): Promise<Record<string, unknown>> {
    const record = this.getSubmission(id);
    if (record.status !== "accepted") throw new Error("Only an accepted submission can be published");
    const digest = sha256(archive);
    if (digest !== claimedDigest.toLowerCase()) throw new Error("Package digest does not match the received archive");
    const extraction = mkdtempSync(join(this.config.tempRoot, "aidar-publish-"));
    let serverStage: string | undefined;
    try {
      await safeExtractArchive(archive, extraction, this.config.limits);
      const validation = validateProject(extraction, { limits: this.config.limits, tempRoot: this.config.tempRoot, serverMode: true });
      if (!validation.report.valid) throw new Error("Publication package failed validation");
      serverStage = stageValidatedProject(validation, { limits: this.config.limits, tempRoot: this.config.tempRoot, serverMode: true });
      const stageValidation = validateProject(serverStage, { limits: this.config.limits, tempRoot: this.config.tempRoot, serverMode: true });
      const result = await this.github.publish(record, publicSlug, snapshotDirectory(serverStage, stageValidation.files, digest));
      this.event(id, "publication_pr_opened", "admin", String(result.pullNumber), digest);
      return { submission_id: id, published: false, publication_pull_request_number: result.pullNumber, package_sha256: digest };
    } finally {
      rmSync(extraction, { recursive: true, force: true });
      if (serverStage) rmSync(serverStage, { recursive: true, force: true });
    }
  }

  private event(submissionId: string | null, type: string, actor: string, githubObjectId?: string, payloadSha?: string): void {
    this.database.raw.prepare(`INSERT INTO events (id, submission_id, event_type, actor_type, github_object_id, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), submissionId, type, actor, githubObjectId ?? null, payloadSha ?? null, new Date().toISOString());
  }

  private idempotencyRecord(key: string): { submission_id: string; request_sha256: string; response_json: string } | undefined {
    if (!key) return undefined;
    return this.database.raw.prepare("SELECT submission_id, request_sha256, response_json FROM idempotency_keys WHERE key = ?").get(key) as { submission_id: string; request_sha256: string; response_json: string } | undefined;
  }
}
