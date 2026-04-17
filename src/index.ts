#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { clearLine, cursorTo, moveCursor } from 'node:readline';
import { stdin as input, stdout as output, exit } from 'node:process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  formatDuration,
  isLikelyUrl,
  parseStartupValue,
  pickRandomEntry,
  pickWeightedRandom,
  RANDOM_POOL_SIZE,
  renderVisualizer,
  stripEmojis,
  type SearchEntry,
} from './lib.js';

interface HistoryItem {
  query: string;
  title: string;
  url: string;
  duration?: number;
  playedAt: string;
}

interface HistoryData {
  plays: HistoryItem[];
}

interface FavoriteItem {
  title: string;
  url: string;
  duration?: number;
  addedAt: string;
}

interface FavoritesData {
  items: FavoriteItem[];
}

interface ConfigData {
  cookiesFromBrowser?: string;
  cookiesBrowserProfile?: string;
  cookiesFile?: string;
  preferredVolume?: number;
}

interface DetectedBrowser {
  name: 'chrome' | 'edge' | 'firefox' | 'brave';
  profile?: string;
  details: string;
  status?: 'works' | 'failed' | 'untested';
}

interface PlaybackState {
  title: string;
  duration?: number;
  playbackTime: number;
  paused: boolean;
  stopped: boolean;
  loop: boolean;
  loading: boolean;
}

const APP_NAME = 'mux';
const MIN_DURATION_SECONDS = 20 * 60;
const MAX_RESULTS = 10;
const DEFAULT_VOLUME = 70;
const FADE_IN_MS = 5000;
const FADE_IN_STEPS = 20;
const FADE_OUT_MS = 1200;
const FADE_OUT_STEPS = 8;
const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);
const BOT_CHECK_PATTERN = /sign in to confirm you(?:'|’)re not a bot|use --cookies-from-browser or --cookies|youtube asked yt-dlp to sign in|the page needs to be reloaded/i;
const COOKIE_DB_COPY_PATTERN = /could not copy .*cookie database/i;
const DPAPI_PATTERN = /failed to decrypt with dpapi/i;
const HISTORY_DIR = path.join(os.homedir(), '.mux');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.json');
const FAVORITES_PATH = path.join(HISTORY_DIR, 'favorites.json');
const CONFIG_PATH = path.join(HISTORY_DIR, 'config.json');
let shownPlaybackHelp = false;
let playbackHeaderLines = 0;
const browserCloseRetries = new Set<string>();

function clearScreen(): void {
  if (output.isTTY) output.write('\x1Bc');
}

function shortenTerminalTitle(title: string, maxLength = 24): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const separators = [' ~ ', ' — ', ' – ', ' | ', ' · ', ': '];
  for (const separator of separators) {
    const index = normalized.indexOf(separator);
    if (index > 8 && index <= maxLength) return normalized.slice(0, index).trim();
  }

  const clipped = normalized.slice(0, maxLength + 1);
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace > 12) return clipped.slice(0, lastSpace).trim();

  return normalized.slice(0, maxLength).trim();
}

function setTerminalTitle(title: string): void {
  if (!output.isTTY) return;
  output.write(`\x1b]0;${shortenTerminalTitle(title)}\x07`);
}

