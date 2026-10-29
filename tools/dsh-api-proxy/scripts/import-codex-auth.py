#!/usr/bin/env python3
"""Import ~/.codex/auth.json ChatGPT tokens into ~/.dsh-api-proxy/codex-*.json."""

from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path


def b64url_json(segment: str) -> dict:
    segment += "=" * (-len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(segment))


def main() -> None:
    src = json.loads((Path.home() / ".codex" / "auth.json").read_text())
    tokens = src["tokens"]
    id_token = tokens["id_token"]
    claims = b64url_json(id_token.split(".")[1])
    auth = claims.get("https://api.openai.com/auth") or {}
    email = claims.get("email") or "unknown"
    account_id = tokens.get("account_id") or auth.get("chatgpt_account_id") or ""
    plan = auth.get("chatgpt_plan_type") or claims.get("chatgpt_plan_type")

    try:
        at_claims = b64url_json(tokens["access_token"].split(".")[1])
        exp = at_claims.get("exp")
        expired = (
            datetime.fromtimestamp(exp, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
            if exp
            else None
        )
    except Exception:
        expired = None
    if not expired:
        expired = (
            (datetime.now(timezone.utc) + timedelta(hours=1))
            .isoformat()
            .replace("+00:00", "Z")
        )

    out = {
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "last_refresh": src.get("last_refresh")
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "email": email,
        "type": "codex",
        "expired": expired,
        "account_uuid": account_id,
        "id_token": id_token,
        "plan_type": plan,
    }

    auth_dir = Path.home() / ".dsh-api-proxy"
    auth_dir.mkdir(mode=0o700, exist_ok=True)
    sanitized = "".join(
        c if c.isalnum() or c in "@._-" else "_" for c in email
    ).replace("..", "_")
    path = auth_dir / f"codex-{sanitized}.json"
    path.write_text(json.dumps(out, indent=2))
    os.chmod(path, 0o600)
    print(f"wrote {path}")
    print(f"email={email} plan={plan} account={account_id} expired={expired}")


if __name__ == "__main__":
    main()
