import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
});
