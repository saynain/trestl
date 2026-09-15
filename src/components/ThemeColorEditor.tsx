import { useState } from 'react';
import { validColor, type ThemeAppearance, type ThemeColors } from '../lib/themes';
const fields: [keyof ThemeColors, string][] = [
  ['canvas', 'Background'],
  ['surface', 'Surface'],
  ['text', 'Text'],
  ['textMuted', 'Muted text'],
  ['accent', 'Accent'],
  ['accentForeground', 'Text on accent'],
  ['border', 'Borders'],
  ['sidebar', 'Sidebar'],
  ['sidebarForeground', 'Sidebar text'],
  ['sidebarMutedForeground', 'Muted sidebar text'],
];
export default function ThemeColorEditor({
  json,
  onChange,
}: {
  json: string;
  onChange: (json: string) => void;
}) {
  const [mode, setMode] = useState<ThemeAppearance>('light');
  let file;
  try {
    file = JSON.parse(json);
    if (
      !file ||
      !['light', 'dark'].includes(file.appearance) ||
      typeof file.colors !== 'object' ||
      !file.colors
    )
      return null;
  } catch {
    return null;
  }
  const active = mode === file.appearance || file.variants?.[mode] ? mode : file.appearance;
  const colors = active === file.appearance ? file.colors : file.variants[active];
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return null;
  const write = () => onChange(JSON.stringify(file, null, 2) + '\n');
  return (
    <div className="theme-color-editor">
      <label className="field">
        Theme name
        <input
          className="input"
          maxLength={48}
          value={typeof file.name === 'string' ? file.name : ''}
          onChange={(e) => {
            file.name = e.target.value;
            write();
          }}
        />
      </label>
      <div className="theme-editor-modes" role="group" aria-label="Edit theme variant">
        {(['light', 'dark'] as const)
          .filter((m) => m === file.appearance || file.variants?.[m])
          .map((m) => (
            <button
              key={m}
              className="button"
              aria-pressed={active === m}
              onClick={() => setMode(m)}
            >
              {m === 'light' ? 'Light colors' : 'Dark colors'}
            </button>
          ))}
      </div>
      <div className="theme-color-fields">
        {fields.map(([role, label]) => (
          <label className="field" key={role}>
            {label}
            <span>
              <i style={{ background: validColor(colors[role]) ? colors[role] : 'transparent' }} />
              <input
                className="input"
                aria-label={`${label} color`}
                value={typeof colors[role] === 'string' ? colors[role] : ''}
                onChange={(e) => {
                  colors[role] = e.target.value;
                  write();
                }}
              />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
