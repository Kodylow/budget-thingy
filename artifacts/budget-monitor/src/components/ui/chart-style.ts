type ThemeName = 'light' | 'dark';

type ColorConfig = Record<string, {
  color?: string;
  theme?: Partial<Record<ThemeName, string>>;
}>;

const THEME_SELECTORS: Record<ThemeName, string> = {
  light: '',
  dark: '.dark',
};

export function buildChartStyleText(id: string, config: ColorConfig): string {
  const colorConfig = Object.entries(config).filter(
    ([, itemConfig]) => itemConfig.theme || itemConfig.color,
  );

  return Object.entries(THEME_SELECTORS)
    .map(([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as ThemeName] || itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join('\n')}
}
`)
    .join('\n');
}