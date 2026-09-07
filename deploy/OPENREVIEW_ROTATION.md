# Repair the July 2026 OpenReview rotation deployment

The scheduled refresh must set the replacement access token's mode before
changing its owner to `aidar`. The unit intentionally lacks `CAP_FOWNER`, so
running `chmod` after `chown` fails. A manual root invocation does not reproduce
this restriction. The corrected program is `refresh-openreview-token.sh`.

For the affected deployment, run from the repository root:

```sh
sudo sh deploy/repair-openreview-rotation.sh
```

Optionally append an author's OpenReview note ID for a read-only check of that
submission. The repair verifies the installed program's checksum, tests both
permission sequences with disposable files under the restricted capabilities,
backs up the old program, installs the correction, and starts the actual
systemd refresh unit. It does not claim the author's link or upload any files.
It leaves unrelated installed versions untouched.

Confirm `aidar-openreview-token.service` succeeds and its timer remains active.
Use the journal's expiration messages to confirm a token was installed. The
`/health` endpoint only reports process health and configured modes; it does not
prove that OpenReview authentication works. Keep credentials out of diagnostic
output and test future rotation changes through the unit, not only as root.
