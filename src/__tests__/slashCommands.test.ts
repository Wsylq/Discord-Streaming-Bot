import * as fc from 'fast-check';
import { SLASH_COMMANDS } from '../slashCommands';

// All 26 command names required by Requirement 4.1
const REQUIRED_COMMAND_NAMES = [
  'help', 'start', 'play', 'audio', 'search', 'search-pick', 'search-channel',
  'music-search', 'music-search-pick', 'pick', 'pause', 'resume', 'stop', 'skip',
  'loop', 'loopqueue', 'queue', 'queue-add', 'queue-play', 'queue-clear',
  'audio-mode', 'aq', 'aq-remove', 'aq-clear', 'loop-audio', 'loop-audio-queue',
];

// Commands that require a string option (type 3)
const STRING_OPTION_COMMANDS: Record<string, string> = {
  play: 'url',
  audio: 'url',
  search: 'query',
  'search-pick': 'query',
  'search-channel': 'name',
  'music-search': 'query',
  'music-search-pick': 'query',
  'queue-add': 'url',
};

// Commands that require an integer option (type 4)
const INTEGER_OPTION_COMMANDS: Record<string, string> = {
  pick: 'number',
  'aq-remove': 'number',
};

describe('SLASH_COMMANDS', () => {
  it('exports an array', () => {
    expect(Array.isArray(SLASH_COMMANDS)).toBe(true);
  });

  it('contains exactly 26 commands', () => {
    expect(SLASH_COMMANDS).toHaveLength(26);
  });

  it('contains all 26 required command names', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    for (const required of REQUIRED_COMMAND_NAMES) {
      expect(names).toContain(required);
    }
  });

  it('all commands have type 1 (CHAT_INPUT)', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.type).toBe(1);
    }
  });

  it('all commands have a non-empty description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(typeof (cmd as { description?: string }).description).toBe('string');
      expect((cmd as { description?: string }).description!.length).toBeGreaterThan(0);
    }
  });

  it('commands with string arguments have the correct option name and type 3', () => {
    for (const [cmdName, optionName] of Object.entries(STRING_OPTION_COMMANDS)) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
      expect(cmd).toBeDefined();
      const options = (cmd as { options?: Array<{ name: string; type: number; required?: boolean }> }).options;
      expect(Array.isArray(options)).toBe(true);
      const opt = options!.find((o) => o.name === optionName);
      expect(opt).toBeDefined();
      expect(opt!.type).toBe(3);
      expect(opt!.required).toBe(true);
    }
  });

  it('commands with integer arguments have the correct option name and type 4', () => {
    for (const [cmdName, optionName] of Object.entries(INTEGER_OPTION_COMMANDS)) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
      expect(cmd).toBeDefined();
      const options = (cmd as { options?: Array<{ name: string; type: number; required?: boolean }> }).options;
      expect(Array.isArray(options)).toBe(true);
      const opt = options!.find((o) => o.name === optionName);
      expect(opt).toBeDefined();
      expect(opt!.type).toBe(4);
      expect(opt!.required).toBe(true);
    }
  });

  it('commands without arguments have no options array or an empty one', () => {
    const commandsWithArgs = new Set([
      ...Object.keys(STRING_OPTION_COMMANDS),
      ...Object.keys(INTEGER_OPTION_COMMANDS),
    ]);
    for (const cmd of SLASH_COMMANDS) {
      if (!commandsWithArgs.has(cmd.name)) {
        const options = (cmd as { options?: unknown[] }).options;
        expect(!options || options.length === 0).toBe(true);
      }
    }
  });

  // Feature: discord-bot-integration, Property 3: All required slash commands are registered with correct argument schemas
  // Validates: Requirements 3.1, 4.1
  it('Property 3: every required command name is present and argument schemas are correct', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REQUIRED_COMMAND_NAMES),
        (cmdName) => {
          const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
          // Command must exist
          if (!cmd) return false;

          const options = (cmd as { options?: Array<{ name: string; type: number; required?: boolean }> }).options ?? [];

          // Check string options
          if (cmdName in STRING_OPTION_COMMANDS) {
            const optName = STRING_OPTION_COMMANDS[cmdName]!;
            const opt = options.find((o) => o.name === optName);
            if (!opt || opt.type !== 3 || opt.required !== true) return false;
          }

          // Check integer options
          if (cmdName in INTEGER_OPTION_COMMANDS) {
            const optName = INTEGER_OPTION_COMMANDS[cmdName]!;
            const opt = options.find((o) => o.name === optName);
            if (!opt || opt.type !== 4 || opt.required !== true) return false;
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
