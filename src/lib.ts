export interface SearchEntry {
  id: string;
  title: string;
  duration?: number;
  channel?: string;
  webpage_url?: string;
  url: string;
}

export const MIN_DURATION_SECONDS = 20 * 60;
export const RANDOM_POOL_SIZE = 5;

export function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '--:--:--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function stripEmojis(value: string): string {
  return value
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pickRandomEntry(entries: SearchEntry[], random = Math.random): SearchEntry | null {
  if (entries.length === 0) return null;
  const preferred = entries.filter((entry) => !entry.duration || entry.duration >= MIN_DURATION_SECONDS);
  const pool = (preferred.length > 0 ? preferred : entries).slice(0, RANDOM_POOL_SIZE);
  return pool[Math.floor(random() * pool.length)] ?? null;
}

export function pickWeightedRandom(queries: string[], random = Math.random): string | null {
  if (queries.length === 0) return null;
  const counts = new Map<string, number>();
  for (const query of queries) counts.set(query, (counts.get(query) ?? 0) + 1);
  const expanded: string[] = [];
  for (const [query, count] of counts.entries()) {
    for (let i = 0; i < count; i += 1) expanded.push(query);
  }
  return expanded[Math.floor(random() * expanded.length)] ?? null;
}

export function renderVisualizer(tick: number): string {
  const frames = ['⠁', '⠂', '⠄', '⠂'];
  return frames[Math.abs(Math.floor(tick)) % frames.length] ?? frames[0]!;
}

export type StartupMode = 'quit' | 'search' | 'url' | 'last' | 'shuffle' | 'recent' | 'favorites';

export function expandSearchQuery(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  const needsAmbience = !/\b(ambience|ambient)\b/.test(lower);
  const needsMusic = !/\bmusic\b/.test(lower);

  const parts = [trimmed];
  if (needsAmbience) parts.push('ambience');
  if (needsMusic) parts.push('music');
  return parts.join(' ');
}

export function parseStartupValue(value: string): { mode: StartupMode; value?: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'q' || trimmed === 'quit') return { mode: 'quit' };
  if (trimmed === 'last') return { mode: 'last' };
  if (trimmed === 'shuffle') return { mode: 'shuffle' };
  if (trimmed === 'recent') return { mode: 'recent' };
  if (trimmed === 'favorites' || trimmed === 'favs' || trimmed === 'fav') return { mode: 'favorites' };
  return isLikelyUrl(trimmed) ? { mode: 'url', value: trimmed } : { mode: 'search', value: expandSearchQuery(trimmed) };
}
