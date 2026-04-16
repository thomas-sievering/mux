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
  cookiesFile?: string;
}

interface PlaybackState {
  title: string;
  duration?: number;
  playbackTime: number;
  paused: boolean;
  stopped: boolean;
}

const APP_NAME = 'mux';
const MIN_DURATION_SECONDS = 20 * 60;
const MAX_RESULTS = 10;
const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '--version']);
const BOT_CHECK_PATTERN = /sign in to confirm you're not a bot|use --cookies-from-browser or --cookies/i;
const HISTORY_DIR = path.join(os.homedir(), '.mux');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.json');
const FAVORITES_PATH = path.join(HISTORY_DIR, 'favorites.json');
const CONFIG_PATH = path.join(HISTORY_DIR, 'config.json');
let shownPlaybackHelp = false;
let playbackHeaderLines = 0;

function clearScreen(): void {
  if (output.isTTY) output.write('\x1Bc');
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
  console.log('  cookies chrome|edge|firefox|brave  Save browser cookies source');
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
      cookiesFile: typeof data.cookiesFile === 'string' ? data.cookiesFile : undefined,
    };
  } catch {
    return {};
  }
}

async function writeConfig(data: ConfigData): Promise<void> {
  await ensureHistory();
  const normalized: ConfigData = {};
  if (data.cookiesFromBrowser?.trim()) normalized.cookiesFromBrowser = data.cookiesFromBrowser.trim();
  if (data.cookiesFile?.trim()) normalized.cookiesFile = data.cookiesFile.trim();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

async function printSettings(): Promise<void> {
  const config = await readConfig();
  const envBrowser = process.env.MUX_COOKIES_FROM_BROWSER?.trim();
  const envCookies = process.env.MUX_COOKIES?.trim();
  console.log('Settings');
  console.log(`- config path: ${CONFIG_PATH}`);
  console.log(`- cookies from browser: ${config.cookiesFromBrowser ?? 'none'}`);
  console.log(`- cookies file: ${config.cookiesFile ?? 'none'}`);
  if (envBrowser || envCookies) {
    console.log('- env override active: yes');
    if (envBrowser) console.log(`  MUX_COOKIES_FROM_BROWSER=${envBrowser}`);
    if (envCookies) console.log(`  MUX_COOKIES=${envCookies}`);
  } else {
    console.log('- env override active: no');
  }
  console.log('Commands: cookies chrome | cookies edge | cookies firefox | cookies brave | cookies file <path> | cookies off');
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
    await writeConfig({});
    console.log('Cleared saved cookies settings.');
    return true;
  }

  if (subcommand === 'file') {
    const filePath = rest.join(' ').trim();
    if (!filePath) {
      console.log('Usage: cookies file <path>');
      return true;
    }
    await writeConfig({ ...config, cookiesFromBrowser: undefined, cookiesFile: filePath });
    console.log(`Saved cookies file: ${filePath}`);
    return true;
  }

  if (subcommand && ['chrome', 'edge', 'firefox', 'brave'].includes(subcommand)) {
    await writeConfig({ ...config, cookiesFromBrowser: subcommand, cookiesFile: undefined });
    console.log(`Saved cookies browser: ${subcommand}`);
    return true;
  }

  console.log('Usage: cookies chrome|edge|firefox|brave | cookies file <path> | cookies off');
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

async function getYtDlpAuthArgs(): Promise<string[]> {
  const cookiesFromBrowser = process.env.MUX_COOKIES_FROM_BROWSER?.trim();
  const cookies = process.env.MUX_COOKIES?.trim();
  if (cookiesFromBrowser) return ['--cookies-from-browser', cookiesFromBrowser];
  if (cookies) return ['--cookies', cookies];

  const config = await readConfig();
  if (config.cookiesFromBrowser) return ['--cookies-from-browser', config.cookiesFromBrowser];
  if (config.cookiesFile) return ['--cookies', config.cookiesFile];
  return [];
}

function formatYtDlpError(stderr: string, exitCode: number | null): Error {
  const trimmed = stderr.trim();
  if (BOT_CHECK_PATTERN.test(trimmed)) {
    return new Error(
      [
        'YouTube asked yt-dlp to sign in and confirm you are not a bot.',
        'Set one of these before running mux, or configure it in-app:',
        '  settings',
        '  cookies chrome',
        '  cookies edge',
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
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('yt-dlp', [...authArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function playEntry(entry: SearchEntry, queue: SearchEntry[] = []): Promise<'stopped' | 'next' | 'quit'> {
  const ipcPath = getIpcPath();
  const mpvArgs = [
    '--no-video',
    '--quiet',
    '--input-terminal=no',
    `--input-ipc-server=${ipcPath}`,
    entry.url,
  ];

  const child = spawn('mpv', mpvArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdout.resume();

  const state: PlaybackState = {
    title: entry.title,
    duration: entry.duration,
    playbackTime: 0,
    paused: false,
    stopped: false,
  };

  let socket: net.Socket | null = null;
  let buffer = '';
  let tick = 0;

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
            if (msg.name === 'playback-time' && typeof msg.data === 'number') state.playbackTime = msg.data;
            if (msg.name === 'duration' && typeof msg.data === 'number') state.duration = msg.data;
            if (msg.name === 'pause' && typeof msg.data === 'boolean') state.paused = msg.data;
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
    });
  } catch {
    // status will still work without IPC updates
  }

  clearScreen();
  playbackHeaderLines = 0;
  console.log(soft(entry.title));
  console.log(dim('[p]ause  [n]ext  [s]top  [f]av  [q]uit  [1-9] vol'));
  shownPlaybackHelp = true;

  const oldRaw = input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  hideCursor();
  input.resume();
  input.setEncoding('utf8');

  let result: 'stopped' | 'next' | 'quit' = 'stopped';
  let commandBuffer = '';

  let lastLineWidth = 0;
  const render = () => {
    const status = state.paused ? 'paused' : 'play';
    const viz = state.paused || state.stopped ? '          ' : renderVisualizer(tick);
    if (!state.paused && !state.stopped) tick += 0.35;
    const visibleLine = `[${formatDuration(state.playbackTime)} / ${formatDuration(state.duration)}] ${status} ${viz}`
      .slice(0, Math.max(20, (output.columns ?? 80) - 1));
    const paddedVisible = visibleLine.padEnd(lastLineWidth);
    lastLineWidth = Math.max(lastLineWidth, visibleLine.length);
    const renderedLine = `${dim(`[${formatDuration(state.playbackTime)} / ${formatDuration(state.duration)}]`)} ${status} ${dim(viz)}`;
    output.write(`\r${renderedLine}${' '.repeat(Math.max(0, paddedVisible.length - visibleLine.length))}`);
  };

  const interval = setInterval(render, 150);
  render();

  const onKey = async (key: string) => {
    const char = key.toLowerCase();
    if (key === '\u0003') {
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
        const volume = Number(char) * 10;
        await sendMpvCommand(ipcPath, ['set_property', 'volume', volume]);
      }
      if (char === 'p' || commandBuffer.endsWith('pause')) {
        commandBuffer = '';
        await sendMpvCommand(ipcPath, ['cycle', 'pause']);
      }
      if (char === 's' || commandBuffer.endsWith('stop')) {
        commandBuffer = '';
        state.stopped = true;
        result = 'stopped';
        try { await sendMpvCommand(ipcPath, ['quit']); } catch {}
        await terminateProcess(child);
      }
      if (char === 'n' || commandBuffer.endsWith('skip')) {
        commandBuffer = '';
        state.stopped = true;
        result = 'next';
        try { await sendMpvCommand(ipcPath, ['quit']); } catch {}
        await terminateProcess(child);
      }
      if (char === 'f' || commandBuffer.endsWith('fav')) {
        commandBuffer = '';
        const added = await addFavorite(entry);
        output.write(`\r${dim(added ? 'saved to favorites' : 'already in favorites')}`);
        await sleep(700);
      }
      if (char === 'q' || commandBuffer.endsWith('quit')) {
        commandBuffer = '';
        state.stopped = true;
        result = 'quit';
        try { await sendMpvCommand(ipcPath, ['quit']); } catch {}
        await terminateProcess(child);
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
      const stopSpinner = startSpinner('loading');
      try {
        selected = await inspectUrl(query);
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        continue;
      } finally {
        stopSpinner();
      }
    }

    let queue: SearchEntry[] = [];
    if (!selected && query) {
      const stopSpinner = startSpinner();
      let results: SearchEntry[] = [];
      try {
        results = await searchYoutube(query);
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        continue;
      } finally {
        stopSpinner();
      }
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
  }
}

main().catch((error) => {
  console.error(`${APP_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
});
