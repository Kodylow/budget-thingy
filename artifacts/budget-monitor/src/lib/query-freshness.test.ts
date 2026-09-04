import { readFile, readdir } from 'node:fs/promises';
import { expect, test } from 'vitest';

import {
  DATA_REFRESH_INTERVAL_MS,
  QUERY_STALE_TIME_MS,
} from './client-performance';

test('standard queries inherit one-minute freshness and polling defaults', async () => {
  expect(QUERY_STALE_TIME_MS).toBe(60_000);
  expect(DATA_REFRESH_INTERVAL_MS).toBe(60_000);

  const appSource = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  expect(appSource).toContain('staleTime: QUERY_STALE_TIME_MS');
  expect(appSource).toContain('refetchInterval: DATA_REFRESH_INTERVAL_MS');

  const pagesUrl = new URL('../pages/', import.meta.url);
  const pageFiles = (await readdir(pagesUrl)).filter((name) => name.endsWith('.tsx'));
  const pageSources = await Promise.all(
    pageFiles.map((name) => readFile(new URL(name, pagesUrl), 'utf8')),
  );
  const pageOptions = pageSources.flatMap((source) =>
    source.match(/\b(?:staleTime|refetchInterval)\s*:/g) ?? [],
  );
  expect(pageOptions).toEqual([]);
});