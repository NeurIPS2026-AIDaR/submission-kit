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

  let checkedPackage = null;
  let credential = null;

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
    const receipt = {
      version: 1,
      kind: "aidar-browser-credential",
      submission_id: value.submission_id,
      server: window.location.origin,
      author_token: value.author_token,
      created_at: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(receipt, null, 2) + "\n"], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "aidar-submission-" + value.submission_id + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
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
        openreview_url: document.querySelector("#openreview-url").value.trim(),
        invitation_code: document.querySelector("#invitation-code").value.trim()
      }),
      credentials: "omit",
      redirect: "error"
    });
    return responseJson(response);
  }

  async function upload(packaged, value) {
    const body = new FormData();
    body.append("archive", new Blob([packaged.archive], { type: "application/gzip" }), "submission.tar.gz");
    body.append("archive_sha256", packaged.digest);
    const response = await fetch("/v1/author/submit", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + value.author_token,
        "Idempotency-Key": crypto.randomUUID()
      },
      body,
      credentials: "omit",
      redirect: "error"
    });
    return responseJson(response);
  }

  function showResult(value) {
    result.hidden = false;
    result.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = "Submission received";
    const copy = document.createElement("p");
    copy.textContent = "Submission " + value.submission_id + " is now in private GitHub review. Keep the downloaded credential private and import it with the aidar tool before checking reviews or making revisions.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.textContent = "Download credential again";
    button.addEventListener("click", () => downloadCredential(credential));
    result.append(heading, copy, button);
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
      setStatus("Ready: " + inspected.files.length + " files, " + humanBytes(inspected.total) + binaryText + excludedText + ".", "success");
      submitButton.disabled = false;
      return true;
    } catch (error) {
      setStatus(error.message, "error");
      return false;
    } finally {
      checkButton.disabled = false;
    }
  }

  checkButton.addEventListener("click", check);
  folder.addEventListener("change", () => {
    checkedPackage = null;
    credential = null;
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
        credential = await register();
        downloadCredential(credential);
      }
      setStatus("Sending the checked archive directly to private GitHub review…", "working");
      const uploaded = await upload(checkedPackage, credential);
      showResult(uploaded);
      setStatus("Submission complete. This server did not retain the uploaded archive.", "success");
    } catch (error) {
      const retry = credential ? " Your private credential was downloaded; keep this page open and retry." : "";
      setStatus(error.message + retry, "error");
      submitButton.disabled = false;
    } finally {
      checkButton.disabled = false;
    }
  });
})();
