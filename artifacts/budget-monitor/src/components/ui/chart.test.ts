import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildChartStyleText } from './chart-style';

describe('ChartStyle', () => {
  it('renders attacker-controlled config keys as text instead of executable markup', () => {
    const payload = '</style><img src=x onerror="alert(1)">';
    const styleText = buildChartStyleText('chart-safe', {
      [payload]: { color: '#123456' },
    });
    const markup = renderToStaticMarkup(
      React.createElement('style', null, styleText),
    );

    expect(markup).not.toContain(payload);
    expect(markup).not.toContain('</style><img');
    expect(markup).toContain('</\\73 tyle><img');
    expect(markup.match(/<style>/g)).toHaveLength(1);
    expect(markup.match(/<\/style>/g)).toHaveLength(1);
  });
});