import { describe, expect, test } from 'bun:test';
import {
  expandSearchQuery,
  formatDuration,
  isLikelyUrl,
  parseStartupValue,
  pickRandomEntry,
  pickWeightedRandom,
  renderVisualizer,
  type SearchEntry,
} from '../src/lib';

describe('isLikelyUrl', () => {
  test('detects http/https urls', () => {
    expect(isLikelyUrl('https://youtube.com/watch?v=abc')).toBe(true);
    expect(isLikelyUrl('http://example.com')).toBe(true);
    expect(isLikelyUrl('harry potter ambience')).toBe(false);
  });
});

describe('formatDuration', () => {
  test('formats hour durations', () => {
    expect(formatDuration(3 * 3600 + 5 * 60 + 9)).toBe('03:05:09');
  });

  test('formats minute durations', () => {
    expect(formatDuration(125)).toBe('02:05');
  });

  test('handles unknown durations', () => {
    expect(formatDuration()).toBe('--:--:--');
  });
});

describe('pickRandomEntry', () => {
  const entries: SearchEntry[] = [
    { id: '1', title: 'short', duration: 100, url: 'u1' },
    { id: '2', title: 'long-1', duration: 1800, url: 'u2' },
    { id: '3', title: 'long-2', duration: 2400, url: 'u3' },
  ];

  test('prefers long entries', () => {
    const picked = pickRandomEntry(entries, () => 0);
    expect(picked?.title).toBe('long-1');
  });

  test('returns null for empty list', () => {
    expect(pickRandomEntry([], () => 0)).toBeNull();
  });
});

describe('pickWeightedRandom', () => {
  test('respects weighting', () => {
    const picked = pickWeightedRandom(['hp', 'hp', 'lotr'], () => 0.5);
    expect(picked).toBe('hp');
  });

  test('returns null for empty list', () => {
    expect(pickWeightedRandom([], () => 0.1)).toBeNull();
  });
});

describe('renderVisualizer', () => {
  test('returns 12 chars', () => {
    expect(renderVisualizer(0)).toHaveLength(12);
  });
});

describe('expandSearchQuery', () => {
  test('adds ambience and music when missing', () => {
    expect(expandSearchQuery('harry potter study')).toBe('harry potter study ambience music');
  });

  test('does not duplicate ambience or music', () => {
    expect(expandSearchQuery('harry potter ambience')).toBe('harry potter ambience music');
    expect(expandSearchQuery('harry potter music')).toBe('harry potter music ambience');
    expect(expandSearchQuery('harry potter ambience music')).toBe('harry potter ambience music');
  });
});

describe('parseStartupValue', () => {
  test('parses commands', () => {
    expect(parseStartupValue('last')).toEqual({ mode: 'last' });
    expect(parseStartupValue('shuffle')).toEqual({ mode: 'shuffle' });
    expect(parseStartupValue('recent')).toEqual({ mode: 'recent' });
    expect(parseStartupValue('fav')).toEqual({ mode: 'favorites' });
    expect(parseStartupValue('q')).toEqual({ mode: 'quit' });
  });

  test('parses urls and searches', () => {
    expect(parseStartupValue('https://youtube.com/watch?v=abc')).toEqual({
      mode: 'url',
      value: 'https://youtube.com/watch?v=abc',
    });
    expect(parseStartupValue('harry potter study')).toEqual({
      mode: 'search',
      value: 'harry potter study ambience music',
    });
  });
});
