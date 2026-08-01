#!/usr/bin/env python3
"""Create AIDaR's access and refresh credentials without storing a password."""

import base64
import json
import os
from datetime import datetime, timezone
from getpass import getpass
from pathlib import Path

from openreview.api import OpenReviewClient


def jwt_exp(token: str) -> int:
    parts = token.split(".")
    if len(parts) != 3:
        raise RuntimeError("OpenReview returned a credential with an invalid shape")
    payload = parts[1] + ("=" * (-len(parts[1]) % 4))
    claims = json.loads(base64.urlsafe_b64decode(payload))
    expiration = claims.get("exp")
    if not isinstance(expiration, int) or expiration <= 0:
        raise RuntimeError("OpenReview returned a credential without an expiration")
    return expiration


def write_secret(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(value + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    path.chmod(0o600)


client = OpenReviewClient(
    baseurl="https://api2.openreview.net",
    username=input("OpenReview username: "),
    password=getpass("OpenReview password: "),
    tokenExpiresIn=604800,
)

refresh_cookies = [
    cookie
    for cookie in client.session.cookies
    if cookie.name == "openreview.refreshToken"
    and cookie.domain.lstrip(".") in {"openreview.net", "api2.openreview.net"}
    and cookie.secure
]
if len(refresh_cookies) != 1:
    raise RuntimeError("OpenReview did not return exactly one refresh credential")

access_token = client.token
refresh_token = refresh_cookies[0].value
access_exp = jwt_exp(access_token)
refresh_exp = jwt_exp(refresh_token)

directory = Path.home() / ".config/aidar"
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
directory.chmod(0o700)
access_path = directory / "openreview-token"
refresh_path = directory / "openreview-refresh-token"
write_secret(access_path, access_token)
write_secret(refresh_path, refresh_token)

access_date = datetime.fromtimestamp(access_exp, tz=timezone.utc).isoformat()
refresh_date = datetime.fromtimestamp(refresh_exp, tz=timezone.utc).isoformat()
print(f"Saved the access credential to {access_path} (expires {access_date})")
print(f"Saved the refresh credential to {refresh_path} (expires {refresh_date})")
print("No username or password was stored.")
