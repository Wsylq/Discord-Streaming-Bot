import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as fc from 'fast-check';

// Mock dotenv so it never reads the real .env file during tests.
// Tests set process.env directly to control the config inputs.
jest.mock('dotenv', () => ({ config: jest.fn() }));

// We need to isolate module state between tests since loadConfig reads process.env
// and calls process.exit. We mock process.exit to prevent actual exits.

describe('loadConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let tmpDir: string;

  beforeEach(() => {
    // Save and clear relevant env vars
    originalEnv = { ...process.env };
    delete process.env['DISCORD_TOKEN'];
    delete process.env['VIDEO_FOLDER'];

    // Spy on process.exit and console.error
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit called with code ${_code}`);
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Create a real temp directory to use as a valid VIDEO_FOLDER
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    // Restore env and spies
    process.env = originalEnv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();

    // Clean up temp dir
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      // ignore cleanup errors
    }

    // Reset module registry so dotenv.config() re-runs on next require
    jest.resetModules();
  });

  function requireLoadConfig(): typeof import('../config').loadConfig {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../config').loadConfig;
  }

  it('returns AppConfig when both keys are set and VIDEO_FOLDER is a valid directory', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = tmpDir;

    const loadConfig = requireLoadConfig();
    const config = loadConfig();

    expect(config.token).toBe('test-token-abc');
    expect(config.videoFolder).toBe(path.resolve(tmpDir));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('resolves VIDEO_FOLDER to an absolute path', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    // Use a relative path that resolves to tmpDir
    const relative = path.relative(process.cwd(), tmpDir);
    process.env['VIDEO_FOLDER'] = relative;

    const loadConfig = requireLoadConfig();
    const config = loadConfig();

    expect(path.isAbsolute(config.videoFolder)).toBe(true);
    expect(config.videoFolder).toBe(path.resolve(relative));
  });

  it('logs an error naming DISCORD_TOKEN and exits when DISCORD_TOKEN is missing', () => {
    process.env['VIDEO_FOLDER'] = tmpDir;
    // DISCORD_TOKEN not set

    const loadConfig = requireLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called with code 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DISCORD_TOKEN'));
  });

  it('logs an error naming VIDEO_FOLDER and exits when VIDEO_FOLDER is missing', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    // VIDEO_FOLDER not set

    const loadConfig = requireLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called with code 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('VIDEO_FOLDER'));
  });

  it('logs an error with the path and exits when VIDEO_FOLDER does not exist', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    process.env['VIDEO_FOLDER'] = nonExistent;

    const loadConfig = requireLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called with code 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(path.resolve(nonExistent)));
  });

  it('logs an error with the path and exits when VIDEO_FOLDER is a file, not a directory', () => {
    // Create a file inside tmpDir
    const filePath = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'hello');

    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = filePath;

    const loadConfig = requireLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called with code 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(path.resolve(filePath)));

    fs.unlinkSync(filePath);
  });

  // --- Bot config tests ---

  it('returns botEnabled: true and botToken set when DISCORD_BOT_ENABLED=true and token is present', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = tmpDir;
    process.env['DISCORD_BOT_ENABLED'] = 'true';
    process.env['DISCORD_BOT_TOKEN'] = 'bot-token-xyz';

    const loadConfig = requireLoadConfig();
    const config = loadConfig();

    expect(config.botEnabled).toBe(true);
    expect(config.botToken).toBe('bot-token-xyz');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits with error when DISCORD_BOT_ENABLED=true but DISCORD_BOT_TOKEN is missing', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = tmpDir;
    process.env['DISCORD_BOT_ENABLED'] = 'true';
    delete process.env['DISCORD_BOT_TOKEN'];

    const loadConfig = requireLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called with code 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DISCORD_BOT_TOKEN'));
  });

  it('exits with error when DISCORD_BOT_ENABLED=true but DISCORD_BOT_TOKEN is empty string', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = tmpDir;
    process.env['DISCORD_BOT_ENABLED'] = 'true';
    process.env['DISCORD_BOT_TOKEN'] = '';

    const loadConfig = requireLoadConfig();
    expect(() => loadConfig()).toThrow('process.exit called with code 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DISCORD_BOT_TOKEN'));
  });

  it('returns botEnabled: false and botToken: null when DISCORD_BOT_ENABLED is absent', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = tmpDir;
    delete process.env['DISCORD_BOT_ENABLED'];
    delete process.env['DISCORD_BOT_TOKEN'];

    const loadConfig = requireLoadConfig();
    const config = loadConfig();

    expect(config.botEnabled).toBe(false);
    expect(config.botToken).toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns botEnabled: false and botToken: null when DISCORD_BOT_ENABLED=false', () => {
    process.env['DISCORD_TOKEN'] = 'test-token-abc';
    process.env['VIDEO_FOLDER'] = tmpDir;
    process.env['DISCORD_BOT_ENABLED'] = 'false';
    delete process.env['DISCORD_BOT_TOKEN'];

    const loadConfig = requireLoadConfig();
    const config = loadConfig();

    expect(config.botEnabled).toBe(false);
    expect(config.botToken).toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Feature: discord-bot-integration, Property 1: Config fields are correctly mapped from environment variables
  it('Property 1: for any non-empty bot token with DISCORD_BOT_ENABLED=true, config fields are correctly set', () => {
    // Validates: Requirements 1.1, 1.2, 8.1, 8.3
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (botToken) => {
          jest.resetModules();
          process.env['DISCORD_TOKEN'] = 'test-token-abc';
          process.env['VIDEO_FOLDER'] = tmpDir;
          process.env['DISCORD_BOT_ENABLED'] = 'true';
          process.env['DISCORD_BOT_TOKEN'] = botToken;

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadConfig } = require('../config');
          const config = loadConfig();

          expect(config.botEnabled).toBe(true);
          expect(config.botToken).toBe(botToken);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: discord-bot-integration, Property 2: botEnabled defaults to false for any non-"true" value
  it('Property 2: for any DISCORD_BOT_ENABLED value that is not exactly "true", botEnabled is false and no token validation occurs', () => {
    // Validates: Requirements 1.3, 8.4, 8.5
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(''),
          fc.constant('false'),
          fc.constant('1'),
          fc.constant('TRUE'),
          fc.constant('True'),
          fc.string().filter((s) => s !== 'true')
        ),
        (botEnabledValue) => {
          jest.resetModules();
          process.env['DISCORD_TOKEN'] = 'test-token-abc';
          process.env['VIDEO_FOLDER'] = tmpDir;
          if (botEnabledValue === undefined) {
            delete process.env['DISCORD_BOT_ENABLED'];
          } else {
            process.env['DISCORD_BOT_ENABLED'] = botEnabledValue;
          }
          // Intentionally omit DISCORD_BOT_TOKEN to confirm no validation occurs
          delete process.env['DISCORD_BOT_TOKEN'];

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { loadConfig } = require('../config');
          const config = loadConfig();

          expect(config.botEnabled).toBe(false);
          expect(config.botToken).toBeNull();
          // process.exit should not have been called
          expect(exitSpy).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});
