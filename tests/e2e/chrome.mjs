import { existsSync } from 'node:fs';

// Installed Chrome used by the E2E tests: CHROME_PATH wins, otherwise the usual location for the OS.
const candidates = {
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
};

export const chromePath = process.env.CHROME_PATH
  ?? (candidates[process.platform] ?? []).find((path) => existsSync(path))
  ?? candidates.win32[0];
