import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type {
  GithubGateway, GithubRevisionResult, GithubSubmissionResult, ReviewerAssignmentResult,
  ReviewItem, SubmissionRecord, SubmissionSnapshot
} from "../types.js";

interface LiveGithubConfig {
  appId: string;
  privateKey: string;
  installationId: number;
  org: string;
  apiVersion: string;
  publicArchiveRepo: string;
}

const REVIEW_GUIDE = `# AIDaR review guide

The author is anonymous. Review with your assigned GitHub account.

Do not run submitted code outside an appropriate sandbox. Use pull-request reviews, inline comments, and the PR conversation. Author responses and revisions appear under the AIDaR bot identity.

## Review structure

## Summary
## Main contributions
## Strengths
## Major concerns
## Minor concerns
## Artifact and reproducibility assessment
## Questions for the authors
## Recommendation and confidence
`;

export class LiveGithubGateway implements GithubGateway {
  constructor(private readonly config: LiveGithubConfig) {}

  private async client(): Promise<Octokit> {
    const auth = createAppAuth({
      appId: this.config.appId,
      privateKey: this.config.privateKey,
      installationId: this.config.installationId
    });
    const installation = await auth({ type: "installation" });
    return new Octokit({
      auth: installation.token,
      request: { headers: { "X-GitHub-Api-Version": this.config.apiVersion } }
    });
  }

  private async blobEntries(octokit: Octokit, repo: string, files: Map<string, Buffer>, prefix = ""): Promise<Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>> {
    const entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    for (const [path, data] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const blob = await octokit.rest.git.createBlob({ owner: this.config.org, repo, content: data.toString("base64"), encoding: "base64" });
      entries.push({ path: `${prefix}${path}`, mode: "100644", type: "blob", sha: blob.data.sha });
    }
    return entries;
  }

  private async commitTree(octokit: Octokit, repo: string, parentSha: string, baseTreeSha: string, files: Map<string, Buffer>, message: string, prefix = ""): Promise<string> {
    const entries = await this.blobEntries(octokit, repo, files, prefix);
    const tree = await octokit.rest.git.createTree({ owner: this.config.org, repo, base_tree: baseTreeSha, tree: entries });
    const commit = await octokit.rest.git.createCommit({ owner: this.config.org, repo, message, tree: tree.data.sha, parents: [parentSha] });
    return commit.data.sha;
  }

  async createSubmission(submissionId: string, snapshot: SubmissionSnapshot): Promise<GithubSubmissionResult> {
    const octokit = await this.client();
    const repoName = `submission-${submissionId}`;
    const created = await octokit.rest.repos.createInOrg({
      org: this.config.org,
      name: repoName,
      private: true,
      auto_init: true,
      description: "Anonymous AIDaR workshop review",
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      has_discussions: false
    });
    if (created.data.default_branch !== "main") {
      await octokit.rest.repos.renameBranch({ owner: this.config.org, repo: repoName, branch: created.data.default_branch, new_name: "main" });
    }
    await octokit.rest.actions.setGithubActionsPermissionsRepository({ owner: this.config.org, repo: repoName, enabled: false });

    const initial = await octokit.rest.repos.getBranch({ owner: this.config.org, repo: repoName, branch: "main" });
    const initialCommit = await octokit.rest.git.getCommit({ owner: this.config.org, repo: repoName, commit_sha: initial.data.commit.sha });
    const shell = new Map<string, Buffer>([
      ["README.md", Buffer.from(`# Submission ${submissionId}\n\nAnonymous AIDaR review repository.\n`)],
      ["REVIEW_GUIDE.md", Buffer.from(REVIEW_GUIDE)],
      ["SECURITY.md", Buffer.from("# Security\n\nTreat every submitted artifact as untrusted. Do not run code without an appropriate sandbox.\n")],
      ["metadata/submission.json", Buffer.from(`${JSON.stringify({ submission_id: submissionId, schema_version: "0.1", review_model: "anonymous-authors-named-reviewers" }, null, 2)}\n`)]
    ]);
    const shellSha = await this.commitTree(octokit, repoName, initial.data.commit.sha, initialCommit.data.tree.sha, shell, `Initialize review shell for submission ${submissionId}`);
    await octokit.rest.git.updateRef({ owner: this.config.org, repo: repoName, ref: "heads/main", sha: shellSha });
    const shellCommit = await octokit.rest.git.getCommit({ owner: this.config.org, repo: repoName, commit_sha: shellSha });
    await octokit.rest.git.createRef({ owner: this.config.org, repo: repoName, ref: "refs/heads/submission", sha: shellSha });
    const headSha = await this.commitTree(octokit, repoName, shellSha, shellCommit.data.tree.sha, snapshot.files, `Revision 1 for submission ${submissionId}`);
    await octokit.rest.git.updateRef({ owner: this.config.org, repo: repoName, ref: "heads/submission", sha: headSha });
    const pull = await octokit.rest.pulls.create({
      owner: this.config.org,
      repo: repoName,
      title: `Submission ${submissionId}`,
      base: "main",
      head: "submission",
      body: `This is an anonymous author submission. Reviewers use named GitHub accounts. Author responses and revisions are relayed by the AIDaR bot.\n\nDo not execute submitted code outside an appropriate sandbox. See REVIEW_GUIDE.md.`
    });
    return { repoId: created.data.id, repoName, pullNumber: pull.data.number, headSha };
  }

