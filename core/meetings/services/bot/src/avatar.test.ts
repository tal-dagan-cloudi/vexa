/**
 * cloudi: avatar camera (invocation.v1 `defaultAvatarUrl`).
 *
 *   1. loadAvatarDataUrl — the "avatar enabled → keep camera on" decision: only a fetched image
 *      turns the camera on; unset / non-http / HTTP error / non-image / oversize / network error
 *      all return null (the bot joins camera-off as upstream) and never throw.
 *   2. headless Chromium launched with the bot's join args (incl. the /dev/null fake capture file):
 *      the init script serves the image as a 1280x720 video track, hands audio constraints to the
 *      original getUserMedia untouched, and lists a camera in enumerateDevices.
 *
 * Where headless Chromium cannot launch the browser half SKIPS LOUDLY (exit 0), like the other
 * boundary tests. Run: npx tsx src/avatar.test.ts
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentBrowser, type BrowserContext } from '@vexa/remote-browser';
import { getJoinBrowserArgs } from '@vexa/join';
import { avatarCameraInitScript, loadAvatarDataUrl } from './avatar.js';
import { parseInvocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const URL_OK = 'https://meet.cloudi.cloud/brand/notetaker-avatar.png';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><rect width="9" height="9" fill="#ff0000"/></svg>';

function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const f = (async (url: string) => { calls.push(String(url)); return respond(); }) as unknown as typeof fetch;
  return { f, calls };
}

async function unit(): Promise<string> {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  const unset = stubFetch(() => new Response(SVG));
  check('unset URL → camera stays off, nothing fetched', await loadAvatarDataUrl(undefined, unset.f, warn) === null && unset.calls.length === 0);

  const ok = stubFetch(() => new Response(SVG, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } }));
  const dataUrl = await loadAvatarDataUrl(URL_OK, ok.f, warn);
  check('fetched image → data URL (camera on)', dataUrl === `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`, String(dataUrl));
  check('fetched exactly once, from the configured URL', ok.calls.length === 1 && ok.calls[0] === URL_OK, JSON.stringify(ok.calls));
  check('success logs no warning', warnings.length === 0, JSON.stringify(warnings));

  const fails: [string, string, ReturnType<typeof stubFetch>][] = [
    ['HTTP 404', URL_OK, stubFetch(() => new Response('nope', { status: 404, headers: { 'content-type': 'image/png' } }))],
    ['non-image content-type', URL_OK, stubFetch(() => new Response('<html>', { headers: { 'content-type': 'text/html' } }))],
    ['empty body', URL_OK, stubFetch(() => new Response(new Uint8Array(0), { headers: { 'content-type': 'image/png' } }))],
    ['oversize body', URL_OK, stubFetch(() => new Response(new Uint8Array(2 * 1024 * 1024), { headers: { 'content-type': 'image/png' } }))],
    ['network error', URL_OK, stubFetch(() => { throw new Error('ECONNREFUSED'); })],
    ['non-http scheme', 'file:///etc/passwd', stubFetch(() => new Response(SVG))],
  ];
  for (const [name, url, s] of fails) {
    const before = warnings.length;
    check(`${name} → null (camera-off fallback) with a warning`, await loadAvatarDataUrl(url, s.f, warn) === null && warnings.length === before + 1, JSON.stringify(warnings.slice(before)));
  }

  const inv = parseInvocation(JSON.stringify({
    platform: 'google_meet', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Vexa',
    redisUrl: 'redis://redis:6379/0', defaultAvatarUrl: URL_OK,
  }));
  check('invocation.v1 carries defaultAvatarUrl through the bot parser', inv.defaultAvatarUrl === URL_OK);
  return dataUrl!;
}

async function browser(dataUrl: string): Promise<void> {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body></body>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dataDir = mkdtempSync(join(tmpdir(), 'vexa-avatar-'));
  let context: BrowserContext;
  let page;
  try {
    ({ context, page } = await launchPersistentBrowser({ dataDir, args: [...getJoinBrowserArgs(), '--mute-audio'], headless: true }));
  } catch (e) {
    console.log(`  ⚠️ SKIP — headless Chromium unavailable in this environment: ${(e as Error).message?.split('\n')[0]}`);
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
    return;
  }
  try {
    // A recording stand-in for the browser's own getUserMedia (installed first, so the avatar
    // override wraps it exactly as it wraps the real one): proves what audio requests receive.
    await context.addInitScript(`(() => {
      window.__gumCalls = [];
      navigator.mediaDevices.getUserMedia = async (c) => {
        window.__gumCalls.push(JSON.stringify(c));
        if (c && c.video) throw new Error('original getUserMedia reached for video');
        const ac = new AudioContext();
        return ac.createMediaStreamDestination().stream;
      };
      // The bot container has no camera device; model that on any host.
      navigator.mediaDevices.enumerateDevices = async () => [];
    })();`);
    await context.addInitScript(avatarCameraInitScript(dataUrl));
    await page.goto(origin);

    const r = await page.evaluate(`(async () => {
      const both = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false }, video: { width: 640 } });
      const v = both.getVideoTracks()[0];
      const settings = v.getSettings();
      const video = document.createElement('video');
      video.muted = true; video.srcObject = new MediaStream([v]);
      await video.play();
      await new Promise((res) => setTimeout(res, 800));
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0, 1280, 720);
      const px = Array.from(ctx.getImageData(640, 360, 1, 1).data);
      const edge = Array.from(ctx.getImageData(5, 360, 1, 1).data);
      v.stop();
      const again = await navigator.mediaDevices.getUserMedia({ video: true });
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        audio: both.getAudioTracks().length, videoTracks: both.getVideoTracks().length,
        width: settings.width, height: settings.height, px, edge,
        againLive: again.getVideoTracks()[0] && again.getVideoTracks()[0].readyState,
        audioOnlyVideo: audioOnly.getVideoTracks().length,
        calls: window.__gumCalls,
        cameras: devices.filter((d) => d.kind === 'videoinput').map((d) => d.label),
        cameraJson: JSON.stringify(devices.find((d) => d.kind === 'videoinput')),
        isDeviceInfo: devices.every((d) => d instanceof MediaDeviceInfo),
        caps: (() => { const c = devices.find((d) => d.kind === 'videoinput'); return c && c.getCapabilities ? c.getCapabilities().width.max : null; })(),
        cameraPerm: (await navigator.permissions.query({ name: 'camera' })).state,
      };
    })()`) as any;

    check('audio+video request → one audio track (original) + one avatar video track', r.audio === 1 && r.videoTracks === 1, JSON.stringify(r));
    check('original getUserMedia got ONLY the audio constraints, untouched', r.calls[0] === JSON.stringify({ audio: { echoCancellation: false } }), JSON.stringify(r.calls));
    check('video track is 1280x720', r.width === 1280 && r.height === 720, `${r.width}x${r.height}`);
    check('frames carry the avatar (centre pixel red)', r.px[0] > 200 && r.px[1] < 60 && r.px[2] < 60, JSON.stringify(r.px));
    check('letterbox is the dark background', r.edge[0] < 60 && r.edge[1] < 60 && r.edge[2] < 60, JSON.stringify(r.edge));
    check('a stopped track does not kill the camera (next request is live)', r.againLive === 'live', String(r.againLive));
    check('audio-only request passes through unchanged (no video added)', r.audioOnlyVideo === 0 && r.calls[1] === JSON.stringify({ audio: true }), JSON.stringify(r.calls));
    check('video-only requests never reach the original (/dev/null capture file bypassed)', r.calls.length === 2, JSON.stringify(r.calls));
    check('enumerateDevices lists the avatar camera when there is none', r.cameras.length === 1 && r.cameras[0] === 'Avatar Camera', JSON.stringify(r.cameras));
    check('the listed camera serializes and is a MediaDeviceInfo', r.isDeviceInfo && /videoinput/.test(r.cameraJson), r.cameraJson);
    check('the listed camera answers getCapabilities (InputDeviceInfo shape)', r.caps === 1280, String(r.caps));
    check('camera permission reads granted', r.cameraPerm === 'granted', String(r.cameraPerm));
  } finally {
    await context.close().catch(() => { /* best-effort */ });
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  console.log('\n=== cloudi: avatar camera ===');
  const dataUrl = await unit();
  await browser(dataUrl);
  console.log(failed ? `\n❌ ${failed} avatar check(s) failed` : '\n✅ avatar camera: all checks passed');
  process.exit(failed ? 1 : 0);
})();
