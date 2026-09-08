import Fuse from 'fuse.js';
import type { DevelopmentUser } from './use-development-view';

const normalize = (value: unknown) =>
  typeof value === 'string'
    ? value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim().replace(/\s+/g, ' ')
    : '';
const compact = (value: unknown) => normalize(value).replace(/\s/g, '');

type SearchEntry = {
  user: DevelopmentUser;
  order: number;
  name: string;
  words: string[];
  username: string;
  localPart: string;
};

export function createDevViewSearchIndex(users: DevelopmentUser[]) {
  const entries: SearchEntry[] = users.map((user, order) => {
    const name = normalize(user.name);
    return {
      user,
      order,
      name,
      words: name.split(' ').filter(Boolean),
      username: compact(user.username),
      localPart: compact(typeof user.email === 'string' ? user.email.split('@')[0] : ''),
    };
  });
  const fuse = new Fuse(
    entries.flatMap((entry, userIndex) =>
      [...entry.words, entry.username, entry.localPart]
        .filter(value => value.length >= 4)
        .map(value => ({ userIndex, value })),
    ),
    { keys: ['value'], threshold: 0.25, ignoreLocation: true, includeScore: true, minMatchCharLength: 4 },
  );
  return { entries, fuse };
}

function literalTier(entry: SearchEntry, token: string, wholeQuery: string) {
  if (entry.name === wholeQuery || entry.username === wholeQuery) return 0;
  if (entry.words.includes(token) || entry.localPart === token) return 1;
  if (
    entry.words.some(word => word.startsWith(token))
    || entry.username.startsWith(token)
    || entry.localPart.startsWith(token)
  ) return 2;
  if (
    entry.name.includes(token)
    || entry.username.includes(token)
    || entry.localPart.includes(token)
  ) return 3;
  return null;
}

export function rankDevViewUsers(
  index: ReturnType<typeof createDevViewSearchIndex>,
  query: string,
) {
  const rawQuery = query.trim();
  if (!rawQuery) return index.entries.map(entry => entry.user);

  const isUsernameQuery = rawQuery.startsWith('@') && !rawQuery.slice(1).includes('@');
  const isEmailQuery = !isUsernameQuery && rawQuery.includes('@');
  if (isEmailQuery) {
    const literal = rawQuery.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s/g, '');
    return index.entries
      .filter(({ user }) => typeof user.email === 'string' && user.email.normalize('NFD')
        .replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s/g, '').includes(literal))
      .sort((a, b) => {
        const aExact = a.user.email?.toLowerCase() === literal ? 0 : 1;
        const bExact = b.user.email?.toLowerCase() === literal ? 0 : 1;
        return aExact - bExact || a.order - b.order;
      })
      .map(entry => entry.user);
  }

  const wholeQuery = normalize(isUsernameQuery ? rawQuery.slice(1) : rawQuery);
  const tokens = wholeQuery.split(' ').filter(Boolean);
  if (!tokens.length) return index.entries.map(entry => entry.user);

  const literal = index.entries.flatMap(entry => {
    if (isUsernameQuery) {
      const username = compact(rawQuery.slice(1));
      if (!username || !entry.username.includes(username)) return [];
      return [{ entry, tier: entry.username === username ? 0 : entry.username.startsWith(username) ? 2 : 3 }];
    }
    const tiers = tokens.map(token => literalTier(entry, token, wholeQuery));
    return tiers.some(tier => tier == null)
      ? []
      : [{ entry, tier: Math.max(...tiers as number[]) }];
  }).sort((a, b) => a.tier - b.tier || a.entry.order - b.entry.order);

  const literalOrders = new Set(literal.map(result => result.entry.order));
  if (isUsernameQuery || tokens.some(token => token.length <= 3)) return literal.map(result => result.entry.user);

  const fuzzyByToken = tokens.map(token => {
    const scores = new Map<number, number>();
    for (const result of index.fuse.search(token)) {
      const score = result.score ?? 1;
      if (score <= 0.25 && score < (scores.get(result.item.userIndex) ?? 1)) {
        scores.set(result.item.userIndex, score);
      }
    }
    return scores;
  });
  const fuzzy = index.entries.flatMap(entry => {
    if (literalOrders.has(entry.order)) return [];
    const scores = tokens.map((token, tokenIndex) =>
      literalTier(entry, token, wholeQuery) == null ? fuzzyByToken[tokenIndex].get(entry.order) : 0);
    return scores.some(score => score == null)
      ? []
      : [{ entry, score: scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) }];
  }).sort((a, b) => a.score - b.score || a.entry.order - b.entry.order);

  return [...literal.map(result => result.entry.user), ...fuzzy.map(result => result.entry.user)];
}