  async revise(record: SubmissionRecord, snapshot: SubmissionSnapshot, revision: number): Promise<GithubRevisionResult> {
    const octokit = await this.client();
    const repo = this.requireRepo(record);
    const branch = await octokit.rest.repos.getBranch({ owner: this.config.org, repo, branch: record.submission_branch });
    if (record.branch_head_sha && branch.data.commit.sha !== record.branch_head_sha) throw new Error("Submission branch changed outside AIDaR; revision stopped");
    const main = await octokit.rest.repos.getBranch({ owner: this.config.org, repo, branch: "main" });
    const mainCommit = await octokit.rest.git.getCommit({ owner: this.config.org, repo, commit_sha: main.data.commit.sha });
    const headSha = await this.commitTree(octokit, repo, branch.data.commit.sha, mainCommit.data.tree.sha, snapshot.files, `Revision ${revision} for submission ${record.id}`);
    await octokit.rest.git.updateRef({ owner: this.config.org, repo, ref: `heads/${record.submission_branch}`, sha: headSha, force: false });
    await octokit.rest.issues.createComment({
      owner: this.config.org,
      repo,
      issue_number: this.requirePull(record),
      body: `## AIDaR Revision ${revision}\n\nComplete replacement snapshot received.\n\nPackage SHA-256: \`${snapshot.digest}\``
    });
    return { headSha };
  }

  async assignReviewer(record: SubmissionRecord, login: string): Promise<ReviewerAssignmentResult> {
    const octokit = await this.client();
    const repo = this.requireRepo(record);
    await octokit.rest.repos.addCollaborator({ owner: this.config.org, repo, username: login, permission: "pull" });
    try {
      await octokit.rest.pulls.requestReviewers({ owner: this.config.org, repo, pull_number: this.requirePull(record), reviewers: [login] });
      return { state: "review_requested" };
    } catch (error) {
      if (error instanceof Error && "status" in error && Number((error as Error & { status: number }).status) === 422) return { state: "pending_acceptance" };
      throw error;
    }
  }

  async syncReviewer(record: SubmissionRecord, login: string): Promise<ReviewerAssignmentResult> {
    const octokit = await this.client();
    const repo = this.requireRepo(record);
    await octokit.rest.repos.checkCollaborator({ owner: this.config.org, repo, username: login });
    await octokit.rest.pulls.requestReviewers({ owner: this.config.org, repo, pull_number: this.requirePull(record), reviewers: [login] });
    return { state: "review_requested" };
  }

  async removeReviewer(record: SubmissionRecord, login: string): Promise<void> {
    const octokit = await this.client();
    await octokit.rest.repos.removeCollaborator({ owner: this.config.org, repo: this.requireRepo(record), username: login });
  }

