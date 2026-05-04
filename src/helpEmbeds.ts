import { EMBED_FOOTER } from './constants';

/**
 * Builds the help embed array — 3 separate embeds matching the design:
 *   Embed 1 (blurple #5865F2) — Search & Browse  (title + description + footer)
 *   Embed 2 (green   #57F287) — Audio & Queue
 *   Embed 3 (cyan    #1ABC9C) — Playback Controls
 *
 * botEnabled = true  → slash command syntax  e.g. `/search <query>`
 * botEnabled = false → text command syntax   e.g. `!search <query>`
 */
export function buildHelpEmbeds(botEnabled: boolean): object {
  const p = botEnabled ? '/' : '!';

  // cmd(name, ...args) → `` `/name <arg1> <arg2>` ``
  const cmd = (name: string, ...args: string[]) => {
    const argStr = args.length ? ` <${args.join('> <')}>` : '';
    return `\`${p}${name}${argStr}\``;
  };

  return {
    embeds: [
      // ── Embed 1: Search & Browse ──────────────────────────────────────────
      {
        color: 0x5865f2,
        title: 'Available Commands',
        description: botEnabled
          ? 'Slash commands. Mandatory arguments are shown in `<>`.'
          : 'The prefix is `!`. Mandatory arguments are in `<>`, optional in `[]`.',
        fields: [
          {
            name: '🔍 Search & Browse',
            value: [
              `${cmd('search', 'query')} — play top result instantly`,
              `${cmd('play', 'url')} | ${cmd('audio', 'url')} — play audio (YouTube, Spotify, SoundCloud, etc.)`,
              `${cmd('start')} — stream from local folder`,
              '',
              `${cmd('search-pick', 'query')} — choose from top 5`,
              `${cmd('music-search', 'query')} — search and play as audio`,
              '',
              `${cmd('search-channel', 'name')} — browse a channel's videos`,
              botEnabled
                ? `${cmd('pick', 'number')} — play video by number`
                : `\`!next\` , \`!prev\` / \`!page <n>\` — navigate pages\n${cmd('pick', 'n')} — play video by number`,
            ].join('\n'),
          },
        ],
        footer: { text: EMBED_FOOTER },
        timestamp: new Date().toISOString(),
      },

      // ── Embed 2: Audio & Queue ────────────────────────────────────────────
      {
        color: 0x57f287,
        fields: [
          {
            name: '🎵 Audio & Queue',
            value: [
              `${cmd('audio-mode')} — toggle audio-only mode (all plays become audio)`,
              `${cmd('audio', 'url')} — play audio direct link`,
              '',
              `${cmd('aq')} — show audio queue`,
              `${cmd('aq-remove', 'n')} — remove item from audio queue`,
              `${cmd('aq-clear')} — clear audio queue`,
              '',
              `${cmd('loop-audio')} — loop current audio track`,
              `${cmd('loop-audio-queue')} — loop entire audio queue`,
              '',
              `${cmd('queue')} — show video queue`,
              `${cmd('queue-add', 'url')} | ${cmd('queue-play')} | ${cmd('queue-clear')}`,
            ].join('\n'),
          },
        ],
      },

      // ── Embed 3: Playback Controls ────────────────────────────────────────
      {
        color: 0x1abc9c,
        fields: [
          {
            name: '▶️ Playback Controls',
            value: [
              `${cmd('pause')} — pause the stream`,
              `${cmd('resume')} — resume the stream`,
              `${cmd('skip')} — skip to next in queue`,
              `${cmd('loop')} — loop current track`,
              `${cmd('loopqueue')} — loop entire queue`,
              `${cmd('stop')} — stop and leave voice`,
            ].join('\n'),
          },
        ],
      },
    ],
  };
}