function getAppVersion(): string {
  try {
    const raw = fsSync.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  console.log(`${APP_NAME} ${getAppVersion()}`);
  console.log('');
  console.log('Usage:');
  console.log(`  ${APP_NAME}                         Start interactive prompt`);
  console.log(`  ${APP_NAME} <query>                 Search YouTube and play`);
  console.log(`  ${APP_NAME} <youtube-url>           Play a specific YouTube URL`);
  console.log(`  ${APP_NAME} last                    Replay last item`);
  console.log(`  ${APP_NAME} recent                  Choose from recent searches`);
  console.log(`  ${APP_NAME} shuffle                 Pick from history`);
  console.log(`  ${APP_NAME} fav                     Choose from favorites`);
  console.log(`  ${APP_NAME} --help                  Show this help`);
  console.log(`  ${APP_NAME} --version               Show version`);
  console.log('');
  console.log('Interactive settings:');
  console.log('  settings                           Show mux settings');
  console.log('  cookies <browser> [profile]        Save browser cookies source');
  console.log('  cookies file <path>                Save cookies file path');
  console.log('  cookies off                        Clear saved cookies settings');
  console.log('');
  console.log('Environment:');
  console.log('  MUX_COOKIES_FROM_BROWSER=<browser>  Pass --cookies-from-browser to yt-dlp');
  console.log('  MUX_COOKIES=<file>                  Pass --cookies <file> to yt-dlp');
  console.log('');
  console.log('Playback keys:');
  console.log('  p pause/resume');
  console.log('  n next');
  console.log('  s stop and return to prompt');
  console.log('  f add favorite');
  console.log('  l toggle loop');
  console.log('  o open in browser');
  console.log('  q quit');
  console.log('  1-9 volume');
}

function dim(text: string): string {
  return output.isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}

function soft(text: string): string {
  return output.isTTY ? `\x1b[36m${text}\x1b[0m` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureHistory(): Promise<void> {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  if (!fsSync.existsSync(HISTORY_PATH)) {
    await fs.writeFile(HISTORY_PATH, JSON.stringify({ plays: [] }, null, 2), 'utf8');
  }
}

async function readConfig(): Promise<ConfigData> {
  await ensureHistory();
  try {
    if (!fsSync.existsSync(CONFIG_PATH)) return {};
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw) as Partial<ConfigData>;
    return {
      cookiesFromBrowser: typeof data.cookiesFromBrowser === 'string' ? data.cookiesFromBrowser : undefined,
      cookiesBrowserProfile: typeof data.cookiesBrowserProfile === 'string' ? data.cookiesBrowserProfile : undefined,
      cookiesFile: typeof data.cookiesFile === 'string' ? data.cookiesFile : undefined,
      preferredVolume: typeof data.preferredVolume === 'number' && data.preferredVolume >= 0 && data.preferredVolume <= 100
        ? Math.round(data.preferredVolume)
        : undefined,
    };
  } catch {
    return {};
  }
}

async function writeConfig(data: ConfigData): Promise<void> {
  await ensureHistory();
  const normalized: ConfigData = {};
  if (data.cookiesFromBrowser?.trim()) normalized.cookiesFromBrowser = data.cookiesFromBrowser.trim();
  if (data.cookiesBrowserProfile?.trim()) normalized.cookiesBrowserProfile = data.cookiesBrowserProfile.trim();
  if (data.cookiesFile?.trim()) normalized.cookiesFile = data.cookiesFile.trim();
  if (typeof data.preferredVolume === 'number' && data.preferredVolume >= 0 && data.preferredVolume <= 100) {
    normalized.preferredVolume = Math.round(data.preferredVolume);
  }
  await fs.writeFile(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

function detectBrowsers(): DetectedBrowser[] {
  const found: DetectedBrowser[] = [];
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');

  const detectChromiumProfiles = (name: DetectedBrowser['name'], userDataDir: string) => {
    if (!fsSync.existsSync(userDataDir)) return;
    try {
      const entries = fsSync.readdirSync(userDataDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== 'Default' && !/^Profile\s+\d+$/i.test(entry.name)) continue;
        const profileDir = path.join(userDataDir, entry.name);
        const cookiePath = [
          path.join(profileDir, 'Network', 'Cookies'),
          path.join(profileDir, 'Cookies'),
        ].find((candidate) => fsSync.existsSync(candidate));
        if (cookiePath) found.push({ name, profile: entry.name, details: cookiePath, status: 'untested' });
      }
    } catch {
      // ignore detection errors
    }
  };

  detectChromiumProfiles('chrome', path.join(localAppData, 'Google', 'Chrome', 'User Data'));
  detectChromiumProfiles('edge', path.join(localAppData, 'Microsoft', 'Edge', 'User Data'));
  detectChromiumProfiles('brave', path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'));

  const firefoxProfiles = path.join(appData, 'Mozilla', 'Firefox', 'Profiles');
  if (fsSync.existsSync(firefoxProfiles)) {
    try {
      const profiles = fsSync.readdirSync(firefoxProfiles, { withFileTypes: true });
      for (const profile of profiles) {
        if (!profile.isDirectory()) continue;
        const cookiePath = path.join(firefoxProfiles, profile.name, 'cookies.sqlite');
        if (fsSync.existsSync(cookiePath)) {
          found.push({ name: 'firefox', profile: profile.name, details: cookiePath, status: 'untested' });
        }
      }
    } catch {
      // ignore detection errors
    }
  }

  const order: Record<DetectedBrowser['name'], number> = { edge: 0, chrome: 1, brave: 2, firefox: 3 };
  return found.sort((a, b) => {
    const nameOrder = order[a.name] - order[b.name];
    if (nameOrder !== 0) return nameOrder;
    if ((a.profile ?? '') === 'Default') return -1;
    if ((b.profile ?? '') === 'Default') return 1;
    return (a.profile ?? '').localeCompare(b.profile ?? '');
  });
}

function formatSelectedBrowser(config: ConfigData): string {
  return config.cookiesFromBrowser
    ? `${config.cookiesFromBrowser}${config.cookiesBrowserProfile ? ` / ${config.cookiesBrowserProfile}` : ''}`
    : 'none';
}

function formatBrowserLabel(browser: DetectedBrowser, config: ConfigData): string {
  const tags: string[] = [];
  if (config.cookiesFromBrowser === browser.name && (config.cookiesBrowserProfile ?? '') === (browser.profile ?? '')) tags.push('saved');
  if (browser.status && browser.status !== 'untested') tags.push(browser.status);
  const label = browser.profile ? `${browser.profile}` : browser.name;
  return tags.length > 0 ? `${label} [${tags.join(', ')}]` : label;
}

async function printSettings(options?: { reason?: string; browsers?: DetectedBrowser[]; compactEnvHint?: boolean }): Promise<void> {
  const config = await readConfig();
  const envBrowser = process.env.MUX_COOKIES_FROM_BROWSER?.trim();
  const envCookies = process.env.MUX_COOKIES?.trim();
  const browsers = options?.browsers ?? detectBrowsers();

  if (options?.reason) console.log(options.reason);

  console.log('Settings');
  console.log(`Saved browser: ${formatSelectedBrowser(config)}`);
  console.log(`Saved file: ${config.cookiesFile ?? 'none'}`);
  console.log(`Preferred volume: ${config.preferredVolume ?? DEFAULT_VOLUME}%`);

  console.log('');
  console.log('Detected browser profiles');
  if (browsers.length > 0) {
    let currentName: DetectedBrowser['name'] | null = null;
    browsers.forEach((browser, index) => {
      if (browser.name !== currentName) {
        currentName = browser.name;
        console.log(`  ${browser.name}`);
      }
      console.log(`    ${index + 1}. ${formatBrowserLabel(browser, config)}`);
    });
  } else {
    console.log('  none');
  }

  if (envBrowser || envCookies) {
    console.log('');
    console.log('Env override');
    if (envBrowser) console.log(`  MUX_COOKIES_FROM_BROWSER=${envBrowser}`);
    if (envCookies) console.log(`  MUX_COOKIES=${envCookies}`);
  }

  console.log('');
  console.log('Commands');
  if (browsers.length > 0) console.log('  <number>                 Use detected profile');
  console.log('  cookies <browser> [profile]');
  console.log('  cookies file <path>');
  console.log('  cookies off');

  if (!options?.compactEnvHint) {
    console.log('');
    console.log('Env vars');
    console.log('  MUX_COOKIES_FROM_BROWSER=<browser>');
    console.log('  MUX_COOKIES=<file>');
  }

  console.log('');
  console.log('Enter to go back');
}

function isBotCheckError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return BOT_CHECK_PATTERN.test(message);
}

function isCookieDbCopyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return COOKIE_DB_COPY_PATTERN.test(message);
}

function isDpapiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return DPAPI_PATTERN.test(message);
}