  async listReviews(record: SubmissionRecord): Promise<ReviewItem[]> {
    const octokit = await this.client();
    const repo = this.requireRepo(record);
    const pullNumber = this.requirePull(record);
    const [reviews, comments, inline] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviews, { owner: this.config.org, repo, pull_number: pullNumber, per_page: 100 }),
      octokit.paginate(octokit.rest.issues.listComments, { owner: this.config.org, repo, issue_number: pullNumber, per_page: 100 }),
      octokit.paginate(octokit.rest.pulls.listReviewComments, { owner: this.config.org, repo, pull_number: pullNumber, per_page: 100 })
    ]);
    const items: ReviewItem[] = [
      ...reviews.map((item) => ({ id: item.id, type: "review" as const, reviewer_login: item.user?.login ?? "unknown", body: item.body ?? "", state: item.state, created_at: item.submitted_at ?? new Date(0).toISOString() })),
      ...comments.map((item) => ({ id: item.id, type: "comment" as const, reviewer_login: item.user?.login ?? "unknown", body: item.body ?? "", created_at: item.created_at })),
      ...inline.map((item) => ({ id: item.id, type: "inline_comment" as const, reviewer_login: item.user?.login ?? "unknown", body: item.body, path: item.path, line: item.line ?? item.original_line, in_reply_to_id: item.in_reply_to_id, created_at: item.created_at }))
    ];
    return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async postResponse(record: SubmissionRecord, body: string, replyTo?: number | null): Promise<number> {
    const octokit = await this.client();
    const heading = `## AIDaR Author Response — Submission ${record.id}`;
    const reference = replyTo ? `\n\nIn response to review comment ID \`${replyTo}\`.` : "";
    const result = await octokit.rest.issues.createComment({ owner: this.config.org, repo: this.requireRepo(record), issue_number: this.requirePull(record), body: `${heading}${reference}\n\n${body}` });
    return result.data.id;
  }

  async closeReview(record: SubmissionRecord): Promise<void> {
    const octokit = await this.client();
    await octokit.rest.pulls.update({ owner: this.config.org, repo: this.requireRepo(record), pull_number: this.requirePull(record), state: "closed" });
  }

  async publish(record: SubmissionRecord, publicSlug: string, snapshot: SubmissionSnapshot): Promise<{ pullNumber: number }> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(publicSlug)) throw new Error("Public slug is invalid");
    const octokit = await this.client();
    const repo = this.config.publicArchiveRepo;
    const repository = await octokit.rest.repos.get({ owner: this.config.org, repo });
    const base = repository.data.default_branch;
    const branch = await octokit.rest.repos.getBranch({ owner: this.config.org, repo, branch: base });
    const baseCommit = await octokit.rest.git.getCommit({ owner: this.config.org, repo, commit_sha: branch.data.commit.sha });
    const publishBranch = `publish/${record.id}`;
    await octokit.rest.git.createRef({ owner: this.config.org, repo, ref: `refs/heads/${publishBranch}`, sha: branch.data.commit.sha });
    const headSha = await this.commitTree(octokit, repo, branch.data.commit.sha, baseCommit.data.tree.sha, snapshot.files, `Publish accepted submission ${record.id}`, `submissions/${publicSlug}/`);
    await octokit.rest.git.updateRef({ owner: this.config.org, repo, ref: `heads/${publishBranch}`, sha: headSha });
    const pull = await octokit.rest.pulls.create({ owner: this.config.org, repo, base, head: publishBranch, title: `Publish accepted submission: ${publicSlug}`, body: `Publication package for accepted AIDaR submission ${record.id}.` });
    return { pullNumber: pull.data.number };
  }

  private requireRepo(record: SubmissionRecord): string {
    if (!record.repo_name) throw new Error("Submission repository is not ready");
    return record.repo_name;
  }

  private requirePull(record: SubmissionRecord): number {
    if (!record.pr_number) throw new Error("Submission pull request is not ready");
    return record.pr_number;
  }
}
