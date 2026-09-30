"""cloudi: BOT_DEFAULT_AVATAR_URL rides every spawn's invocation.v1 ``defaultAvatarUrl``; unset → omitted."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from meeting_api.bot_spawn import request_bot
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.service import _AJV_URI

AVATAR = "https://meet.cloudi.cloud/brand/notetaker-avatar.png"


async def _spawned_invocation(monkeypatch, avatar):
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")
    if avatar is None:
        monkeypatch.delenv("BOT_DEFAULT_AVATAR_URL", raising=False)
    else:
        monkeypatch.setenv("BOT_DEFAULT_AVATAR_URL", avatar)
    runtime = FakeRuntimeClient()
    await request_bot(
        InMemoryMeetingRepo(), runtime, user_id=7, platform="google_meet",
        native_meeting_id="abc-defg-hij", bot_name="VexaBot",
        redis_url="redis://redis:6379/0", meeting_api_url="http://meeting-api:8080",
        token_secret="test-admin-token",
    )
    return json.loads(runtime.specs[-1]["env"]["VEXA_BOT_CONFIG"])


async def test_env_avatar_copied_into_invocation(monkeypatch):
    inv = await _spawned_invocation(monkeypatch, AVATAR)
    assert inv["defaultAvatarUrl"] == AVATAR


async def test_unset_avatar_omitted(monkeypatch):
    assert "defaultAvatarUrl" not in await _spawned_invocation(monkeypatch, None)
    assert "defaultAvatarUrl" not in await _spawned_invocation(monkeypatch, "")


async def test_malformed_avatar_omitted(monkeypatch):
    # The bot's ajv (format: uri) would reject these and fail EVERY bot at boot — omit them instead.
    for bad in ("meet.cloudi.cloud/x.png", "https://a b/c.png", "ftp://meet.cloudi.cloud/x.png", "https:///x.png", "https://meet.cloudi.cloud/<x>.png",
                "https://h.com/a%zz.png", "https://h.com/a%2.png", "https://h.com/[x].png",
                "https://h.com/x.png?a=[1]", "https://h.com/a#b#c", "https://h.com/x.png\n"):
        assert "defaultAvatarUrl" not in await _spawned_invocation(monkeypatch, bad), bad
    # a normal URL with query/percent-escapes still passes
    ok = "https://meet.cloudi.cloud/brand/notetaker%20avatar.png?v=2"
    assert (await _spawned_invocation(monkeypatch, ok))["defaultAvatarUrl"] == ok


PARITY_CASES = [
    AVATAR, "https://meet.cloudi.cloud/brand/notetaker%20avatar.png?v=2", "http://10.0.0.1:8080/a.png",
    "https://[::1]/a.png", "https://h.com/a#frag", "https://user:pw@h.com/a.png", "https://h.com",
    "meet.cloudi.cloud/x.png", "https://a b/c.png", "https:///x.png", "https://meet.cloudi.cloud/<x>.png",
    "https://h.com/a%zz.png", "https://h.com/a%2.png", "https://h.com/[x].png", "https://h.com/x.png?a=[1]",
    "https://h.com/a#b#c", "https://h.com/x.png\n", "ftp://h.com/x", "https://h.com/é.png", 'https://h.com/"x".png',
]
_AJV_FORMATS = Path(__file__).resolve().parents[2] / "bot" / "node_modules" / "ajv-formats"


@pytest.mark.skipif(not (shutil.which("node") and _AJV_FORMATS.is_dir()),
                    reason="node or the bot's ajv-formats not installed (pnpm install)")
def test_ported_uri_regex_matches_ajv_formats():
    # The Python regex is a verbatim port; this pins it to the bot's real validator on shared cases.
    script = ("const f=require(process.argv[1]).fullFormats.uri;"
              "process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map((u)=>f(u))))")
    out = subprocess.run(["node", "-e", script, str(_AJV_FORMATS / "dist" / "formats.js"), json.dumps(PARITY_CASES)],
                         capture_output=True, text=True, check=True).stdout
    ajv = json.loads(out)
    assert [bool(_AJV_URI.fullmatch(u)) for u in PARITY_CASES] == ajv