function isChromiumBrowser(name?: string): boolean {
  return Boolean(name && ['chrome', 'edge', 'brave'].includes(name));
}

async function promptYesNo(question: string, defaultNo = true): Promise<boolean> {
  const suffix = defaultNo ? ' [y/N] ' : ' [Y/n] ';
  const answer = (await prompt(question + suffix)).trim().toLowerCase();
  if (!answer) return !defaultNo;
  return answer === 'y' || answer === 'yes';
}

async function closeBrowserProcesses(browserName: DetectedBrowser['name']): Promise<void> {
  const processNames: Record<DetectedBrowser['name'], string[]> = {
    chrome: ['chrome.exe'],
    edge: ['msedge.exe'],
    brave: ['brave.exe'],
    firefox: ['firefox.exe'],
  };
  const names = processNames[browserName] ?? [];
  for (const name of names) {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/IM', name, '/F'], { stdio: 'ignore' });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
      });
    } else {
      await new Promise<void>((resolve) => {
        const killer = spawn('pkill', ['-f', name.replace('.exe', '')], { stdio: 'ignore' });
        killer.on('exit', () => resolve());
        killer.on('error', () => resolve());
      });
    }
  }
}

async function maybeCloseBrowserForCookies(error: unknown): Promise<boolean> {
  const config = await readConfig();
  if (!isChromiumBrowser(config.cookiesFromBrowser)) return false;
  if (!isCookieDbCopyError(error) && !isDpapiError(error)) return false;

  const selected = formatSelectedBrowser(config);
  const retryKey = `${config.cookiesFromBrowser}:${config.cookiesBrowserProfile ?? ''}`;
  if (browserCloseRetries.has(retryKey)) {
    console.log(isDpapiError(error)
      ? `${selected} still could not be decrypted after closing the browser. Try another profile/browser or use \`cookies file <path>\`.`
      : `${selected} is still unavailable after closing the browser. Try another profile/browser or use \`cookies file <path>\`.`);
    return false;
  }

  const explanation = isCookieDbCopyError(error)
    ? `${selected} may still be running and locking its cookie database.`
    : `${selected} cookies could not be decrypted right now.`;
  console.log(explanation);
  const shouldClose = await promptYesNo(`Close ${config.cookiesFromBrowser} for you and retry?`);
  if (!shouldClose) return false;
  browserCloseRetries.add(retryKey);
  await closeBrowserProcesses(config.cookiesFromBrowser as DetectedBrowser['name']);
  await sleep(1200);
  return true;
}

async function openSettingsPrompt(reason?: string, browsers = detectBrowsers()): Promise<boolean> {
  while (true) {
    await printSettings({ reason, browsers, compactEnvHint: true });
    reason = undefined;
    const answer = await prompt('settings> ');
    const trimmed = answer.trim();
    if (!trimmed) return false;
    const picked = Number(trimmed);
    if (Number.isInteger(picked) && picked >= 1 && picked <= browsers.length) {
      const browser = browsers[picked - 1]!;
      await writeConfig({ cookiesFromBrowser: browser.name, cookiesBrowserProfile: browser.profile, cookiesFile: undefined });
      console.log(`Saved cookies browser: ${browser.name}${browser.profile ? ` / ${browser.profile}` : ''}`);
      return true;
    }
    const before = JSON.stringify(await readConfig());
    await handleSettingsCommand(trimmed);
    const after = JSON.stringify(await readConfig());
    if (before !== after) return true;
  }
}

async function handleSettingsCommand(inputValue: string): Promise<boolean> {
  const trimmed = inputValue.trim();
  if (!trimmed) return false;
  if (trimmed === 'settings') {
    await printSettings();
    return true;
  }
  if (!trimmed.startsWith('cookies')) return false;

  const [, subcommand, ...rest] = trimmed.split(/\s+/);
  const config = await readConfig();

  if (subcommand === 'off') {
    await writeConfig({ ...config, cookiesFromBrowser: undefined, cookiesBrowserProfile: undefined, cookiesFile: undefined });
    console.log('Cleared saved cookies settings.');
    return true;
  }

  if (subcommand === 'file') {
    const filePath = rest.join(' ').trim();
    if (!filePath) {
      console.log('Usage: cookies file <path>');
      return true;
    }
    await writeConfig({ ...config, cookiesFromBrowser: undefined, cookiesBrowserProfile: undefined, cookiesFile: filePath });
    console.log(`Saved cookies file: ${filePath}`);
    return true;
  }

  if (subcommand && ['chrome', 'edge', 'firefox', 'brave'].includes(subcommand)) {
    const profile = rest.join(' ').trim() || undefined;
    await writeConfig({ ...config, cookiesFromBrowser: subcommand, cookiesBrowserProfile: profile, cookiesFile: undefined });
    console.log(`Saved cookies browser: ${subcommand}${profile ? ` / ${profile}` : ''}`);
    return true;
  }

  console.log('Usage: cookies <browser> [profile] | cookies file <path> | cookies off');
  return true;
}

