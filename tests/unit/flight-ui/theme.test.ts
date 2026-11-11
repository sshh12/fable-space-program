import { describe, expect, it } from 'vitest';
import { HUD_CSS } from '@/ui/hud/hudStyles';
import { UI_COLORS, UI_FONT_FAMILY } from '@/core/ui/theme';

describe('interface theme shared by the HUD and the map (request map-view-4)', () => {
  it('the HUD stylesheet takes its font and its palette from the theme', () => {
    const root = HUD_CSS.slice(HUD_CSS.indexOf('.hud {'), HUD_CSS.indexOf('}', HUD_CSS.indexOf('.hud {')));
    const declared = (name: string): string | undefined => new RegExp(`${name}:\s*([^;]+);`).exec(root)?.[1]?.trim();
    expect(declared('font-family')).toBe(UI_FONT_FAMILY);
    expect(declared('--text')).toBe(UI_COLORS.text);
    expect(declared('--label')).toBe(UI_COLORS.label);
    expect(declared('--dim')).toBe(UI_COLORS.dim);
    expect(declared('--accent')).toBe(UI_COLORS.accent);
    expect(declared('--good')).toBe(UI_COLORS.good);
    expect(declared('--caution')).toBe(UI_COLORS.caution);
    expect(declared('--warning')).toBe(UI_COLORS.warning);
    expect(declared('--line')).toBe(UI_COLORS.line);
    expect(declared('--bg')).toBe(UI_COLORS.panel);
    expect(declared('--bg-strong')).toBe(UI_COLORS.panelStrong);
  });

  it('holds the values the HUD was designed with (a change here restyles HUD and map together)', () => {
    expect(UI_FONT_FAMILY.startsWith('Bahnschrift')).toBe(true);
    expect(UI_COLORS).toEqual({
      text: '#eef4fb',
      label: '#aebccf',
      dim: '#8492a7',
      accent: '#55d4ff',
      good: '#5fe39a',
      caution: '#ffbb4d',
      warning: '#ff6a6a',
      line: 'rgba(170, 198, 235, 0.26)',
      panel: 'rgba(17, 24, 34, 0.97)',
      panelStrong: 'rgba(12, 17, 25, 0.985)',
    });
  });
});
