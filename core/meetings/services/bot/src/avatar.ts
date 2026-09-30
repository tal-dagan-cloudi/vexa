/**
 * cloudi: a static avatar image as the bot's camera (invocation.v1 `defaultAvatarUrl`).
 *
 * The image is fetched ONCE in Node (no page-side CORS), inlined as a data URL, and drawn onto a
 * 1280x720 canvas whose captureStream(5) becomes the video track of every getUserMedia call that
 * asks for video. Audio constraints still go to the browser's own getUserMedia, so the bot's mic
 * and capture behave exactly as without an avatar. The launch flag
 * `--use-file-for-fake-video-capture=/dev/null` is never reached: the override answers video
 * requests before Chromium's capture device is asked.
 */

const MAX_AVATAR_BYTES = 1024 * 1024;   // the data URL rides every frame's init script
const FETCH_TIMEOUT_MS = 10_000;

/** Fetch the avatar and return it as a data URL, or null (logged) on ANY failure — the caller then
 *  joins camera-off as before. Never throws: an avatar must never fail a join. */
export async function loadAvatarDataUrl(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  warn: (m: string) => void = (m) => console.warn(m),
): Promise<string | null> {
  if (!url) return null;
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('not an http(s) URL');
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new Error(`content-type '${type}' is not an image`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_AVATAR_BYTES) throw new Error(`size ${body.length} bytes`);
    return `data:${type};base64,${body.toString('base64')}`;
  } catch (e) {
    warn(`[bot] avatar: could not load ${url} (${String(e)}) — joining camera-off`);
    return null;
  }
}

/** The page-side init script (runs at document-start in every frame) that serves `dataUrl` as the
 *  camera. One canvas per frame; each video request gets a clone of its track, so the platform
 *  stopping a track on camera toggle never kills the source. */
export function avatarCameraInitScript(dataUrl: string): string {
  return `(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || window.__vexaAvatarCamera) return;
  window.__vexaAvatarCamera = true;
  const W = 1280, H = 720, FPS = 5;
  let track = null;
  const avatarTrack = () => {
    if (!track || track.readyState === 'ended') {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      const draw = () => {
        ctx.fillStyle = '#1f1f1f';
        ctx.fillRect(0, 0, W, H);
        if (img.naturalWidth) {
          const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
          const w = img.naturalWidth * s, h = img.naturalHeight * s;
          ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        }
      };
      img.onload = draw;
      img.src = ${JSON.stringify(dataUrl)};
      draw();
      // Repaint so the stream keeps producing frames: a never-dirty canvas emits none, and
      // receivers render a frozen/black tile.
      setInterval(draw, 1000 / FPS);
      track = canvas.captureStream(FPS).getVideoTracks()[0];
    }
    return track.clone();
  };
  const origGetUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.video) return origGetUserMedia(constraints);
    const stream = constraints.audio ? await origGetUserMedia({ audio: constraints.audio }) : new MediaStream();
    stream.addTrack(avatarTrack());
    return stream;
  };
  // The container has no real camera; platforms grey out their camera toggle when
  // enumerateDevices lists no videoinput.
  const origEnumerate = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => {
    const devices = await origEnumerate();
    if (devices.some((d) => d.kind === 'videoinput')) return devices;
    const fields = { deviceId: 'vexa-avatar', groupId: 'vexa-avatar', kind: 'videoinput', label: 'Avatar Camera' };
    // Chrome lists inputs as InputDeviceInfo (MediaDeviceInfo + getCapabilities).
    const camera = Object.create((window.InputDeviceInfo || MediaDeviceInfo).prototype);
    for (const [k, v] of Object.entries(fields)) Object.defineProperty(camera, k, { value: v, enumerable: true });
    Object.defineProperty(camera, 'toJSON', { value: () => ({ ...fields }) });
    Object.defineProperty(camera, 'getCapabilities', { value: () => ({ deviceId: fields.deviceId, groupId: fields.groupId, width: { min: 1, max: W }, height: { min: 1, max: H }, frameRate: { min: 1, max: FPS } }) });
    return [...devices, camera];
  };
  // Video requests never reach Chromium's own capture, so its camera permission would stay 'prompt'.
  const perms = navigator.permissions;
  if (perms && perms.query) {
    const origQuery = perms.query.bind(perms);
    perms.query = async (desc) => {
      const status = await origQuery(desc);
      if (!desc || desc.name !== 'camera') return status;
      try { Object.defineProperty(status, 'state', { value: 'granted', configurable: true }); } catch (e) {}
      return status;
    };
  }
})();`;
}
