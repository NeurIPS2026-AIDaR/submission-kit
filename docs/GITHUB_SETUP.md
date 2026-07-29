# GitHub setup for the live pilot

Use a test organization before you use a workshop organization. Do not use a personal access token in the service.

## 1. Configure the organization

1. Create or select the test organization.
2. Set the base repository permission to **No permission**.
3. Disable private repository forking if the organization plan supports this control.
4. Limit organization owners to the pilot operators.
5. Do not create a reviewer team with access to all submissions.
6. Create one public archive repository, such as `aidar-2026-submissions`.
7. Do not attach organization secrets or self-hosted runners to review repositories.

Organization owners and enterprise administrators can have broad access. Include this fact in the workshop policy.

## 2. Create the GitHub App

Create a GitHub App, such as `aidar-submission`.

Do not enable user authorization. Webhooks are optional for this pilot.

Set these repository permissions:

| Permission | Access | Use |
|---|---:|---|
| Administration | Read and write | Create repositories, manage collaborators, and set repository features |
| Contents | Read and write | Create clean trees, commits, and branches |
| Pull requests | Read and write | Open pull requests, request reviews, and read review comments |
| Issues | Read and write | Read and post pull-request conversation comments |
| Metadata | Read | Read repository metadata |
| Workflows | No access | The service must not add or change workflows |

Generate a private key. Store it outside the repository. Limit file access to the service operator.

Install the App on the test organization. Record the App ID and installation ID. An App receives access to repositories that it creates. Give the installation access to the public archive repository if you will test publication.

## 3. Configure the service

Copy `.env.example` to `.env`. Generate strong service credentials. For a deployed service, use a managed secret store instead of a dotenv file.

Set these values:

```dotenv
AIDAR_GITHUB_MODE=live
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY_PATH=<absolute-private-key-path>
GITHUB_INSTALLATION_ID=<installation-id>
GITHUB_ORG=<test-organization>
GITHUB_API_VERSION=2026-03-10
GITHUB_PUBLIC_ARCHIVE_REPO=aidar-2026-submissions
```

Use a current GitHub REST API version. The version is configurable because GitHub can retire old versions.

## 4. Verify each live repository

For each initial submission, verify these properties:

1. The repository is private and has an opaque name.
2. GitHub Actions is disabled.
3. The wiki, projects, and discussions are disabled.
4. `main` contains only the AIDaR review shell.
5. `submission` contains a fresh package snapshot.
6. Pull request 1 is open from `submission` to `main`.
7. The App bot created the submission commit and pull request.
8. No original commit, author, email, signature, timestamp, branch, tag, or remote is present.
9. Only assigned reviewers have repository access.

## 5. Test reviewer assignment

Use a reviewer account that the workshop has verified. Assign only `pull` access. The reviewer can comment and review with read access.

An outside collaborator must accept the invitation. If the review request occurs before acceptance, the service returns `pending_acceptance`. After acceptance, run `aidar-admin sync-reviewer`.

Use a second reviewer and a second submission to test repository isolation. Confirm that each reviewer gets `404` or an access error for the unassigned repository.

## 6. Official references

- [Create an organization repository](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository)
- [Authenticate as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Create Git trees](https://docs.github.com/en/rest/git/trees#create-a-tree)
- [Manage repository collaborators](https://docs.github.com/en/rest/collaborators/collaborators)
- [Request pull-request reviews](https://docs.github.com/en/rest/pulls/review-requests)
- [Set repository Actions permissions](https://docs.github.com/en/rest/actions/permissions#set-github-actions-permissions-for-a-repository)
