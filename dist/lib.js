export const MIN_DURATION_SECONDS = 20 * 60;
export const RANDOM_POOL_SIZE = 5;
export function isLikelyUrl(value) {
    return /^https?:\/\//i.test(value.trim());
}
export function formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds))
        return '--:--:--';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    if (h > 0)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function pickRandomEntry(entries, random = Math.random) {
    if (entries.length === 0)
        return null;
    const preferred = entries.filter((entry) => !entry.duration || entry.duration >= MIN_DURATION_SECONDS);
    const pool = (preferred.length > 0 ? preferred : entries).slice(0, RANDOM_POOL_SIZE);
    return pool[Math.floor(random() * pool.length)] ?? null;
}
export function pickWeightedRandom(queries, random = Math.random) {
    if (queries.length === 0)
        return null;
    const counts = new Map();
    for (const query of queries)
        counts.set(query, (counts.get(query) ?? 0) + 1);
    const expanded = [];
    for (const [query, count] of counts.entries()) {
        for (let i = 0; i < count; i += 1)
            expanded.push(query);
    }
    return expanded[Math.floor(random() * expanded.length)] ?? null;
}
export function renderVisualizer(tick) {
    const chars = ['▁', '▂', '▃', '▄', '▅', '▆'];
    let out = '';
    for (let i = 0; i < 12; i += 1) {
        const idx = Math.abs(Math.floor(Math.sin((tick + i) / 2) * 5)) % chars.length;
        out += chars[idx];
    }
    return out;
}
export function expandSearchQuery(value) {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed)
        return trimmed;
    const lower = trimmed.toLowerCase();
    const needsAmbience = !/\b(ambience|ambient)\b/.test(lower);
    const needsMusic = !/\bmusic\b/.test(lower);
    const parts = [trimmed];
    if (needsAmbience)
        parts.push('ambience');
    if (needsMusic)
        parts.push('music');
    return parts.join(' ');
}
export function parseStartupValue(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'q' || trimmed === 'quit')
        return { mode: 'quit' };
    if (trimmed === 'last')
        return { mode: 'last' };
    if (trimmed === 'shuffle')
        return { mode: 'shuffle' };
    if (trimmed === 'recent')
        return { mode: 'recent' };
    if (trimmed === 'favorites' || trimmed === 'favs' || trimmed === 'fav')
        return { mode: 'favorites' };
    return isLikelyUrl(trimmed) ? { mode: 'url', value: trimmed } : { mode: 'search', value: expandSearchQuery(trimmed) };
}
