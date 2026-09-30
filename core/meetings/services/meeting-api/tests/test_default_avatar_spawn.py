"""cloudi: BOT_DEFAULT_AVATAR_URL rides every spawn's invocation.v1 ``defaultAvatarUrl``; unset → omitted."""
from __future__ import annotations

import json

from meeting_api.bot_spawn import request_bot
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo

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
