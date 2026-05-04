// Feature: discord-video-selfbot
// Tests for commandHandler.ts — covers P4 (exact command matching) and P5 (idempotent start)

import * as fc from 'fast-check';
import { registerCommandHandler, StreamController, CommandHandlerDeps } from '../commandHandler';
import { VideoQueue } from '../videoQueue';

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

const OWNER_ID = 'owner-user-123';
const TEXT_CHANNEL_ID = 'text-channel-456';
const VOICE_CHANNEL_ID = 'voice-channel-789';
const GUILD_ID = 'guild-id-000';

// Set env vars before tests run
beforeAll(() => {
  process.env['OWNER_ID'] = OWNER_ID;
  process.env['TEXT_CHANNEL_ID'] = TEXT_CHANNEL_ID;
  process.env['VOICE_CHANNEL_ID'] = VOICE_CHANNEL_ID;
  process.env['GUILD_ID'] = GUILD_ID;
});

afterAll(() => {
  delete process.env['OWNER_ID'];
  delete process.env['TEXT_CHANNEL_ID'];
  delete process.env['VOICE_CHANNEL_ID'];
  delete process.env['GUILD_ID'];
});

/** Build a minimal fake StreamController. */
function makeStreamController(overrides: Partial<StreamController> = {}): StreamController {
  return {
    isStreaming: false,
    isPaused: false,
    isInVoice: false,
    loopTrack: false,
    loopQueue: false,
    audioMode: false,
    loopAudioTrack: false,
    loopAudioQueue: false,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    skip: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(true),
    resume: jest.fn().mockResolvedValue(true),
    playUrl: jest.fn().mockResolvedValue(undefined),
    playAudio: jest.fn().mockResolvedValue(undefined),
    playFromQueue: jest.fn().mockResolvedValue(true),
    toggleAudioMode: jest.fn().mockReturnValue(false),
    toggleLoopAudioTrack: jest.fn().mockReturnValue(false),
    toggleLoopAudioQueue: jest.fn().mockReturnValue(false),
    toggleLoopTrack: jest.fn().mockReturnValue(false),
    toggleLoopQueue: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** Build a non-empty VideoQueue. */
function makeQueue(files: string[] = ['/videos/a.mp4']): VideoQueue {
  return { files, currentIndex: 0 };
}

/** Build an empty VideoQueue. */
function makeEmptyQueue(): VideoQueue {
  return { files: [], currentIndex: 0 };
}

// Raw packet type matching what commandHandler.ts expects
interface RawPacket {
  t: string;
  d: {
    content: string;
    channel_id: string;
    author: { id: string };
  };
}

type RawHandler = (packet: RawPacket) => Promise<void>;

interface FakeTextChannel {
  send: jest.Mock;
}

/**
 * Creates a fake Discord Client that captures the raw listener so
 * tests can fire raw packets directly.
 */
function makeClient(): {
  client: CommandHandlerDeps['client'];
  fireRaw: (packet: RawPacket) => Promise<void>;
  textChannelSend: jest.Mock;
} {
  let handler: RawHandler | null = null;
  const textChannelSend = jest.fn().mockResolvedValue(undefined);

  const fakeTextChannel: FakeTextChannel = { send: textChannelSend };

  const client = {
    user: { id: 'selfbot-user' },
    on: jest.fn((event: string, fn: RawHandler) => {
      if (event === 'raw') {
        handler = fn;
      }
    }),
    channels: {
      fetch: jest.fn().mockResolvedValue(fakeTextChannel),
    },
    guilds: {
      fetch: jest.fn().mockResolvedValue({}),
    },
  } as unknown as CommandHandlerDeps['client'];

  const fireRaw = async (packet: RawPacket) => {
    if (!handler) throw new Error('raw handler not registered');
    await handler(packet);
  };

  return { client, fireRaw, textChannelSend };
}

/** Build a raw packet from the owner in the text channel. */
function ownerPacket(content: string): RawPacket {
  return {
    t: 'MESSAGE_CREATE',
    d: {
      content,
      channel_id: TEXT_CHANNEL_ID,
      author: { id: OWNER_ID },
    },
  };
}

/** Build a raw packet from a non-owner user. */
function otherUserPacket(content: string): RawPacket {
  return {
    t: 'MESSAGE_CREATE',
    d: {
      content,
      channel_id: TEXT_CHANNEL_ID,
      author: { id: 'other-user-999' },
    },
  };
}

/** Build a raw packet from the owner but in a different channel. */
function wrongChannelPacket(content: string): RawPacket {
  return {
    t: 'MESSAGE_CREATE',
    d: {
      content,
      channel_id: 'wrong-channel-id',
      author: { id: OWNER_ID },
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('registerCommandHandler', () => {
  it('registers a raw listener on the client', () => {
    const { client } = makeClient();
    const sc = makeStreamController();
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });
    expect((client.on as jest.Mock)).toHaveBeenCalledWith('raw', expect.any(Function));
  });

  // -------------------------------------------------------------------------
  // Author guard
  // -------------------------------------------------------------------------

  it('ignores messages from other users', async () => {
    const { client, fireRaw } = makeClient();
    const sc = makeStreamController();
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(otherUserPacket('!start'));
    expect(sc.start).not.toHaveBeenCalled();
  });

  it('ignores messages from wrong channel', async () => {
    const { client, fireRaw } = makeClient();
    const sc = makeStreamController();
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(wrongChannelPacket('!start'));
    expect(sc.start).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // !start
  // -------------------------------------------------------------------------

  it('!start: calls streamController.start when queue is non-empty and not streaming', async () => {
    const { client, fireRaw } = makeClient();
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(ownerPacket('!start'));

    expect(sc.start).toHaveBeenCalledTimes(1);
  });

  it('!start: sends reply when queue is empty', async () => {
    const { client, fireRaw, textChannelSend } = makeClient();
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeEmptyQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(ownerPacket('!start'));

    expect(sc.start).not.toHaveBeenCalled();
    expect(textChannelSend).toHaveBeenCalledWith(expect.stringContaining('No videos found'));
  });

  // P5: Idempotent start — already streaming
  it('!start: silently ignores when already streaming (P5)', async () => {
    const { client, fireRaw, textChannelSend } = makeClient();
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(ownerPacket('!start'));

    expect(sc.start).not.toHaveBeenCalled();
    expect(textChannelSend).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // !stop
  // -------------------------------------------------------------------------

  it('!stop: calls streamController.stop', async () => {
    const { client, fireRaw } = makeClient();
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(ownerPacket('!stop'));

    expect(sc.stop).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // !skip
  // -------------------------------------------------------------------------

  it('!skip: calls streamController.skip when streaming', async () => {
    const { client, fireRaw } = makeClient();
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(ownerPacket('!skip'));

    expect(sc.skip).toHaveBeenCalledTimes(1);
  });

  it('!skip: silently ignores when not streaming', async () => {
    const { client, fireRaw } = makeClient();
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

    await fireRaw(ownerPacket('!skip'));

    expect(sc.skip).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('commandHandler property tests', () => {
  /**
   * P4: For any message string that is not exactly !start, !stop, or !skip,
   * the command handler SHALL NOT invoke any command action.
   *
   * Validates: Requirements 3.1, 5.1, 6.1
   */
  it('P4: non-exact command strings never trigger any action', async () => {
    // Feature: discord-video-selfbot, Property 4: Only exact command strings trigger handlers
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => s !== '!start' && s !== '!stop' && s !== '!skip'),
        async (content) => {
          const { client, fireRaw, textChannelSend } = makeClient();
          const sc = makeStreamController({ isStreaming: true });
          registerCommandHandler({ streamController: sc, queue: makeQueue(), client, browser: null, queueDisplay: null, audioQueueDisplay: null });

          await fireRaw(ownerPacket(content));

          expect(sc.start).not.toHaveBeenCalled();
          expect(sc.stop).not.toHaveBeenCalled();
          expect(sc.skip).not.toHaveBeenCalled();
          // Note: some commands like !pause, !resume, !loop etc. may send replies,
          // so we only check that the core stream control methods are not called.
        }
      ),
      { numRuns: 25 }
    );
  });

  /**
   * P5: For any streaming session that is already active, receiving a !start
   * command SHALL leave the streaming state unchanged.
   *
   * Validates: Requirements 3.7
   */
  it('P5: !start when already streaming never calls start or sends a reply', async () => {
    // Feature: discord-video-selfbot, Property 5: Duplicate start command is idempotent
    await fc.assert(
      fc.asyncProperty(
        // Generate a non-empty queue of arbitrary length
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
        async (files) => {
          const { client, fireRaw, textChannelSend } = makeClient();
          // isStreaming is already true
          const sc = makeStreamController({ isStreaming: true });
          const queue = makeQueue(files);
          registerCommandHandler({ streamController: sc, queue, client, browser: null, queueDisplay: null, audioQueueDisplay: null });

          await fireRaw(ownerPacket('!start'));

          expect(sc.start).not.toHaveBeenCalled();
          expect(textChannelSend).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 25 }
    );
  });
});