async function readFavorites(): Promise<FavoritesData> {
  await ensureHistory();
  try {
    if (!fsSync.existsSync(FAVORITES_PATH)) return { items: [] };
    const raw = await fs.readFile(FAVORITES_PATH, 'utf8');
    const data = JSON.parse(raw) as Partial<FavoritesData>;
    return { items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { items: [] };
  }
}

async function writeFavorites(data: FavoritesData): Promise<void> {
  await ensureHistory();
  await fs.writeFile(FAVORITES_PATH, JSON.stringify({ items: data.items.slice(-200) }, null, 2), 'utf8');
}

async function addFavorite(entry: SearchEntry): Promise<boolean> {
  const favorites = await readFavorites();
  if (favorites.items.some((item) => item.url === entry.url)) return false;
  favorites.items.push({
    title: entry.title,
    url: entry.url,
    duration: entry.duration,
    addedAt: new Date().toISOString(),
  });
  await writeFavorites(favorites);
  return true;
}

async function chooseFavorite(): Promise<SearchEntry | null> {
  const favorites = await readFavorites();
  if (favorites.items.length === 0) {
    console.log('No favorites yet.');
    return null;
  }
  favorites.items.forEach((item, index) => {
    console.log(`${index + 1}. ${item.title} [${formatDuration(item.duration)}]`);
  });
  const answer = await prompt('fav> ');
  const pick = Number(answer || '1');
  if (!Number.isInteger(pick) || pick < 1 || pick > favorites.items.length) return null;
  const item = favorites.items[pick - 1]!;
  return {
    id: item.url,
    title: item.title,
    duration: item.duration,
    url: item.url,
  };
}

async function readHistory(): Promise<HistoryData> {
  await ensureHistory();
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8');
    const data = JSON.parse(raw) as Partial<HistoryData>;
    return { plays: Array.isArray(data.plays) ? data.plays : [] };
  } catch {
    return { plays: [] };
  }
}

