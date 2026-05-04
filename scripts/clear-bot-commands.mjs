/**
 * One-off script to clear ALL slash commands for the bot:
 *   - Global application commands (visible in all servers)
 *   - Guild-scoped commands for the configured GUILD_ID
 *
 * Run this when you have duplicate or stale commands in Discord.
 *
 * Usage:
 *   node scripts/clear-bot-commands.mjs
 *
 * Requires DISCORD_BOT_TOKEN and GUILD_ID to be set in .env
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually
const envPath = resolve(__dirname, '../.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env not found — rely on environment variables already set
}

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.GUILD_ID;

if (!token || token === 'your_bot_token_here' || token === '') {
  console.error('❌ DISCORD_BOT_TOKEN is not set in .env');
  process.exit(1);
}
if (!guildId || guildId === 'your_guild_id_here' || guildId === '') {
  console.error('❌ GUILD_ID is not set in .env');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(token);

// Extract application ID from the token (first segment, base64-decoded)
const applicationId = Buffer.from(token.split('.')[0], 'base64').toString('utf8');

console.log(`Application ID : ${applicationId}`);
console.log(`Guild ID       : ${guildId}`);
console.log('');

// 1. Clear global commands
console.log('Clearing global application commands...');
try {
  await rest.put(Routes.applicationCommands(applicationId), { body: [] });
  console.log('✅ Global commands cleared.');
} catch (err) {
  console.error('❌ Failed to clear global commands:', err.message ?? err);
}

// 2. Clear guild-scoped commands
console.log(`Clearing guild commands for guild ${guildId}...`);
try {
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
  console.log('✅ Guild commands cleared.');
} catch (err) {
  console.error('❌ Failed to clear guild commands:', err.message ?? err);
}

console.log('');
console.log('Done. Restart the bot — it will re-register the correct 26 commands on startup.');
