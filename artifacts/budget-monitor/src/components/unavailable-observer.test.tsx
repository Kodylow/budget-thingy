// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearApiDiagnostics,
  getUiDiagnostics,
  recordApiDiagnostic,
  subscribeApiDiagnostics,
} from '@workspace/api-client-react';
import { UnavailableObserver } from './unavailable-observer';

afterEach(() => {
  document.body.innerHTML = '';
  clearApiDiagnostics();
  vi.restoreAllMocks();
});

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe('UnavailableObserver', () => {
  it('records initial, changed, resolved, removed, and reappearing text without retaining text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.body.innerHTML = '<main><table><tbody><tr><td>Unavailable Unavailable</td></tr></tbody></table></main><div id="mount"></div>';
    recordApiDiagnostic({
      timestamp: new Date().toISOString(),
      method: 'GET',
      endpoint: '/api/spend',
      route: '/',
      status: 200,
      elapsedMs: 1,
      requestId: 'req-safe',
      category: 'success',
    });
    const mount = document.querySelector('#mount')!;
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });
    expect(getUiDiagnostics().at(-1)).toMatchObject({
      event: 'ui_data_unavailable',
      count: 2,
      source: { columnIndex: 0 },
      requestIdCandidates: ['req-safe'],
    });

    const cell = document.querySelector('td')!;
    cell.firstChild!.textContent = 'Ready';
    await settle();
    expect(getUiDiagnostics().at(-1)?.event).toBe('ui_data_available');
    cell.firstChild!.textContent = 'UNAVAILABLE';
    await settle();
    expect(getUiDiagnostics().at(-1)?.event).toBe('ui_data_unavailable');
    cell.remove();
    await settle();
    expect(getUiDiagnostics().at(-1)?.event).toBe('ui_unavailable_removed');

    const serialized = JSON.stringify(getUiDiagnostics());
    expect(serialized).not.toContain('Ready');
    expect(serialized).not.toContain('<td');
    await act(async () => { root.unmount(); });
  });

  it('ignores diagnostics content, deduplicates rerenders, and disconnects on unmount', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mount = document.createElement('div');
    document.body.append(mount);
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });
    const ignored = document.createElement('div');
    ignored.setAttribute('data-diagnostic-ignore', '');
    ignored.textContent = 'unavailable';
    document.body.append(ignored);
    await settle();
    expect(getUiDiagnostics()).toHaveLength(0);

    const label = document.createElement('p');
    label.textContent = 'unavailable';
    document.body.append(label);
    await settle();
    const length = getUiDiagnostics().length;
    label.firstChild!.textContent = 'unavailable';
    await settle();
    expect(getUiDiagnostics()).toHaveLength(length);

    await act(async () => { root.unmount(); });
    const afterUnmount = document.createElement('p');
    afterUnmount.textContent = 'unavailable';
    document.body.append(afterUnmount);
    await settle();
    expect(getUiDiagnostics()).toHaveLength(length);
  });

  it('observes only approved native label attributes without retaining their values', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mount = document.createElement('div');
    const button = document.createElement('button');
    button.title = 'Email activity is unavailable for Private Project';
    button.setAttribute('data-private', 'unavailable secret');
    document.body.append(button, mount);
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });
    expect(getUiDiagnostics().at(-1)).toMatchObject({
      event: 'ui_data_unavailable',
      source: { attribute: 'title' },
    });
    expect(JSON.stringify(getUiDiagnostics())).not.toContain('Private Project');
    button.title = 'Email activity ready';
    await settle();
    expect(getUiDiagnostics().at(-1)?.event).toBe('ui_data_available');
    await act(async () => { root.unmount(); });
  });

  it('caps queued work for a huge added subtree and explicitly records truncation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mount = document.createElement('div');
    document.body.append(mount);
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });
    const huge = document.createElement('section');
    for (let index = 0; index < 4_500; index += 1) {
      huge.append(document.createElement('span'));
    }
    document.body.append(huge);
    await settle();
    expect(getUiDiagnostics().some(entry =>
      entry.truncated === true &&
      entry.source.selector === '[scan-truncated]' &&
      entry.count <= 2,
    )).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('notifies diagnostics subscribers once for many transitions in one frame', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let index = 0; index < 30; index += 1) {
      const label = document.createElement('p');
      label.textContent = 'unavailable';
      document.body.append(label);
    }
    const mount = document.createElement('div');
    document.body.append(mount);
    const listener = vi.fn();
    const unsubscribe = subscribeApiDiagnostics(listener);
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });
    expect(getUiDiagnostics().filter(entry => entry.event === 'ui_data_unavailable')).toHaveLength(30);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await act(async () => { root.unmount(); });
  });

  it('deduplicates textContent replacement by stable direct-text slot and resolves it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const span = document.createElement('span');
    span.textContent = 'Unavailable';
    const mount = document.createElement('div');
    document.body.append(span, mount);
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });

    span.textContent = 'Unavailable';
    await settle();
    span.textContent = 'Ready';
    await settle();
    span.remove();
    await settle();

    const events = getUiDiagnostics().map(entry => entry.event);
    expect(events.filter(event => event === 'ui_data_unavailable')).toHaveLength(1);
    expect(events.filter(event => event === 'ui_data_available')).toHaveLength(1);
    expect(events.filter(event => event === 'ui_unavailable_removed')).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });

  it('reports removal when an unavailable direct-text element is actually removed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const span = document.createElement('span');
    span.textContent = 'Unavailable';
    const mount = document.createElement('div');
    document.body.append(span, mount);
    const root = createRoot(mount);
    await act(async () => { root.render(<UnavailableObserver />); });
    span.remove();
    await settle();
    expect(getUiDiagnostics().map(entry => entry.event)).toEqual([
      'ui_data_unavailable',
      'ui_unavailable_removed',
    ]);
    await act(async () => { root.unmount(); });
  });
});