async function writeHistory(data: HistoryData): Promise<void> {
  await ensureHistory();
  const trimmed = { plays: data.plays.slice(-200) };
  await fs.writeFile(HISTORY_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
}

async function appendHistory(item: HistoryItem): Promise<void> {
  const history = await readHistory();
  history.plays.push(item);
  await writeHistory(history);
}

async function requireCommand(command: string): Promise<void> {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(checker, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Missing required command: ${command}`)));
    child.on('error', () => reject(new Error(`Missing required command: ${command}`)));
  });
}

function normalizeEntry(entry: any): SearchEntry | null {
  const id = entry.id ?? entry.url;
  const title = entry.title;
  const duration = typeof entry.duration === 'number' ? entry.duration : undefined;
  const webpageUrl = entry.webpage_url ?? (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : undefined);
  const url = webpageUrl ?? entry.url;
  if (!id || !title || !url) return null;
  const cleanTitle = stripEmojis(String(title)) || String(title);
  return {
    id: String(id),
    title: cleanTitle,
    duration,
    channel: entry.channel ?? entry.uploader,
    webpage_url: webpageUrl,
    url: String(url),
  };
}

function getBrowserSpec(browser: { name?: string; profile?: string; cookiesFromBrowser?: string; cookiesBrowserProfile?: string }): string {
  const name = browser.name ?? browser.cookiesFromBrowser;
  const profile = browser.profile ?? browser.cookiesBrowserProfile;
  return profile ? `${name}:${profile}` : String(name);
}

async function getYtDlpAuthArgs(): Promise<string[]> {
  const cookiesFromBrowser = process.env.MUX_COOKIES_FROM_BROWSER?.trim();
  const cookies = process.env.MUX_COOKIES?.trim();
  if (cookiesFromBrowser) return ['--cookies-from-browser', cookiesFromBrowser];
  if (cookies) return ['--cookies', cookies];

  const config = await readConfig();
  if (config.cookiesFromBrowser) return ['--cookies-from-browser', getBrowserSpec(config)];
  if (config.cookiesFile) return ['--cookies', config.cookiesFile];
  return [];
}

async function runYtDlpWithAuth(authArgs: string[], args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('yt-dlp', ['--extractor-retries', '3', ...authArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(formatYtDlpError(stderr, code));
    });
  });
}

function formatYtDlpError(stderr: string, exitCode: number | null): Error {
  const trimmed = stderr.trim();
  if (BOT_CHECK_PATTERN.test(trimmed)) {
    return new Error(
      [
        'YouTube asked yt-dlp to sign in and confirm you are not a bot.',
        'Open mux settings and configure one of these:',
        '  cookies chrome',
        '  cookies edge',
        '  cookies firefox',
        '  cookies brave',
        '  cookies file /path/to/cookies.txt',
        'Or use env vars:',
        '  MUX_COOKIES_FROM_BROWSER=chrome',
        '  MUX_COOKIES_FROM_BROWSER=edge',
        '  MUX_COOKIES=/path/to/cookies.txt',
        'Example:',
        process.platform === 'win32'
          ? '  PowerShell: $env:MUX_COOKIES_FROM_BROWSER="edge"; mux'
          : '  MUX_COOKIES_FROM_BROWSER=firefox mux',
      ].join('\n'),
    );
  }
  return new Error(trimmed || `yt-dlp failed with code ${exitCode}`);
}

async function runYtDlp(args: string[]): Promise<string> {
  const authArgs = await getYtDlpAuthArgs();
  return await runYtDlpWithAuth(authArgs, args);
}

async function probeBrowserCookies(browser: DetectedBrowser): Promise<boolean> {
  try {
    await runYtDlpWithAuth(['--cookies-from-browser', getBrowserSpec(browser)], [
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      'ytsearch1:ambient music',
    ]);
    return true;
  } catch {
    return false;
  }
}

async function autoConfigureBrowserCookies(): Promise<DetectedBrowser | null> {
  if (process.env.MUX_COOKIES_FROM_BROWSER?.trim() || process.env.MUX_COOKIES?.trim()) return null;
  const browsers = detectBrowsers();
  if (browsers.length === 0) return null;

  console.log(dim('Trying detected browser cookies...'));
  for (const browser of browsers) {
    output.write(`${dim(`- testing ${formatBrowserLabel(browser, await readConfig())}...`)}` + '\n');
    const works = await probeBrowserCookies(browser);
    browser.status = works ? 'works' : 'failed';
    if (works) {
      await writeConfig({ cookiesFromBrowser: browser.name, cookiesBrowserProfile: browser.profile, cookiesFile: undefined });
      console.log(`Using ${browser.name}${browser.profile ? ` / ${browser.profile}` : ''} cookies.`);
      return browser;
    }
  }
  return null;
}

async function searchYoutube(query: string): Promise<SearchEntry[]> {
  const raw = await runYtDlp([
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
    `ytsearch${MAX_RESULTS}:${query}`,
  ]);
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry).filter(Boolean) as SearchEntry[] : [];
  const longFirst = entries
    .filter((entry) => !entry.duration || entry.duration >= MIN_DURATION_SECONDS)
    .concat(entries.filter((entry) => entry.duration && entry.duration < MIN_DURATION_SECONDS));
  return longFirst;
}

async function inspectUrl(url: string): Promise<SearchEntry> {
  const raw = await runYtDlp([
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
    url,
  ]);
  const parsed = JSON.parse(raw);
  const normalized = normalizeEntry(parsed);
  if (!normalized) throw new Error('Could not read video metadata.');
  return normalized;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function printSearchResults(entries: SearchEntry[], selected: SearchEntry): void {
  void entries;
  void selected;
}

function startSpinner(label = 'searching'): () => void {
  const frames = ['.', '..', '...'];
  let index = 0;
  let lastWidth = 0;

  hideCursor();

  const render = () => {
    const text = `mux> ${dim(`${label}${frames[index % frames.length]}`)}`;
    const plain = `mux> ${label}${frames[index % frames.length]}`;
    lastWidth = Math.max(lastWidth, plain.length);
    output.write(`\r${text}${' '.repeat(Math.max(0, lastWidth - plain.length))}`);
    index += 1;
  };

  render();
  const timer = setInterval(render, 280);

  return () => {
    clearInterval(timer);
    output.write(`\r${' '.repeat(lastWidth)}\r`);
    showCursor();
  };
}

function clearCurrentLine(): void {
  clearLine(output, 0);
  cursorTo(output, 0);
}

function clearCurrentScreenLine(): void {
  clearCurrentLine();
  output.write('\r');
}

function hideCursor(): void {
  if (output.isTTY) output.write('\x1b[?25l');
}

function showCursor(): void {
  if (output.isTTY) output.write('\x1b[?25h');
}

function clearPlaybackHeader(): void {
  if (playbackHeaderLines <= 0) return;
  for (let i = 0; i < playbackHeaderLines; i += 1) {
    moveCursor(output, 0, -1);
    clearCurrentLine();
  }
  playbackHeaderLines = 0;
}

function getIpcPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\mux-${process.pid}-${Date.now()}`;
  return path.join(os.tmpdir(), `mux-${process.pid}-${Date.now()}.sock`);
}

function sendMpvCommand(ipcPath: string, command: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(ipcPath, () => {
      client.write(JSON.stringify({ command }) + '\n');
      client.end();
      resolve();
    });
    client.on('error', reject);
  });
}

async function waitForSocket(ipcPath: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (process.platform === 'win32') {
      try {
        await new Promise<void>((resolve, reject) => {
          const client = net.createConnection(ipcPath, () => { client.destroy(); resolve(); });
          client.on('error', reject);
        });
        return;
      } catch {
        // retry
      }
    } else if (fsSync.existsSync(ipcPath)) {
      return;
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for mpv IPC.');
}

async function terminateProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.killed) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  child.kill('SIGTERM');
  await sleep(250);
  if (!child.killed) child.kill('SIGKILL');
}

