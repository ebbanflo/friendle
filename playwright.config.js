// E2E config. Tests run the real site over LocalTransport (?t=local) - no
// network, no Supabase. A plain static file server is all we need.
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Use the environment's pre-installed Chromium when the pinned revision is
// absent (e.g. the Claude Code cloud runner symlinks /opt/pw-browsers/chromium).
const fixedChromium = '/opt/pw-browsers/chromium';
const launchOptions = {
  // Many pages share one browser; background tabs must keep ticking (timers,
  // rAF, BroadcastChannel heartbeats) or multiplayer tests starve.
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
};
if (existsSync(fixedChromium)) {
  launchOptions.executablePath = fixedChromium;
}

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  fullyParallel: false, // BroadcastChannel rooms are cheap; keep runs deterministic
  workers: 2,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions,
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: true,
    timeout: 15000,
  },
});
