/**
 * cloudi: the Teams pre-join camera decision. Upstream turns the camera OFF; an avatar bot
 * (botConfig.cameraOn — the embedder installed a virtual camera) must never click camera-off and
 * turns the camera ON when the pre-join shows it off.
 *
 * Drives the SHIPPED `joinMicrosoftTeams` against a fake page on which every control is present
 * and clickable, and records which selectors were clicked. Whatever the flow does after the
 * pre-join is irrelevant here, so a late throw is tolerated.
 *
 * Run: npx tsx src/msteams/camera.test.ts
 */

import { joinMicrosoftTeams } from './join';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

/** A Teams page where every locator resolves; returns the selectors that were clicked. */
async function clickedDuringJoin(cameraOn: boolean | undefined): Promise<string[]> {
  const clicked: string[] = [];
  const loc = (sel: string): any => ({
    first: () => loc(sel),
    waitFor: async () => {},
    isVisible: async () => sel.includes('Join now'),
    click: async () => { clicked.push(sel); },
    count: async () => 0,
    getAttribute: async () => null,
    textContent: async () => '',
  });
  const page: any = {
    goto: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://teams.microsoft.com/v2/?meetingjoin=true',
    locator: loc,
    evaluate: async () => 'ok',
    waitForSelector: async () => null,
    $: async () => null,
    $$: async () => [],
  };
  const realLog = console.log;
  console.log = () => {};
  try {
    await joinMicrosoftTeams(page, 'https://teams.microsoft.com/meet/1?p=x', 'Vexa', { platform: 'teams', cameraOn });
  } catch { /* past the pre-join — not under test */ } finally { console.log = realLog; }
  return clicked;
}

const isOff = (s: string) => /Turn (off|camera off|video off)/.test(s);
const isOn = (s: string) => /Turn (on|camera on|video on)/.test(s);

(async () => {
  console.log('\n=== cloudi: Teams pre-join camera decision ===');

  const upstream = await clickedDuringJoin(undefined);
  check('no avatar: the camera-off toggle is clicked (upstream)', upstream.some(isOff), JSON.stringify(upstream));
  check('no avatar: camera-on is never clicked', !upstream.some(isOn), JSON.stringify(upstream));

  const avatar = await clickedDuringJoin(true);
  check('avatar: camera-off is never clicked', !avatar.some(isOff), JSON.stringify(avatar));
  check('avatar: the camera-on toggle is clicked', avatar.some(isOn), JSON.stringify(avatar));

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
