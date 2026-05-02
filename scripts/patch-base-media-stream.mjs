/**
 * Patches @dank074/discord-video-stream for better A/V sync:
 *
 * 1. WebRtcWrapper: sets audio playoutDelayMax to 10 (same as video)
 *    so Discord's jitter buffer treats both streams equally.
 *
 * 2. newApi: sets syncTolerance to 100ms on both video and audio streams.
 *    Default 20ms is too tight — variable send times cause constant
 *    oscillation. 100ms gives the jitter buffer room to absorb send
 *    variance while still correcting real drift automatically.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// --- Patch 1: WebRtcWrapper playout delay ---
{
  const target = resolve('node_modules/@dank074/discord-video-stream/dist/client/voice/WebRtcWrapper.js');
  const ORIGINAL = `        rtpConfigAudio.playoutDelayId = 5;\n        rtpConfigAudio.playoutDelayMin = 0;\n        rtpConfigAudio.playoutDelayMax = 1;`;
  const PATCHED  = `        rtpConfigAudio.playoutDelayId = 5;\n        rtpConfigAudio.playoutDelayMin = 0;\n        rtpConfigAudio.playoutDelayMax = 10; // patched: match video playout delay`;

  let src = readFileSync(target, 'utf8');
  if (!src.includes('playoutDelayMax = 1;')) {
    console.log('[patch] WebRtcWrapper already patched, skipping.');
  } else {
    src = src.replace(ORIGINAL, PATCHED);
    writeFileSync(target, src, 'utf8');
    console.log('[patch] WebRtcWrapper patched.');
  }
}

// --- Patch 2: newApi syncTolerance ---
{
  const target = resolve('node_modules/@dank074/discord-video-stream/dist/media/newApi.js');
  const ORIGINAL = `        vStream.syncStream = aStream;\n        const burstTime = mergedOptions.readrateInitialBurst;`;
  const PATCHED  = `        vStream.syncStream = aStream;\n        // Wider tolerance so sync correction triggers more aggressively.\n        // Default 20ms is too tight — variable send times cause constant\n        // "behind/ahead" oscillation. 100ms gives the jitter buffer room\n        // to absorb send variance while still correcting real drift.\n        vStream.syncTolerance = 100;\n        aStream.syncTolerance = 100;\n        const burstTime = mergedOptions.readrateInitialBurst;`;

  let src = readFileSync(target, 'utf8');
  if (src.includes('syncTolerance = 100')) {
    console.log('[patch] newApi syncTolerance already patched, skipping.');
  } else if (!src.includes(ORIGINAL)) {
    console.warn('[patch] WARNING: newApi patch target not found — library may have updated. Skipping.');
  } else {
    src = src.replace(ORIGINAL, PATCHED);
    writeFileSync(target, src, 'utf8');
    console.log('[patch] newApi syncTolerance patched.');
  }
}
