import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  token: string;       // Discord user account token
  videoFolder: string; // Absolute path to video directory (resolved at startup)
}

export function loadConfig(): AppConfig {
  dotenv.config();

  const token = process.env['DISCORD_TOKEN'];
  if (!token) {
    console.error('Missing required configuration key: DISCORD_TOKEN');
    process.exit(1);
  }

  const rawVideoFolder = process.env['VIDEO_FOLDER'];
  if (!rawVideoFolder) {
    console.error('Missing required configuration key: VIDEO_FOLDER');
    process.exit(1);
  }

  const videoFolder = path.resolve(rawVideoFolder);

  try {
    const stat = fs.statSync(videoFolder);
    if (!stat.isDirectory()) {
      console.error(`VIDEO_FOLDER path exists but is not a directory: ${videoFolder}`);
      process.exit(1);
    }
  } catch {
    console.error(`VIDEO_FOLDER path does not exist or is not accessible: ${videoFolder}`);
    process.exit(1);
  }

  return { token, videoFolder };
}
