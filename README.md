# Discord Video Selfbot - Wsylq

A Discord selfbot that streams video directly into voice channels. Point it at a local folder or hand it a YouTube link — it handles the rest. Search YouTube, browse a channel's latest uploads, pick from results, pause, resume, loop, skip. All controlled through simple chat commands.

## TODO

- [x] Add youtube links player support
- [x] Add sound
- [x] Add pause and resume feature
- [ ] Add buffer for rewinding
- [x] Add Loop
- [x] Add Queue
   - [x] Persistent Queues - .db file
- [x] Add Now-playing and Duration
   - <s>[ ] Make it Sticky Message</s>
- [x] Add Search, with Pick arguments
   - [x] Add Channel Videos Search
      - [x] Make it via an Embed to Search (type) and Browse (buttons) videos there
- [x] Add Help Command -- Trying embed, if no perms then bot will send msg saying no perms.
- [x] Add Audio-Only-Mode to provide highest quality audio
   - [ ] Add Lyrics - Optional
   - [x] Add Loop
   - [x] Add Search
   - [x] Add Skip
   - [ ] Add Now-Playing command
- [ ] Add Dashboard - Optional
- [x] Search command Optimizations
- [x] Improve the Help Command Embed
- [x] Simplify Audio / Video Commands by Hiding them based on what Mode is Active
- <s>[x] Make the Bot Not Download the Queue Songs again and again.</s>
- [x] Make a Normal Discord Bot Control This, Keep it Optional
- [x] Add Role Support for Using Commands. (Only when Using Discord Actual Bot)
- [x] Clean and Optimize the Code
- [ ] Add Spotify and Youtube Playlist Support
- [ ] Fix First 30 seconds of Audio and Video being Skipped
- [x] Decrease Download Time.

## Setup

1. Clone and install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your details:

```bash
cp .env.example .env
```

3. Get your Discord token:
   - Open Discord in browser
   - Press `Ctrl+Shift+I` (DevTools)
   - Go to Console tab
   - Type `localStorage.token` and press Enter
   - Copy the token (without quotes)

4. Get channel IDs:
   - Enable Developer Mode in Discord settings
   - Right-click on server → Copy Server ID
   - Right-click on channels → Copy Channel ID

## Usage

Build and run:

```bash
npm run build
npm start
```

Or run directly:

```bash
npm run dev
```

### Commands

- `!search <query>` — Search YouTube and play the top result
- `!search -pick <query>` — Search and choose from top 5 results
  - `!pick <number>` — Pick a result
- `!search -channel <handle>` — Browse latest videos from a channel
  - `!pick <number>` — Pick a video to play
- `!play <youtube_url>` — Download and stream a YouTube video
- `!start` — Begin streaming videos from your folder
- `!pause` — Pause the current stream
- `!resume` — Resume from where you paused
- `!loop` — Toggle looping the current track
- `!loopqueue` — Toggle looping the entire queue
- `!skip` — Skip to next video
- `!stop` — Stop streaming and leave voice

## Config

All settings go in `.env`:

- `DISCORD_TOKEN` — Your user token
- `VIDEO_FOLDER` — Path to folder with videos
- `GUILD_ID` — Server ID
- `VOICE_CHANNEL_ID` — Voice channel to stream in
- `TEXT_CHANNEL_ID` — Text channel for commands
- `OWNER_ID` — Your user ID (only you can control the bot)

Supported formats: mp4, mkv, mov, avi, webm

## Note

This is a selfbot. Use at your own risk. Discord's ToS prohibits selfbots.