async function openExternalUrl(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? spawn('open', [url], { stdio: 'ignore' })
        : spawn('xdg-open', [url], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function getPreferredVolume(): Promise<number> {
  const config = await readConfig();
  return config.preferredVolume ?? DEFAULT_VOLUME;
}

async function setPreferredVolume(volume: number): Promise<void> {
  const config = await readConfig();
  await writeConfig({ ...config, preferredVolume: Math.max(0, Math.min(100, Math.round(volume))) });
}

async function fadeVolume(ipcPath: string, from: number, to: number, durationMs: number, steps: number, isCancelled: () => boolean): Promise<void> {
  const stepDelay = Math.max(1, Math.floor(durationMs / steps));
  for (let step = 1; step <= steps; step += 1) {
    if (isCancelled()) return;
    const volume = Math.round(from + ((to - from) * step) / steps);
    try {
      await sendMpvCommand(ipcPath, ['set_property', 'volume', volume]);
    } catch {
      return;
    }
    await sleep(stepDelay);
  }
}

async function fadeInVolume(ipcPath: string, targetVolume: number, state: PlaybackState, isCancelled: () => boolean): Promise<void> {
  const waitUntil = Date.now() + 4000;
  while (Date.now() < waitUntil) {
    if (isCancelled()) return;
    if (state.playbackTime > 0 || state.duration) break;
    await sleep(120);
  }
  await fadeVolume(ipcPath, 0, targetVolume, FADE_IN_MS, FADE_IN_STEPS, isCancelled);
}

async function fadeOutAndQuit(ipcPath: string, child: ReturnType<typeof spawn>, fromVolume: number): Promise<void> {
  try {
    await fadeVolume(ipcPath, fromVolume, 0, FADE_OUT_MS, FADE_OUT_STEPS, () => false);
  } catch {
    // ignore fade issues, still quit below
  }
  try { await sendMpvCommand(ipcPath, ['quit']); } catch {}
  await terminateProcess(child);
}

async function playEntry(entry: SearchEntry, queue: SearchEntry[] = []): Promise<'stopped' | 'next' | 'quit' | 'loop'> {
  const ipcPath = getIpcPath();
  const mpvArgs = [
    '--no-video',
    '--quiet',
    '--input-terminal=no',
    '--volume=0',
    `--input-ipc-server=${ipcPath}`,
    entry.url,
  ];

  const child = spawn('mpv', mpvArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdout.resume();
  const preferredVolume = await getPreferredVolume();

  const state: PlaybackState = {
    title: entry.title,
    duration: entry.duration,
    playbackTime: 0,
    paused: false,
    stopped: false,
    loop: false,
    loading: true,
  };

  let socket: net.Socket | null = null;
  let buffer = '';
  let tick = 0;
  let currentVolume = 0;
  let cancelFadeIn = false;

  try {
    await waitForSocket(ipcPath);
    socket = net.createConnection(ipcPath);
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.event === 'property-change') {
            if (msg.name === 'playback-time' && typeof msg.data === 'number') {
              state.playbackTime = msg.data;
              if (msg.data > 0) state.loading = false;
            }
            if (msg.name === 'duration' && typeof msg.data === 'number') state.duration = msg.data;
            if (msg.name === 'pause' && typeof msg.data === 'boolean') state.paused = msg.data;
            if (msg.name === 'volume' && typeof msg.data === 'number') currentVolume = msg.data;
            if (msg.name === 'media-title' && typeof msg.data === 'string') state.title = stripEmojis(msg.data) || msg.data;
          }
        } catch {
          // ignore
        }
      }
    });
    socket.on('connect', () => {
      const observe = (name: string, id: number) => socket?.write(JSON.stringify({ command: ['observe_property', id, name] }) + '\n');
      observe('playback-time', 1);
      observe('duration', 2);
      observe('pause', 3);
      observe('media-title', 4);
      observe('volume', 5);
    });
  } catch {
    // status will still work without IPC updates
  }

  clearScreen();
  setTerminalTitle(`♫ ${entry.title}`);
  const controlsForState = () => state.paused
    ? '[p]lay  [n]ext  [s]top  [f]av  [l]oop  [o]pen  [q]uit  [1-9] vol'
    : '[p]ause  [n]ext  [s]top  [f]av  [l]oop  [o]pen  [q]uit  [1-9] vol';
  playbackHeaderLines = 2;
  console.log(soft(entry.title));
  console.log(dim(controlsForState()));
  shownPlaybackHelp = true;

  const oldRaw = input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  hideCursor();
  input.resume();
  input.setEncoding('utf8');

  let result: 'stopped' | 'next' | 'quit' | 'loop' = 'stopped';
  let commandBuffer = '';

  let lastLineWidth = 0;
  let lastControls = controlsForState();
  const render = () => {
    const controls = controlsForState();
    if (controls !== lastControls) {
      moveCursor(output, 0, -1);
      clearCurrentLine();
      output.write(dim(controls));
      output.write('\n');
      lastControls = controls;
    }
    const baseStatus = state.loading ? 'loading' : state.paused ? 'paused' : 'play';
    const status = `${baseStatus}${state.loop ? ' ↻' : ''}`;
    const viz = state.paused || state.stopped || state.loading ? ' ' : renderVisualizer(tick);
    if (!state.paused && !state.stopped && !state.loading) tick += 0.35;
    const visibleLine = `[${formatDuration(state.playbackTime)} / ${formatDuration(state.duration)}] ${status} ${viz}`
      .slice(0, Math.max(20, (output.columns ?? 80) - 1));
    const paddedVisible = visibleLine.padEnd(lastLineWidth);
    lastLineWidth = Math.max(lastLineWidth, visibleLine.length);
    const renderedLine = `${dim(`[${formatDuration(state.playbackTime)} / ${formatDuration(state.duration)}]`)} ${status} ${dim(viz)}`;
    output.write(`\r${renderedLine}${' '.repeat(Math.max(0, paddedVisible.length - visibleLine.length))}`);
  };

  const interval = setInterval(render, 150);
  render();
  void fadeInVolume(ipcPath, preferredVolume, state, () => cancelFadeIn || state.stopped).then(() => {
    if (!cancelFadeIn && !state.stopped) {
      currentVolume = preferredVolume;
      state.loading = false;
    }
  });

  const onKey = async (key: string) => {
    const char = key.toLowerCase();
    if (key === '\u0003') {
      cancelFadeIn = true;
      state.stopped = true;
      result = 'quit';
      try { await sendMpvCommand(ipcPath, ['quit']); } catch {}
      await terminateProcess(child);
      return;
    }

    if (/^[a-z]$/i.test(char)) {
      commandBuffer = (commandBuffer + char).slice(-8);
    } else {
      commandBuffer = '';
    }

    try {
      if (/^[1-9]$/.test(char)) {
        commandBuffer = '';
        cancelFadeIn = true;
        const volume = Number(char) * 10;
        currentVolume = volume;
        await sendMpvCommand(ipcPath, ['set_property', 'volume', volume]);
        await setPreferredVolume(volume);
      }
      if (char === 'p' || commandBuffer.endsWith('pause')) {
        commandBuffer = '';
        await sendMpvCommand(ipcPath, ['cycle', 'pause']);
      }
      if (char === 's' || commandBuffer.endsWith('stop')) {
        commandBuffer = '';
        cancelFadeIn = true;
        state.stopped = true;
        result = 'stopped';
        await fadeOutAndQuit(ipcPath, child, currentVolume || preferredVolume);
      }
      if (char === 'n' || commandBuffer.endsWith('skip')) {
        commandBuffer = '';
        cancelFadeIn = true;
        state.stopped = true;
        result = 'next';
        await fadeOutAndQuit(ipcPath, child, currentVolume || preferredVolume);
      }
      if (char === 'f' || commandBuffer.endsWith('fav')) {
        commandBuffer = '';
        const added = await addFavorite(entry);
        output.write(`\r${dim(added ? 'saved to favorites' : 'already in favorites')}`);
        await sleep(700);
      }
      if (char === 'l' || commandBuffer.endsWith('loop')) {
        commandBuffer = '';
        state.loop = !state.loop;
      }
      if (char === 'o' || commandBuffer.endsWith('open')) {
        commandBuffer = '';
        await openExternalUrl(entry.url);
        output.write(`\r${dim('opened in browser')}`);
        await sleep(700);
      }
      if (char === 'q' || commandBuffer.endsWith('quit')) {
        commandBuffer = '';
        cancelFadeIn = true;
        state.stopped = true;
        result = 'quit';
        await fadeOutAndQuit(ipcPath, child, currentVolume || preferredVolume);
      }
    } catch {
      if (char === 'q' || commandBuffer.endsWith('quit')) {
        state.stopped = true;
        result = 'quit';
        await terminateProcess(child);
      }
    }
  };

  input.on('data', onKey);

  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });

  cancelFadeIn = true;
  clearInterval(interval);
  output.write(`\r${' '.repeat(lastLineWidth)}\r`);
  showCursor();
  if (!state.stopped) {
    console.log(dim(`done ${state.title}`));
  }

  input.off('data', onKey);
  if (input.isTTY) input.setRawMode(Boolean(oldRaw));
  input.pause();
  socket?.destroy();
  if (process.platform !== 'win32' && fsSync.existsSync(ipcPath)) {
    try { await fs.unlink(ipcPath); } catch {}
  }

  if (!state.stopped && state.loop) return 'loop';
  if (result === 'stopped' && queue.length > 0 && !state.stopped) return 'next';
  return result;
}

