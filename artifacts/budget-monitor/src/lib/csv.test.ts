import { describe, expect, it } from 'vitest';

import { buildCsv } from './csv';

describe('buildCsv', () => {
  it('neutralizes formula-leading Workspace Directory values', () => {
    const csv = buildCsv([[
      '=HYPERLINK("https://attacker.invalid")',
      '\t+Injected Name',
      ' \r\n@InjectedUsername',
      '\n-Injected Workspace',
    ]]);

    expect(csv).toContain('"\'=HYPERLINK(""https://attacker.invalid"")"');
    expect(csv).toContain('"\'\t+Injected Name"');
    expect(csv).toContain('"\' \r\n@InjectedUsername"');
    expect(csv).toContain('"\'\n-Injected Workspace"');
    expect(csv).not.toContain('"=HYPERLINK');
  });
});