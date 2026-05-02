// Feature: discord-video-selfbot
// Tests for commandHandler.ts — covers P4 (exact command matching) and P5 (idempotent start)

import * as fc from 'fast-check';
import { registerCommandHandler, StreamController, CommandHandlerDeps } from '../commandHandler';
import { VideoQueue } from '../videoQueue';

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

/** Build a minimal fake StreamController. */
function makeStreamController(overrides: Partial<StreamController> = {}): StreamController {
  return {
    isStreaming: false,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    skip: jest.fn().mockResolvedValue(undefined),
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

type MessageCreateHandler = (message: FakeMessage) => Promise<void>;

interface FakeVoiceState {
  channel: FakeVoiceChannel | null;
}

interface FakeVoiceChannel {
  id: string;
}

interface FakeMember {
  voice: FakeVoiceState;
}

interface FakeTextChannel {
  send: jest.Mock;
}

interface FakeMessage {
  author: { id: string };
  content: string;
  member: FakeMember | null;
  channel: FakeTextChannel;
}

/**
 * Creates a fake Discord Client that captures the messageCreate listener so
 * tests can fire messages directly.
 */
function makeClient(selfId: string): {
  client: CommandHandlerDeps['client'];
  fireMessage: (msg: FakeMessage) => Promise<void>;
} {
  let handler: MessageCreateHandler | null = null;

  const client = {
    user: { id: selfId },
    on: jest.fn((event: string, fn: MessageCreateHandler) => {
      if (event === 'messageCreate') {
        handler = fn;
      }
    }),
  } as unknown as CommandHandlerDeps['client'];

  const fireMessage = async (msg: FakeMessage) => {
    if (!handler) throw new Error('messageCreate handler not registered');
    await handler(msg);
  };

  return { client, fireMessage };
}

/** Build a fake message authored by the selfbot. */
function selfMessage(
  selfId: string,
  content: string,
  voiceChannel: FakeVoiceChannel | null = { id: 'vc-1' }
): FakeMessage {
  return {
    author: { id: selfId },
    content,
    member: { voice: { channel: voiceChannel } },
    channel: { send: jest.fn().mockResolvedValue(undefined) },
  };
}

/** Build a fake message authored by someone else. */
function otherMessage(content: string): FakeMessage {
  return {
    author: { id: 'other-user-999' },
    content,
    member: { voice: { channel: { id: 'vc-1' } } },
    channel: { send: jest.fn().mockResolvedValue(undefined) },
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('registerCommandHandler', () => {
  const SELF_ID = 'self-user-123';

  it('registers a messageCreate listener on the client', () => {
    const { client } = makeClient(SELF_ID);
    const sc = makeStreamController();
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });
    expect((client.on as jest.Mock)).toHaveBeenCalledWith('messageCreate', expect.any(Function));
  });

  // -------------------------------------------------------------------------
  // Author guard
  // -------------------------------------------------------------------------

  it('ignores messages from other users', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController();
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    await fireMessage(otherMessage('!start'));
    expect(sc.start).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // !start
  // -------------------------------------------------------------------------

  it('!start: calls streamController.start when user is in voice channel and queue is non-empty', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!start', { id: 'vc-1' });
    await fireMessage(msg);

    expect(sc.start).toHaveBeenCalledTimes(1);
  });

  it('!start: sends reply when user is not in a voice channel', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!start', null);
    await fireMessage(msg);

    expect(sc.start).not.toHaveBeenCalled();
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining('voice channel'));
  });

  it('!start: sends reply when queue is empty', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeEmptyQueue(), client });

    const msg = selfMessage(SELF_ID, '!start', { id: 'vc-1' });
    await fireMessage(msg);

    expect(sc.start).not.toHaveBeenCalled();
    expect(msg.channel.send).toHaveBeenCalledWith(expect.stringContaining('No videos found'));
  });

  // P5: Idempotent start — already streaming
  it('!start: silently ignores when already streaming (P5)', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!start', { id: 'vc-1' });
    await fireMessage(msg);

    expect(sc.start).not.toHaveBeenCalled();
    expect(msg.channel.send).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // !stop
  // -------------------------------------------------------------------------

  it('!stop: calls streamController.stop when user is in a voice channel', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!stop', { id: 'vc-1' });
    await fireMessage(msg);

    expect(sc.stop).toHaveBeenCalledTimes(1);
  });

  it('!stop: silently ignores when user is not in a voice channel', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!stop', null);
    await fireMessage(msg);

    expect(sc.stop).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // !skip
  // -------------------------------------------------------------------------

  it('!skip: calls streamController.skip when streaming', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: true });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!skip', { id: 'vc-1' });
    await fireMessage(msg);

    expect(sc.skip).toHaveBeenCalledTimes(1);
  });

  it('!skip: silently ignores when not streaming', async () => {
    const { client, fireMessage } = makeClient(SELF_ID);
    const sc = makeStreamController({ isStreaming: false });
    registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

    const msg = selfMessage(SELF_ID, '!skip', { id: 'vc-1' });
    await fireMessage(msg);

    expect(sc.skip).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('commandHandler property tests', () => {
  const SELF_ID = 'self-user-123';

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
          const { client, fireMessage } = makeClient(SELF_ID);
          const sc = makeStreamController({ isStreaming: true });
          registerCommandHandler({ streamController: sc, queue: makeQueue(), client });

          const msg = selfMessage(SELF_ID, content, { id: 'vc-1' });
          await fireMessage(msg);

          expect(sc.start).not.toHaveBeenCalled();
          expect(sc.stop).not.toHaveBeenCalled();
          expect(sc.skip).not.toHaveBeenCalled();
          expect(msg.channel.send).not.toHaveBeenCalled();
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
          const { client, fireMessage } = makeClient(SELF_ID);
          // isStreaming is already true
          const sc = makeStreamController({ isStreaming: true });
          const queue = makeQueue(files);
          registerCommandHandler({ streamController: sc, queue, client });

          const msg = selfMessage(SELF_ID, '!start', { id: 'vc-1' });
          await fireMessage(msg);

          expect(sc.start).not.toHaveBeenCalled();
          expect(msg.channel.send).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 25 }
    );
  });
});