async function chooseFromRecent(): Promise<string | null> {
  const history = await readHistory();
  const queries = Array.from(new Set(history.plays.map((p) => p.query).filter(Boolean).reverse())).slice(0, 10);
  if (queries.length === 0) {
    console.log('No recent searches yet.');
    return null;
  }
  queries.forEach((query, index) => console.log(`${index + 1}. ${query}`));
  const answer = await prompt('Choose recent search [1]: ');
  if (!answer) return queries[0] ?? null;
  const selected = Number(answer);
  if (Number.isInteger(selected) && selected >= 1 && selected <= queries.length) return queries[selected - 1] ?? null;
  return null;
}

async function resolveStartupInput(initialArgs: string[]): Promise<{ mode: 'quit' | 'search' | 'url' | 'last' | 'shuffle' | 'recent' | 'favorites'; value?: string }> {
  if (initialArgs.length > 0) {
    const joined = initialArgs.join(' ').trim();
    const parsed = parseStartupValue(joined);
    if (parsed.mode === 'recent') {
      const recent = await chooseFromRecent();
      if (!recent) return { mode: 'quit' };
      return { mode: 'search', value: recent };
    }
    if (parsed.mode === 'favorites') return { mode: 'favorites' };
    return parsed;
  }

  while (true) {
    const answer = await prompt('mux> ');
    if (await handleSettingsCommand(answer)) continue;
    const parsed = parseStartupValue(answer);
    if (parsed.mode === 'recent') {
      const recent = await chooseFromRecent();
      if (!recent) return { mode: 'quit' };
      return { mode: 'search', value: recent };
    }
    if (parsed.mode === 'favorites') return { mode: 'favorites' };
    return parsed;
  }
}

