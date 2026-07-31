"use strict";

(() => {
  const form = document.querySelector("#browser-form");
  if (!form) return;

  const folder = document.querySelector("#project-folder");
  const identityTerms = document.querySelector("#identity-terms");
  const binaryRow = document.querySelector("#binary-confirm-row");
  const binaryConfirm = document.querySelector("#binary-confirm");
  const checkButton = document.querySelector("#check-folder");
  const submitButton = document.querySelector("#submit-folder");
  const status = document.querySelector("#upload-status");
  const result = document.querySelector("#upload-result");
  const dialog = document.querySelector("#browser-dialog");
  const openDialogButton = document.querySelector("#open-browser-upload");
  const closeDialogButton = document.querySelector("#close-browser-upload");
  const copyPromptButton = document.querySelector("#copy-agent-prompt");
  const agentPrompt = document.querySelector("#agent-prompt-text");
  const credentialSummary = document.querySelector("#credential-summary");
  const savedCredentials = document.querySelector("#saved-credentials");
  const refreshSubmissionButton = document.querySelector("#refresh-submission");
  const downloadCredentialButton = document.querySelector("#download-credential");
  const importCredentialButton = document.querySelector("#import-credential");
  const credentialFile = document.querySelector("#credential-file");
  const startNewSubmissionButton = document.querySelector("#start-new-submission");
  const forgetCredentialButton = document.querySelector("#forget-credential");
  const submissionDashboard = document.querySelector("#submission-dashboard");
  const dashboardStatus = document.querySelector("#dashboard-status");
  const submissionFacts = document.querySelector("#submission-facts");
  const reviewList = document.querySelector("#review-list");
  const responseForm = document.querySelector("#response-form");
  const replyToReview = document.querySelector("#reply-to-review");
  const reviewResponse = document.querySelector("#review-response");
  const postResponseButton = document.querySelector("#post-response");
  const responseStatus = document.querySelector("#response-status");
  const openreviewField = document.querySelector("#openreview-field");
  const invitationField = document.querySelector("#invitation-field");
  const openreviewInput = document.querySelector("#openreview-url");
  const invitationInput = document.querySelector("#invitation-code");

  const limits = {
    fileCount: 5000,
    fileBytes: 25 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
    pathCharacters: 240,
    archiveBytes: 100 * 1024 * 1024
  };

  const sensitivePatterns = [
    ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["ORCID", /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/i],
    ["home-directory path", /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\]+/i],
    ["co-author marker", /^.*Co-authored-by\s*:.*$/im],
    ["repository owner", /(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+/i],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
    ["API secret", /\bsk-[A-Za-z0-9_-]{20,}\b/]
  ];

  const credentialStorageKey = "aidar.browser.credentials.v1";
  let checkedPackage = null;
  let credential = null;
  let credentialStatus = null;
  let currentReviews = [];
  let dashboardLoaded = false;

  function openBrowserDialog() {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    if (credential && !dashboardLoaded) refreshSubmission();
  }

  function closeBrowserDialog() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function credentialReceipt(value) {
    return {
      version: 1,
      kind: "aidar-browser-credential",
      submission_id: value.submission_id,
      server: window.location.origin,
      author_token: value.author_token,
      created_at: value.created_at || new Date().toISOString()
    };
  }

  function normalizeCredential(value) {
    if (!value || typeof value !== "object") {
      throw new Error("The AIDaR key file is invalid.");
    }
    let server;
    try {
      server = new URL(String(value.server || ""));
    } catch (_) {
      throw new Error("The AIDaR key file has an invalid server.");
    }
    const allowedOrigins = new Set([window.location.origin]);
    if (window.location.hostname === "submityour.work" ||
        window.location.hostname === "www.submityour.work") {
      allowedOrigins.add("https://submityour.work");
      allowedOrigins.add("https://www.submityour.work");
    }
    const sameServer = allowedOrigins.has(server.origin) &&
      server.pathname === "/" &&
      !server.search &&
      !server.hash &&
      !server.username &&
      !server.password;
    const submissionId = String(value.submission_id || "");
    const authorToken = String(value.author_token || "");
    if (value.version !== 1 ||
        value.kind !== "aidar-browser-credential" ||
        !sameServer ||
        !/^[A-Fa-f0-9]{12}$/.test(submissionId) ||
        !/^aidar_sub_[A-Za-z0-9_-]{32,118}$/.test(authorToken)) {
      throw new Error("The AIDaR key file is invalid or belongs to another service.");
    }
    return {
      version: 1,
      kind: "aidar-browser-credential",
      submission_id: submissionId.toLowerCase(),
      server: window.location.origin,
      author_token: authorToken,
      created_at: typeof value.created_at === "string" ? value.created_at : new Date().toISOString()
    };
  }

  function readStoredCredentials() {
    try {
      const raw = localStorage.getItem(credentialStorageKey);
      if (!raw || raw.length > 65536) return [];
      const values = JSON.parse(raw);
      if (!Array.isArray(values)) return [];
      const output = [];
      for (const value of values.slice(0, 20)) {
        try {
          const normalized = normalizeCredential(value);
          if (!output.some((item) => item.submission_id === normalized.submission_id)) {
            output.push(normalized);
          }
        } catch (_) {
          // Ignore malformed browser storage without exposing its contents.
        }
      }
      return output;
    } catch (_) {
      return [];
    }
  }

  function writeStoredCredentials(values) {
    try {
      localStorage.setItem(credentialStorageKey, JSON.stringify(values.slice(0, 20)));
      return true;
    } catch (_) {
      return false;
    }
  }

  function rememberCredential(value) {
    const normalized = normalizeCredential(value);
    const values = readStoredCredentials()
      .filter((item) => item.submission_id !== normalized.submission_id);
    values.unshift(normalized);
    return writeStoredCredentials(values);
  }

  function removeStoredCredential(submissionId) {
    const values = readStoredCredentials()
      .filter((item) => item.submission_id !== submissionId);
    writeStoredCredentials(values);
    return values;
  }

  function uploadIsAllowed() {
    if (!credentialStatus || Number(credentialStatus.revision || 0) === 0) return true;
    return credentialStatus.status === "under_review";
  }

  function updateCredentialControls() {
    const stored = readStoredCredentials();
    savedCredentials.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Saved submissions";
    placeholder.selected = !credential;
    savedCredentials.append(placeholder);
    for (const item of stored) {
      const option = document.createElement("option");
      option.value = item.submission_id;
      option.textContent = "Submission " + item.submission_id;
      savedCredentials.append(option);
    }
    savedCredentials.hidden = stored.length === 0;
    if (credential && stored.some((item) => item.submission_id === credential.submission_id)) {
      savedCredentials.value = credential.submission_id;
    }

    const active = Boolean(credential);
    refreshSubmissionButton.hidden = !active;
    downloadCredentialButton.hidden = !active;
    startNewSubmissionButton.hidden = !active;
    forgetCredentialButton.hidden = !active;
    openreviewField.hidden = active;
    invitationField.hidden = active;
    openreviewInput.required = !active;
    invitationInput.required = !active;

    if (active) {
      credentialSummary.textContent = "Submission " + credential.submission_id + " is active on this device.";
      const revision = Number(credentialStatus && credentialStatus.revision || 0);
      submitButton.textContent = revision > 0 ? "Submit revision" : "Continue submission";
    } else {
      credentialSummary.textContent = "No submission key is active. Your first upload creates one automatically.";
      submitButton.textContent = "Submit privately";
    }
    if (checkedPackage) submitButton.disabled = !uploadIsAllowed();
  }

  function activateCredential(value, save) {
    credential = normalizeCredential(value);
    credentialStatus = null;
    currentReviews = [];
    dashboardLoaded = false;
    if (save !== false) rememberCredential(credential);
    result.hidden = true;
    updateCredentialControls();
    setStatus("AIDaR key loaded. Select a folder to submit an update, or refresh to read reviews.", "");
  }

  function startNewSubmission() {
    credential = null;
    credentialStatus = null;
    currentReviews = [];
    dashboardLoaded = false;
    submissionDashboard.hidden = true;
    responseForm.hidden = true;
    responseForm.reset();
    result.hidden = true;
    updateCredentialControls();
    setStatus("Select a folder, then run the local check.", "");
  }

  async function copyAgentPrompt() {
    const text = agentPrompt.textContent.trim();
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const temporary = document.createElement("textarea");
      temporary.value = text;
      temporary.setAttribute("readonly", "");
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.append(temporary);
      temporary.select();
      const copied = document.execCommand("copy");
      temporary.remove();
      if (!copied) return;
    }
    copyPromptButton.setAttribute("aria-label", "Copied");
    copyPromptButton.setAttribute("title", "Copied");
    copyPromptButton.dataset.copied = "true";
    setTimeout(() => {
      copyPromptButton.setAttribute("aria-label", "Copy prompt");
      copyPromptButton.setAttribute("title", "Copy prompt");
      delete copyPromptButton.dataset.copied;
    }, 1600);
  }

  function setStatus(message, kind) {
    status.textContent = message;
    status.className = "upload-status " + (kind || "");
  }

  function humanBytes(value) {
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }

  function selectedTerms() {
    return identityTerms.value
      .split(/[\n,]/)
      .map((value) => value.trim().toLocaleLowerCase())
      .filter((value) => value.length >= 2);
  }

  function relativePath(file) {
    const raw = file.webkitRelativePath || file.name;
    const parts = raw.split("/").filter(Boolean);
    return (parts.length > 1 ? parts.slice(1) : parts).join("/");
  }

  function prohibited(path) {
    const parts = path.split("/");
    return parts.some((part) => [".git", ".hg", ".svn"].includes(part)) ||
      path === ".gitmodules" ||
      path === ".aidar-private-identities.txt" ||
      path === ".github/workflows" ||
      path.startsWith(".github/workflows/");
  }

  function textFrom(bytes) {
    if (bytes.includes(0)) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_) {
      return null;
    }
  }

  function sensitiveKind(value, terms) {
    for (const [kind, pattern] of sensitivePatterns) {
      if (pattern.test(value)) return kind;
    }
    const folded = value.toLocaleLowerCase();
    if (terms.some((term) => folded.includes(term))) return "author identity term";
    return null;
  }

  async function inspectFolder() {
    if (!("CompressionStream" in window) || !window.crypto || !window.crypto.subtle) {
      throw new Error("This browser does not support the local packaging features required by AIDaRS.");
    }
    const selected = Array.from(folder.files || []);
    if (!selected.length) throw new Error("Select a project folder first.");
    const terms = selectedTerms();
    const files = [];
    const collisions = new Set();
    const problems = [];
    let total = 0;
    let excluded = 0;
    let binary = 0;

    for (const file of selected) {
      const path = relativePath(file).normalize("NFC");
      if (prohibited(path)) {
        excluded += 1;
        continue;
      }
      if (!path || path.length > limits.pathCharacters || /[\u0000-\u001f\u007f]/.test(path)) {
        problems.push("Unsafe or long path: " + (path || file.name));
        continue;
      }
      const pathKind = sensitiveKind(path, terms);
      if (pathKind) {
        problems.push(pathKind + " in path: " + path);
        continue;
      }
      const collision = path.toLocaleLowerCase();
      if (collisions.has(collision)) {
        problems.push("Duplicate or case-colliding path: " + path);
        continue;
      }
      collisions.add(collision);
      if (file.size > limits.fileBytes) {
        problems.push("File exceeds " + humanBytes(limits.fileBytes) + ": " + path);
        continue;
      }
      total += file.size;
      if (total > limits.totalBytes) {
        throw new Error("The folder exceeds the browser limit of " + humanBytes(limits.totalBytes) + ". Use the command-line client for a larger project.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = textFrom(bytes);
      if (text === null) {
        binary += 1;
      } else {
        const kind = sensitiveKind(text, terms);
        if (kind) {
          problems.push(kind + " in file: " + path);
          continue;
        }
      }
      files.push({ path, bytes });
      if (files.length > limits.fileCount) {
        throw new Error("The folder contains more than " + limits.fileCount + " files.");
      }
    }

    if (problems.length) {
      const shown = problems.slice(0, 8).join("\n");
      const more = problems.length > 8 ? "\n…and " + (problems.length - 8) + " more." : "";
      throw new Error("Remove the following private or unsafe content, then check again:\n" + shown + more);
    }
    if (!files.length) throw new Error("The selected folder has no files to submit.");
    files.sort((left, right) => left.path.localeCompare(right.path));
    binaryRow.hidden = binary === 0;
    if (binary === 0) binaryConfirm.checked = false;
    return { files, total, binary, excluded };
  }

  function writeString(target, offset, length, value) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > length) throw new Error("A project path cannot be represented safely in the browser archive.");
    target.set(bytes, offset);
  }

  function octal(value, width) {
    const digits = value.toString(8);
    if (digits.length > width - 1) throw new Error("A file is too large for the browser archive.");
    return digits.padStart(width - 1, "0") + "\0";
  }

  function ustarPath(path) {
    const encoder = new TextEncoder();
    if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
    const slashes = [];
    for (let i = 0; i < path.length; i += 1) if (path[i] === "/") slashes.push(i);
    for (let i = slashes.length - 1; i >= 0; i -= 1) {
      const prefix = path.slice(0, slashes[i]);
      const name = path.slice(slashes[i] + 1);
      if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) {
        return { name, prefix };
      }
    }
    throw new Error("Path is too long for browser upload: " + path);
  }

  function tarArchive(files) {
    let size = 1024;
    for (const file of files) size += 512 + Math.ceil(file.bytes.length / 512) * 512;
    const tar = new Uint8Array(size);
    let offset = 0;
    for (const file of files) {
      const header = tar.subarray(offset, offset + 512);
      const path = ustarPath(file.path);
      writeString(header, 0, 100, path.name);
      writeString(header, 100, 8, octal(0o644, 8));
      writeString(header, 108, 8, octal(0, 8));
      writeString(header, 116, 8, octal(0, 8));
      writeString(header, 124, 12, octal(file.bytes.length, 12));
      writeString(header, 136, 12, octal(0, 12));
      header.fill(32, 148, 156);
      header[156] = "0".charCodeAt(0);
      writeString(header, 257, 6, "ustar\0");
      writeString(header, 263, 2, "00");
      writeString(header, 345, 155, path.prefix);
      let checksum = 0;
      for (const byte of header) checksum += byte;
      writeString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
      offset += 512;
      tar.set(file.bytes, offset);
      offset += Math.ceil(file.bytes.length / 512) * 512;
    }
    return tar;
  }

  async function packageFolder(inspected) {
    const tar = tarArchive(inspected.files);
    const compressedStream = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
    const archive = new Uint8Array(await new Response(compressedStream).arrayBuffer());
    if (archive.length > limits.archiveBytes) {
      throw new Error("The compressed archive exceeds " + humanBytes(limits.archiveBytes) + ". Use the command-line client.");
    }
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", archive));
    const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { archive, digest, ...inspected };
  }

  function downloadCredential(value) {
    const receipt = normalizeCredential(credentialReceipt(value));
    const blob = new Blob([JSON.stringify(receipt, null, 2) + "\n"], { type: "application/json" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "aidar-submission-" + receipt.submission_id + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function responseJson(response) {
    let value;
    try {
      value = await response.json();
    } catch (_) {
      throw new Error("The service returned an invalid response.");
    }
    if (!response.ok) throw new Error(value.error || "The request failed.");
    return value;
  }

  async function register() {
    const response = await fetch("/v1/author/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openreview_url: openreviewInput.value.trim(),
        invitation_code: invitationInput.value.trim()
      }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store"
    });
    return responseJson(response);
  }

  async function upload(packaged, value, revision) {
    const body = new FormData();
    body.append("archive", new Blob([packaged.archive], { type: "application/gzip" }), "submission.tar.gz");
    body.append("archive_sha256", packaged.digest);
    const response = await fetch(revision ? "/v1/author/revise" : "/v1/author/submit", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + value.author_token,
        "Idempotency-Key": crypto.randomUUID()
      },
      body,
      credentials: "omit",
      redirect: "error",
      cache: "no-store"
    });
    return responseJson(response);
  }

  function showResult(value) {
    result.hidden = false;
    result.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = Number(value.revision || 0) > 1 ? "Revision received" : "Submission received";
    const copy = document.createElement("p");
    const remembered = readStoredCredentials()
      .some((item) => item.submission_id === value.submission_id);
    copy.textContent = remembered ?
      "Submission " + value.submission_id + " is in private GitHub review. Its AIDaR key is saved in this browser; keep the downloaded backup private." :
      "Submission " + value.submission_id + " is in private GitHub review. Browser storage is unavailable; keep the downloaded AIDaR key private.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = "Download AIDaR key again";
    button.addEventListener("click", () => downloadCredential(credential));
    result.append(heading, copy, button);
  }

  async function authorRequest(path, options) {
    if (!credential) throw new Error("Load an AIDaR key first.");
    const request = options || {};
    const headers = new Headers(request.headers || {});
    headers.set("Authorization", "Bearer " + credential.author_token);
    const response = await fetch(path, {
      ...request,
      headers,
      credentials: "omit",
      redirect: "error",
      cache: "no-store"
    });
    return responseJson(response);
  }

  function readableStatus(value) {
    return String(value || "unknown").replaceAll("_", " ");
  }

  function readableDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
  }

  function renderSubmissionFacts(value) {
    submissionFacts.replaceChildren();
    const facts = [
      ["Submission", value.submission_id],
      ["Status", readableStatus(value.status)],
      ["Revision", String(value.revision || 0)],
      ["Updated", readableDate(value.updated_at)]
    ];
    for (const [label, content] of facts) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = content;
      wrapper.append(term, description);
      submissionFacts.append(wrapper);
    }
  }

  function renderReviews() {
    reviewList.replaceChildren();
    replyToReview.replaceChildren();
    const general = document.createElement("option");
    general.value = "";
    general.textContent = "General response";
    replyToReview.append(general);

    if (!currentReviews.length) {
      const empty = document.createElement("p");
      empty.className = "dashboard-status";
      empty.textContent = "No reviews have been posted yet.";
      reviewList.append(empty);
    }

    currentReviews.forEach((review, index) => {
      const card = document.createElement("article");
      card.className = "review-card";
      const heading = document.createElement("h5");
      heading.textContent = "Review " + (index + 1);

      const meta = document.createElement("p");
      meta.className = "review-meta";
      const details = [readableStatus(review.type)];
      if (review.state) details.push(readableStatus(review.state));
      if (review.path) details.push(review.path + (review.line ? ":" + review.line : ""));
      if (review.created_at) details.push(readableDate(review.created_at));
      meta.textContent = details.join(" · ");

      const body = document.createElement("pre");
      body.className = "review-body";
      body.textContent = String(review.body || "");
      card.append(heading, meta, body);
      reviewList.append(card);

      if (Number.isSafeInteger(review.id)) {
        const option = document.createElement("option");
        option.value = String(review.id);
        option.textContent = "Review " + (index + 1);
        replyToReview.append(option);
      }
    });

    responseForm.hidden = !credentialStatus ||
      credentialStatus.status !== "under_review" ||
      Number(credentialStatus.revision || 0) < 1;
  }

  async function refreshSubmission() {
    if (!credential) return;
    refreshSubmissionButton.disabled = true;
    submissionDashboard.hidden = false;
    dashboardStatus.textContent = "Refreshing private submission status and reviews…";
    try {
      credentialStatus = await authorRequest("/v1/author/status");
      renderSubmissionFacts(credentialStatus);
      currentReviews = [];
      if (Number(credentialStatus.revision || 0) > 0) {
        const value = await authorRequest("/v1/author/reviews");
        currentReviews = Array.isArray(value.reviews) ? value.reviews : [];
      }
      renderReviews();
      dashboardLoaded = true;
      dashboardStatus.textContent = Number(credentialStatus.revision || 0) > 0 ?
        "Submission information is current." :
        "The AIDaR key is registered. Select the folder to finish the initial submission.";
      updateCredentialControls();
    } catch (error) {
      dashboardStatus.textContent = error.message;
    } finally {
      refreshSubmissionButton.disabled = false;
    }
  }

  async function importCredentialFile() {
    const file = credentialFile.files && credentialFile.files[0];
    if (!file) return;
    try {
      if (file.size > 16384) throw new Error("The AIDaR key file is too large.");
      const value = normalizeCredential(JSON.parse(await file.text()));
      const saved = rememberCredential(value);
      activateCredential(value, false);
      setStatus(saved ?
        "AIDaR key imported and saved in this browser." :
        "AIDaR key imported. Browser storage is unavailable, so keep the backup file.", "success");
      await refreshSubmission();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      credentialFile.value = "";
    }
  }

  async function postReviewResponse(event) {
    event.preventDefault();
    const body = reviewResponse.value.trim();
    if (!body) {
      responseStatus.textContent = "Write a response first.";
      return;
    }
    postResponseButton.disabled = true;
    responseStatus.textContent = "Posting the response through the AIDaR bot…";
    try {
      const selected = replyToReview.value;
      const replyId = selected ? Number(selected) : null;
      if (replyId !== null && !Number.isSafeInteger(replyId)) {
        throw new Error("The selected review is invalid.");
      }
      await authorRequest("/v1/author/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          reply_to_review_comment_id: replyId
        })
      });
      responseForm.reset();
      responseStatus.textContent = "Response posted.";
      await refreshSubmission();
    } catch (error) {
      responseStatus.textContent = error.message;
    } finally {
      postResponseButton.disabled = false;
    }
  }

  async function check() {
    checkButton.disabled = true;
    submitButton.disabled = true;
    checkedPackage = null;
    try {
      setStatus("Checking files locally. Nothing is being uploaded…", "working");
      const inspected = await inspectFolder();
      checkedPackage = await packageFolder(inspected);
      const binaryText = inspected.binary ? ", including " + inspected.binary + " binary file(s)" : "";
      const excludedText = inspected.excluded ? ". Excluded " + inspected.excluded + " version-control or workflow file(s)" : "";
      const ready = "Ready: " + inspected.files.length + " files, " + humanBytes(inspected.total) + binaryText + excludedText + ".";
      if (!uploadIsAllowed()) {
        setStatus(ready + " This submission is not open for another revision.", "error");
        return false;
      }
      setStatus(ready, "success");
      submitButton.disabled = false;
      return true;
    } catch (error) {
      setStatus(error.message, "error");
      return false;
    } finally {
      checkButton.disabled = false;
    }
  }

  openDialogButton.addEventListener("click", openBrowserDialog);
  closeDialogButton.addEventListener("click", closeBrowserDialog);
  copyPromptButton.addEventListener("click", copyAgentPrompt);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) closeBrowserDialog();
  });

  savedCredentials.addEventListener("change", async () => {
    const submissionId = savedCredentials.value;
    if (!submissionId) {
      startNewSubmission();
      return;
    }
    const selected = readStoredCredentials()
      .find((item) => item.submission_id === submissionId);
    if (!selected) return;
    activateCredential(selected, false);
    await refreshSubmission();
  });
  refreshSubmissionButton.addEventListener("click", refreshSubmission);
  downloadCredentialButton.addEventListener("click", () => downloadCredential(credential));
  importCredentialButton.addEventListener("click", () => credentialFile.click());
  credentialFile.addEventListener("change", importCredentialFile);
  startNewSubmissionButton.addEventListener("click", startNewSubmission);
  forgetCredentialButton.addEventListener("click", async () => {
    if (!credential) return;
    if (!window.confirm("Forget this AIDaR key on this device? Keep the downloaded backup if you need future access.")) return;
    const remaining = removeStoredCredential(credential.submission_id);
    if (remaining.length) {
      activateCredential(remaining[0], false);
      await refreshSubmission();
    } else {
      startNewSubmission();
    }
  });
  responseForm.addEventListener("submit", postReviewResponse);

  checkButton.addEventListener("click", check);
  folder.addEventListener("change", () => {
    checkedPackage = null;
    submitButton.disabled = true;
    result.hidden = true;
    binaryRow.hidden = true;
    setStatus("Folder selected. Run the local check before submitting.", "");
  });
  identityTerms.addEventListener("input", () => {
    checkedPackage = null;
    submitButton.disabled = true;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!checkedPackage && !(await check())) return;
    if (checkedPackage.binary > 0 && !binaryConfirm.checked) {
      setStatus("Confirm that you reviewed the binary files before submitting.", "error");
      return;
    }
    submitButton.disabled = true;
    checkButton.disabled = true;
    try {
      if (!credential) {
        setStatus("Creating the invited submission…", "working");
        const registered = await register();
        credential = normalizeCredential(credentialReceipt(registered));
        credentialStatus = {
          submission_id: credential.submission_id,
          status: registered.status || "awaiting_submission",
          revision: 0
        };
        rememberCredential(credential);
        invitationInput.value = "";
        openreviewInput.value = "";
        updateCredentialControls();
        downloadCredential(credential);
      } else if (!credentialStatus) {
        credentialStatus = await authorRequest("/v1/author/status");
        updateCredentialControls();
      }

      if (!uploadIsAllowed()) {
        throw new Error("This submission is not open for another revision.");
      }
      const revision = Number(credentialStatus && credentialStatus.revision || 0) > 0;
      setStatus(revision ?
        "Sending the checked revision directly to private GitHub review…" :
        "Sending the checked archive directly to private GitHub review…", "working");
      const uploaded = await upload(checkedPackage, credential, revision);
      credentialStatus = uploaded;
      dashboardLoaded = false;
      updateCredentialControls();
      showResult(uploaded);
      setStatus(revision ?
        "Revision complete. This server did not retain the uploaded archive." :
        "Submission complete. This server did not retain the uploaded archive.", "success");
      await refreshSubmission();
    } catch (error) {
      const retry = credential ?
        " Your AIDaR key remains active on this page; retry without registering again." : "";
      setStatus(error.message + retry, "error");
      submitButton.disabled = !uploadIsAllowed();
    } finally {
      checkButton.disabled = false;
    }
  });

  const stored = readStoredCredentials();
  if (stored.length) credential = stored[0];
  updateCredentialControls();
})();
