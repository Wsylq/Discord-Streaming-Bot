/**
 * Patches @dank074/discord-video-stream for better A/V sync:
 *
 * 1. WebRtcWrapper: sets audio playoutDelayMax to 10 (same as video)
 *    so Discord's jitter buffer treats both streams equally.
 *    Default is 1ms for audio vs 10ms for video, causing audio to play
 *    earlier than video when there's any send jitter.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// --- Patch 1: WebRtcWrapper playout delay ---
const wrtcTarget = resolve('node_modules/@dank074/discord-video-stream/dist/client/voice/WebRtcWrapper.js');

const WRTC_ORIGINAL = `        rtpConfigAudio.playoutDelayId = 5;
        rtpConfigAudio.playoutDelayMin = 0;
        rtpConfigAudio.playoutDelayMax = 1;`;

const WRTC_PATCHED = `        rtpConfigAudio.playoutDelayId = 5;
        rtpConfigAudio.playoutDelayMin = 0;
        rtpConfigAudio.playoutDelayMax = 10; // patched: match video playout delay`;

let wrtcSrc = readFileSync(wrtcTarget, 'utf8');
if (wrtcSrc.includes(WRTC_PATCHED) || wrtcSrc.includes('playoutDelayMax = 10; // patched') || 
    (wrtcSrc.includes('playoutDelayMax = 10') && !wrtcSrc.includes('playoutDelayMax = 1;'))) {
  console.log('[patch] WebRtcWrapper already patched, skipping.');
} else if (!wrtcSrc.includes(WRTC_ORIGINAL)) {
  console.warn('[patch] WARNING: WebRtcWrapper patch target not found — library may have updated. Skipping.');
} else {
  wrtcSrc = wrtcSrc.replace(WRTC_ORIGINAL, WRTC_PATCHED);
  writeFileSync(wrtcTarget, wrtcSrc, 'utf8');
  console.log('[patch] WebRtcWrapper patched successfully.');
}
