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
import { formatDuration, isLikelyUrl, parseStartupValue, pickRandomEntry, pickWeightedRandom, renderVisualizer, } from './lib.js';
const APP_NAME = 'mux';
const MIN_DURATION_SECONDS = 20 * 60;
const MAX_RESULTS = 10;
const HISTORY_DIR = path.join(os.homedir(), '.mux');
const HISTORY_PATH = path.join(HISTORY_DIR, 'history.json');
const FAVORITES_PATH = path.join(HISTORY_DIR, 'favorites.json');
let shownPlaybackHelp = false;
let playbackHeaderLines = 0;
function clearScreen() {
    if (output.isTTY)
        output.write('\x1Bc');
}
function dim(text) {
    return output.isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}
function soft(text) {
    return output.isTTY ? `\x1b[36m${text}\x1b[0m` : text;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function ensureHistory() {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    if (!fsSync.existsSync(HISTORY_PATH)) {
        await fs.writeFile(HISTORY_PATH, JSON.stringify({ plays: [] }, null, 2), 'utf8');
    }
}
async function readFavorites() {
    await ensureHistory();
    try {
        if (!fsSync.existsSync(FAVORITES_PATH))
            return { items: [] };
        const raw = await fs.readFile(FAVORITES_PATH, 'utf8');
        const data = JSON.parse(raw);
        return { items: Array.isArray(data.items) ? data.items : [] };
    }
    catch {
        return { items: [] };
    }
}
async function writeFavorites(data) {
    await ensureHistory();
    await fs.writeFile(FAVORITES_PATH, JSON.stringify({ items: data.items.slice(-200) }, null, 2), 'utf8');
}
async function addFavorite(entry) {
    const favorites = await readFavorites();
    if (favorites.items.some((item) => item.url === entry.url))
        return false;
    favorites.items.push({
        title: entry.title,
        url: entry.url,
        duration: entry.duration,
        addedAt: new Date().toISOString(),
    });
    await writeFavorites(favorites);
    return true;
}
async function chooseFavorite() {
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
    if (!Number.isInteger(pick) || pick < 1 || pick > favorites.items.length)
        return null;
    const item = favorites.items[pick - 1];
    return {
        id: item.url,
        title: item.title,
        duration: item.duration,
        url: item.url,
    };
}
async function readHistory() {
    await ensureHistory();
    try {
        const raw = await fs.readFile(HISTORY_PATH, 'utf8');
        const data = JSON.parse(raw);
        return { plays: Array.isArray(data.plays) ? data.plays : [] };
    }
    catch {
        return { plays: [] };
    }
}
async function writeHistory(data) {
    await ensureHistory();
    const trimmed = { plays: data.plays.slice(-200) };
    await fs.writeFile(HISTORY_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
}
async function appendHistory(item) {
    const history = await readHistory();
    history.plays.push(item);
    await writeHistory(history);
}
async function requireCommand(command) {
    const checker = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? [command] : ['-v', command];
    await new Promise((resolve, reject) => {
        const child = spawn(checker, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Missing required command: ${command}`)));
        child.on('error', () => reject(new Error(`Missing required command: ${command}`)));
    });
}
function normalizeEntry(entry) {
    const id = entry.id ?? entry.url;
    const title = entry.title;
    const duration = typeof entry.duration === 'number' ? entry.duration : undefined;
    const webpageUrl = entry.webpage_url ?? (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : undefined);
    const url = webpageUrl ?? entry.url;
    if (!id || !title || !url)
        return null;
    return {
        id: String(id),
        title: String(title),
        duration,
        channel: entry.channel ?? entry.uploader,
        webpage_url: webpageUrl,
        url: String(url),
    };
}
async function runYtDlp(args) {
    return await new Promise((resolve, reject) => {
        const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0)
                resolve(stdout);
            else
                reject(new Error(stderr || `yt-dlp failed with code ${code}`));
        });
    });
}
async function searchYoutube(query) {
    const raw = await runYtDlp([
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        `ytsearch${MAX_RESULTS}:${query}`,
    ]);
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry).filter(Boolean) : [];
    const longFirst = entries
        .filter((entry) => !entry.duration || entry.duration >= MIN_DURATION_SECONDS)
        .concat(entries.filter((entry) => entry.duration && entry.duration < MIN_DURATION_SECONDS));
    return longFirst;
}
async function inspectUrl(url) {
    const raw = await runYtDlp([
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        url,
    ]);
    const parsed = JSON.parse(raw);
    const normalized = normalizeEntry(parsed);
    if (!normalized)
        throw new Error('Could not read video metadata.');
    return normalized;
}
async function prompt(question) {
    const rl = createInterface({ input, output });
    try {
        const answer = await rl.question(question);
        return answer.trim();
    }
    finally {
        rl.close();
    }
}
function printSearchResults(entries, selected) {
    void entries;
    void selected;
}
function startSpinner(label = 'searching') {
    const frames = ['⠁', '⠂', '⠄', '⠂'];
    let index = 0;
    output.write(` ${dim(`${frames[0]} ${label}`)}`);
    const timer = setInterval(() => {
        output.write(`\r${' '.repeat(6)}\r`);
        output.write(`mux> ${dim(`${frames[index % frames.length]} ${label}`)}`);
        index += 1;
    }, 100);
    return () => {
        clearInterval(timer);
        clearCurrentScreenLine();
    };
}
function clearCurrentLine() {
    clearLine(output, 0);
    cursorTo(output, 0);
}
function clearCurrentScreenLine() {
    clearCurrentLine();
    output.write('\r');
}
function hideCursor() {
    if (output.isTTY)
        output.write('\x1b[?25l');
}
function showCursor() {
    if (output.isTTY)
        output.write('\x1b[?25h');
}
function clearPlaybackHeader() {
    if (playbackHeaderLines <= 0)
        return;
    for (let i = 0; i < playbackHeaderLines; i += 1) {
        moveCursor(output, 0, -1);
        clearCurrentLine();
    }
    playbackHeaderLines = 0;
}
function getIpcPath() {
    if (process.platform === 'win32')
        return `\\\\.\\pipe\\mux-${process.pid}-${Date.now()}`;
    return path.join(os.tmpdir(), `mux-${process.pid}-${Date.now()}.sock`);
}
function sendMpvCommand(ipcPath, command) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(ipcPath, () => {
            client.write(JSON.stringify({ command }) + '\n');
            client.end();
            resolve();
        });
        client.on('error', reject);
    });
}
async function waitForSocket(ipcPath, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (process.platform === 'win32') {
            try {
                await new Promise((resolve, reject) => {
                    const client = net.createConnection(ipcPath, () => { client.destroy(); resolve(); });
                    client.on('error', reject);
                });
                return;
            }
            catch {
                // retry
            }
        }
        else if (fsSync.existsSync(ipcPath)) {
            return;
        }
        await sleep(100);
    }
    throw new Error('Timed out waiting for mpv IPC.');
}
async function terminateProcess(child) {
    if (child.killed)
        return;
    if (process.platform === 'win32') {
        await new Promise((resolve) => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            killer.on('exit', () => resolve());
            killer.on('error', () => resolve());
        });
        return;
    }
    child.kill('SIGTERM');
    await sleep(250);
    if (!child.killed)
        child.kill('SIGKILL');
}
async function playEntry(entry, queue = []) {
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
    const state = {
        title: entry.title,
        duration: entry.duration,
        playbackTime: 0,
        paused: false,
        stopped: false,
    };
    let socket = null;
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
                if (!trimmed)
                    continue;
                try {
                    const msg = JSON.parse(trimmed);
                    if (msg.event === 'property-change') {
                        if (msg.name === 'playback-time' && typeof msg.data === 'number')
                            state.playbackTime = msg.data;
                        if (msg.name === 'duration' && typeof msg.data === 'number')
                            state.duration = msg.data;
                        if (msg.name === 'pause' && typeof msg.data === 'boolean')
                            state.paused = msg.data;
                        if (msg.name === 'media-title' && typeof msg.data === 'string')
                            state.title = msg.data;
                    }
                }
                catch {
                    // ignore
                }
            }
        });
        socket.on('connect', () => {
            const observe = (name, id) => socket?.write(JSON.stringify({ command: ['observe_property', id, name] }) + '\n');
            observe('playback-time', 1);
            observe('duration', 2);
            observe('pause', 3);
            observe('media-title', 4);
        });
    }
    catch {
        // status will still work without IPC updates
    }
    clearCurrentScreenLine();
    clearPlaybackHeader();
    console.log(soft(entry.title));
    playbackHeaderLines = 1;
    if (!shownPlaybackHelp) {
        console.log(dim('[p]ause  [n]ext  [s]top  [f]av  [q]uit  [1-9] vol'));
        shownPlaybackHelp = true;
        playbackHeaderLines = 2;
    }
    const oldRaw = input.isRaw;
    if (input.isTTY)
        input.setRawMode(true);
    hideCursor();
    input.resume();
    input.setEncoding('utf8');
    let result = 'stopped';
    let commandBuffer = '';
    let lastLineWidth = 0;
    const render = () => {
        const status = state.paused ? 'paused' : 'play';
        const viz = state.paused || state.stopped ? '          ' : renderVisualizer(tick);
        if (!state.paused && !state.stopped)
            tick += 0.35;
        const visibleLine = `[${formatDuration(state.playbackTime)} / ${formatDuration(state.duration)}] ${status} ${viz}`
            .slice(0, Math.max(20, (output.columns ?? 80) - 1));
        const paddedVisible = visibleLine.padEnd(lastLineWidth);
        lastLineWidth = Math.max(lastLineWidth, visibleLine.length);
        const renderedLine = `${dim(`[${formatDuration(state.playbackTime)} / ${formatDuration(state.duration)}]`)} ${status} ${dim(viz)}`;
        output.write(`\r${renderedLine}${' '.repeat(Math.max(0, paddedVisible.length - visibleLine.length))}`);
    };
    const interval = setInterval(render, 150);
    render();
    const onKey = async (key) => {
        const char = key.toLowerCase();
        if (key === '\u0003') {
            state.stopped = true;
            result = 'quit';
            try {
                await sendMpvCommand(ipcPath, ['quit']);
            }
            catch { }
            await terminateProcess(child);
            return;
        }
        if (/^[a-z]$/i.test(char)) {
            commandBuffer = (commandBuffer + char).slice(-8);
        }
        else {
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
                await sendMpvCommand(ipcPath, ['stop']);
            }
            if (char === 'n' || commandBuffer.endsWith('skip')) {
                commandBuffer = '';
                state.stopped = true;
                result = 'next';
                await sendMpvCommand(ipcPath, ['stop']);
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
                try {
                    await sendMpvCommand(ipcPath, ['quit']);
                }
                catch { }
                await terminateProcess(child);
            }
        }
        catch {
            if (char === 'q' || commandBuffer.endsWith('quit')) {
                state.stopped = true;
                result = 'quit';
                await terminateProcess(child);
            }
        }
    };
    input.on('data', onKey);
    await new Promise((resolve) => {
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
    if (input.isTTY)
        input.setRawMode(Boolean(oldRaw));
    input.pause();
    socket?.destroy();
    if (process.platform !== 'win32' && fsSync.existsSync(ipcPath)) {
        try {
            await fs.unlink(ipcPath);
        }
        catch { }
    }
    if (result === 'stopped' && queue.length > 0 && !state.stopped)
        return 'next';
    return result;
}
async function chooseFromRecent() {
    const history = await readHistory();
    const queries = Array.from(new Set(history.plays.map((p) => p.query).filter(Boolean).reverse())).slice(0, 10);
    if (queries.length === 0) {
        console.log('No recent searches yet.');
        return null;
    }
    queries.forEach((query, index) => console.log(`${index + 1}. ${query}`));
    const answer = await prompt('Choose recent search [1]: ');
    if (!answer)
        return queries[0] ?? null;
    const selected = Number(answer);
    if (Number.isInteger(selected) && selected >= 1 && selected <= queries.length)
        return queries[selected - 1] ?? null;
    return null;
}
async function resolveStartupInput(initialArgs) {
    if (initialArgs.length > 0) {
        const joined = initialArgs.join(' ').trim();
        return isLikelyUrl(joined) ? { mode: 'url', value: joined } : { mode: 'search', value: joined };
    }
    const answer = await prompt('mux> ');
    const parsed = parseStartupValue(answer);
    if (parsed.mode === 'recent') {
        const recent = await chooseFromRecent();
        if (!recent)
            return { mode: 'quit' };
        return { mode: 'search', value: recent };
    }
    if (parsed.mode === 'favorites') {
        return { mode: 'favorites' };
    }
    return parsed;
}
async function main() {
    clearScreen();
    await requireCommand('yt-dlp');
    await requireCommand('mpv');
    const startup = await resolveStartupInput(process.argv.slice(2));
    if (startup.mode === 'quit')
        return;
    let query = startup.value ?? '';
    let selected = null;
    if (startup.mode === 'last') {
        const history = await readHistory();
        const last = history.plays.at(-1);
        if (!last) {
            console.log('No last item yet.');
            return;
        }
        query = last.query;
        selected = {
            id: last.url,
            title: last.title,
            duration: last.duration,
            url: last.url,
        };
    }
    else if (startup.mode === 'shuffle') {
        const history = await readHistory();
        const picked = pickWeightedRandom(history.plays.map((p) => p.query).filter(Boolean));
        if (!picked) {
            console.log('No history to shuffle yet.');
            return;
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
        }
        finally {
            stopSpinner();
        }
    }
    let queue = [];
    if (!selected && query) {
        const stopSpinner = startSpinner();
        const results = await searchYoutube(query).finally(stopSpinner);
        if (results.length === 0) {
            console.log('No results found.');
            return;
        }
        selected = pickRandomEntry(results);
        if (!selected)
            return;
        printSearchResults(results, selected);
        queue = results.filter((entry) => entry.url !== selected?.url);
    }
    if (!selected)
        return;
    await appendHistory({
        query: query || selected.title,
        title: selected.title,
        url: selected.url,
        duration: selected.duration,
        playedAt: new Date().toISOString(),
    });
    let current = selected;
    while (current) {
        const result = await playEntry(current, queue);
        if (result === 'quit' || result === 'stopped')
            break;
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
}
main().catch((error) => {
    console.error(`${APP_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    exit(1);
});