async function main(): Promise<void> {
  let initialArgs = process.argv.slice(2);
  if (initialArgs.some((arg) => HELP_FLAGS.has(arg))) {
    printHelp();
    return;
  }
  if (initialArgs.some((arg) => VERSION_FLAGS.has(arg))) {
    console.log(getAppVersion());
    return;
  }

  clearScreen();
  setTerminalTitle('♫ mux');
  await requireCommand('yt-dlp');
  await requireCommand('mpv');

  while (true) {
    const startup = await resolveStartupInput(initialArgs);
    initialArgs = [];
    if (startup.mode === 'quit') return;

    let query = startup.value ?? '';
    let selected: SearchEntry | null = null;

    if (startup.mode === 'last') {
      const history = await readHistory();
      const last = history.plays.at(-1);
      if (!last) {
        console.log('No last item yet.');
        continue;
      }
      query = last.query;
      selected = {
        id: last.url,
        title: last.title,
        duration: last.duration,
        url: last.url,
      };
    } else if (startup.mode === 'shuffle') {
      const history = await readHistory();
      const picked = pickWeightedRandom(history.plays.map((p) => p.query).filter(Boolean));
      if (!picked) {
        console.log('No history to shuffle yet.');
        continue;
      }
      query = picked;
    }

    if (!selected && startup.mode === 'favorites') {
      selected = await chooseFavorite();
      query = selected?.title ?? '';
    }

    if (!selected && startup.mode === 'url') {
      while (!selected) {
        const stopSpinner = startSpinner('loading');
        let spinnerStopped = false;
        const stopSpinnerOnce = () => {
          if (spinnerStopped) return;
          spinnerStopped = true;
          stopSpinner();
        };
        try {
          selected = await inspectUrl(query);
        } catch (error) {
          stopSpinnerOnce();
          if (isBotCheckError(error)) {
            const detected = await autoConfigureBrowserCookies();
            if (detected) continue;
            const updated = await openSettingsPrompt('YouTube bot-check detected. I could not automatically verify your local browser cookies. Pick one below and mux will save it.');
            if (updated) continue;
          } else if (isCookieDbCopyError(error) || isDpapiError(error)) {
            const closed = await maybeCloseBrowserForCookies(error);
            if (closed) continue;
            const updated = await openSettingsPrompt('mux could not use the selected browser cookies. Try another profile, let mux close the browser, or use `cookies file <path>`.');
            if (updated) continue;
          } else {
            console.log(error instanceof Error ? error.message : String(error));
          }
          break;
        } finally {
          stopSpinnerOnce();
        }
      }
      if (!selected) continue;
    }

    let queue: SearchEntry[] = [];
    if (!selected && query) {
      let results: SearchEntry[] = [];
      let searchFailed = false;
      while (results.length === 0) {
        const stopSpinner = startSpinner();
        let spinnerStopped = false;
        const stopSpinnerOnce = () => {
          if (spinnerStopped) return;
          spinnerStopped = true;
          stopSpinner();
        };
        try {
          results = await searchYoutube(query);
        } catch (error) {
          stopSpinnerOnce();
          searchFailed = true;
          if (isBotCheckError(error)) {
            const detected = await autoConfigureBrowserCookies();
            if (detected) {
              searchFailed = false;
              continue;
            }
            const updated = await openSettingsPrompt('YouTube bot-check detected. I could not automatically verify your local browser cookies. Pick one below and mux will save it.');
            if (updated) {
              searchFailed = false;
              continue;
            }
          } else if (isCookieDbCopyError(error) || isDpapiError(error)) {
            const closed = await maybeCloseBrowserForCookies(error);
            if (closed) {
              searchFailed = false;
              continue;
            }
            const updated = await openSettingsPrompt('mux could not use the selected browser cookies. Try another profile, let mux close the browser, or use `cookies file <path>`.');
            if (updated) {
              searchFailed = false;
              continue;
            }
          } else {
            console.log(error instanceof Error ? error.message : String(error));
          }
          break;
        } finally {
          stopSpinnerOnce();
        }
      }
      if (searchFailed) continue;
      if (results.length === 0) {
        console.log('No results found.');
        continue;
      }
      selected = pickRandomEntry(results);
      if (!selected) continue;
      printSearchResults(results, selected);
      queue = results.filter((entry) => entry.url !== selected?.url);
    }

    if (!selected) continue;

    await appendHistory({
      query: query || selected.title,
      title: selected.title,
      url: selected.url,
      duration: selected.duration,
      playedAt: new Date().toISOString(),
    });

    let current: SearchEntry | null = selected;
    let shouldQuit = false;
    while (current) {
      const result = await playEntry(current, queue);
      if (result === 'quit') {
        shouldQuit = true;
        break;
      }
      if (result === 'stopped') break;
      if (result === 'loop') continue;
      current = queue.shift() ?? null;
      if (current) {
        await appendHistory({
          query: query || current.title,
          title: current.title,
          url: current.url,
          duration: current.duration,
          playedAt: new Date().toISOString(),
        });
      }
    }

    if (shouldQuit) return;
    clearScreen();
    setTerminalTitle('♫ mux');
  }
}

main().catch((error) => {
  setTerminalTitle('♫ mux');
  console.error(`${APP_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
