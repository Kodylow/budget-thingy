import { describe, expect, it } from 'vitest';
import type { DevelopmentUser } from '@/lib/use-development-view';
import { createDevViewSearchIndex, rankDevViewUsers } from '@/lib/dev-view-search';

const user = (
  userId: string,
  name: string | null,
  username: string | null = null,
  email: string | null = null,
) => ({ userId, name, username, email }) as DevelopmentUser;

const people = [
  user('internal-jai-id', 'Jaci Cole', 'jaci', 'jaci@shared.example'),
  user('2', 'Jaimie Reed', 'jaimie', 'jaimie@shared.example'),
  user('3', 'Jackie Lee', 'jackie', 'jackie@shared.example'),
  user('4', 'Jermaine Hill', 'jermaine', 'jermaine@shared.example'),
  user('5', 'Jai Shah', 'jai', 'jai@shared.example'),
  user('6', 'Jain Patel', 'jain', 'jain@shared.example'),
  user('7', 'José Álvarez', 'jalvarez', 'jose.alvarez@shared.example'),
  user('8', 'Jane Smith', 'jsmith', 'jane.smith@shared.example'),
];
const index = createDevViewSearchIndex(people);
const ids = (query: string) => rankDevViewUsers(index, query).map(person => person.userId);

describe('development-view person ranking', () => {
  it('puts exact matches ahead of prefixes and never scatters short tokens', () => {
    expect(ids('jai')).toEqual(['5', '2', '6']);
    expect(ids('jai')).not.toEqual(expect.arrayContaining(['internal-jai-id', '3', '4']));
    expect(ids('Jaimie')[0]).toBe('2');
  });

  it('allows conservative Fuse typos only for tokens of at least four characters', () => {
    expect(ids('Jaimle')).toEqual(['2']);
    expect(ids('jci')).toEqual([]);
  });

  it('matches normalized, reordered, multiword names', () => {
    expect(ids('alvarez jose')).toEqual(['7']);
    expect(ids('smith jane')).toEqual(['8']);
    expect(ids('José')).toEqual(['7']);
  });

  it('supports literal email and @username without matching shared domains or ids', () => {
    expect(ids('jai@shared')).toEqual(['5']);
    expect(ids('@J.Alvarez')).toEqual(['7']);
    expect(ids('@jane')).toEqual([]);
    expect(ids('shared')).toEqual([]);
    expect(ids('internal-jai-id')).toEqual([]);
  });

  it('preserves roster order when empty and handles duplicate ids and blank fields', () => {
    const roster = [
      user('duplicate', 'First'),
      user('duplicate', 'Second'),
      user('blank', null, null, null),
    ];
    const duplicateIndex = createDevViewSearchIndex(roster);
    expect(rankDevViewUsers(duplicateIndex, '')).toEqual(roster);
    expect(rankDevViewUsers(duplicateIndex, 'second')).toEqual([roster[1]]);
    expect(rankDevViewUsers(duplicateIndex, 'nobody')).toEqual([]);
  });
});