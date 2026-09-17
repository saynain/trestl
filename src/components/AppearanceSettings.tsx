import { downloadFile } from '../lib/download';
import ThemeColorEditor from './ThemeColorEditor';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Check,
  Copy,
  Download,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { useApp } from '../lib/context';
import {
  builtInThemes,
  getThemeColorsForAppearance,
  parseThemeFile,
  readAppearance,
  saveAppearance,
  serializeTheme,
  watchAppearance,
  type ThemeAppearance,
  type ThemeDefinition,
  type ThemePreferences,
} from '../lib/themes';
import './appearance.css';

const modes = [
  { id: 'system', label: 'System', Icon: Monitor },
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
] as const;
export default function AppearanceSettings() {
  const { data, toast } = useApp();
  const [preferences, setPreferences] = useState(() => readAppearance(data.user));
  const [draft, setDraft] = useState<{ json: string; originalId?: string } | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => watchAppearance(data.user, setPreferences), [data.user.id]);
  useEffect(() => {
    if (draft) editor.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [!!draft]);
  function update(next: ThemePreferences) {
    setPreferences(next);
    if (!saveAppearance(data.user, next))
      toast(
        'Theme applied, but local storage is unavailable. Changes will not survive a restart.',
        'error',
      );
  }
  function select(id: string, mode?: ThemeAppearance) {
    setError('');
    if (mode) update({ ...preferences, [mode]: id, mode });
    else {
      const theme = [...builtInThemes, ...preferences.custom].find((t) => t.id === id);
      const available = (m: ThemeAppearance) => !theme || !!getThemeColorsForAppearance(theme, m);
      update({
        ...preferences,
        ...(available('light') && { light: id }),
        ...(available('dark') && { dark: id }),
        ...(theme && (!available('light') || !available('dark')) ? { mode: theme.appearance } : {}),
      });
    }
  }
  function edit(theme: ThemeDefinition, duplicate = false) {
    setError('');
    const next = duplicate
      ? {
          ...theme,
          id: `custom-${crypto.randomUUID().slice(0, 12)}`,
          label: `${theme.label.slice(0, 42)} copy`,
        }
      : theme;
    setDraft({ json: serializeTheme(next), ...(!duplicate && { originalId: theme.id }) });
  }
  function install(theme: ThemeDefinition, originalId?: string) {
    if (preferences.custom.some((t) => t.id === theme.id && t.id !== originalId))
      throw new Error('A theme with that ID already exists. Change the ID before saving.');
    const custom = [...preferences.custom.filter((t) => t.id !== originalId), theme];
    const next = { ...preferences, custom };
    for (const mode of ['light', 'dark'] as const)
      if (next[mode] === originalId)
        next[mode] = getThemeColorsForAppearance(theme, mode) ? theme.id : 'trestl';
    update(next);
    setDraft(null);
    setError('');
    toast('Theme saved. Select it below to apply.');
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('Theme files must be smaller than 256 KB.');
      install(parseThemeFile(JSON.parse(await file.text())));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to import theme.');
    }
    if (input.current) input.current.value = '';
  }
  function download(theme: ThemeDefinition) {
    void downloadFile(
      new Blob([serializeTheme(theme)], { type: 'application/json' }),
      `${theme.id}.json`,
    ).catch((error) => setError(error.message));
  }
  function remove(theme: ThemeDefinition) {
    update({
      ...preferences,
      custom: preferences.custom.filter((t) => t.id !== theme.id),
      light: preferences.light === theme.id ? 'trestl' : preferences.light,
      dark: preferences.dark === theme.id ? 'trestl' : preferences.dark,
    });
    if (draft?.originalId === theme.id) setDraft(null);
  }
  const library: (ThemeDefinition | null)[] = [null, ...builtInThemes, ...preferences.custom];
  return (
    <section className="settings-section appearance-settings">
      <h2>Colors &amp; themes</h2>
      <p>
        Make room for your kind of focus. Saved for your profile{' '}
        {import.meta.env.VITE_TRESTL_DESKTOP === 'true' ? 'on this computer' : 'in this browser'}.
      </p>
      <h3>Color scheme</h3>
      <div className="appearance-modes" role="group" aria-label="Color scheme">
        {modes.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={preferences.mode === id}
            onClick={() => update({ ...preferences, mode: id })}
            className="appearance-mode"
          >
            <span className={`appearance-scene ${id}`} aria-hidden="true">
              <i />
              <span>
                <b />
                <b />
                <b />
                <em />
              </span>
            </span>
            <span className="appearance-mode-label">
              <Icon size={14} />
              {label}
              {preferences.mode === id && <Check size={14} />}
            </span>
          </button>
        ))}
      </div>
      <div className="appearance-library-heading">
        <h3>Themes</h3>
        <div>
          <button className="button" onClick={() => edit(builtInThemes[0], true)}>
            <Plus size={13} />
            Create theme
          </button>
          <button className="button" onClick={() => input.current?.click()}>
            <Upload size={13} />
            Add theme
          </button>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Import theme JSON"
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
        </div>
      </div>
      <div className="appearance-library">
        {library.map((theme) => {
          const id = theme?.id ?? 'trestl';
          const label = theme?.label ?? 'Trestl';
          const selected = preferences.light === id || preferences.dark === id;
          const custom = preferences.custom.some((t) => t.id === id);
          return (
            <div className={`appearance-card ${selected ? 'selected' : ''}`} key={id}>
              <div className="appearance-swatches">
                {(['light', 'dark'] as const).map((mode) => {
                  const colors = theme && getThemeColorsForAppearance(theme, mode);
                  if (theme && !colors) return null;
                  const style = {
                    '--orb-bg': colors?.canvas ?? (mode === 'light' ? '#fdfcf9' : '#191c20'),
                    '--orb-accent': colors?.accent ?? (mode === 'light' ? '#b84a29' : '#ee9877'),
                    '--orb-text': colors?.text ?? (mode === 'light' ? '#242824' : '#e4e7eb'),
                  } as CSSProperties;
                  return (
                    <button
                      key={mode}
                      style={style}
                      className={`appearance-orb ${mode}`}
                      title={`Use ${label} ${mode} mode`}
                      aria-label={`Use ${label} ${mode} mode`}
                      aria-pressed={preferences[mode] === id}
                      onClick={() => select(id, mode)}
                    >
                      {preferences[mode] === id && <Check size={10} />}
                    </button>
                  );
                })}
              </div>
              <div className="appearance-card-footer">
                <button
                  className="appearance-theme-name"
                  aria-label={`Use ${label} theme`}
                  aria-pressed={selected}
                  onClick={() => select(id)}
                >
                  {label}
                </button>
                {theme && (
                  <div className="appearance-card-actions">
                    {custom && (
                      <button
                        aria-label={`Edit ${label}`}
                        title="Edit theme"
                        onClick={() => edit(theme)}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    <button
                      aria-label={`Duplicate ${label}`}
                      title="Duplicate theme"
                      onClick={() => edit(theme, true)}
                    >
                      <Copy size={12} />
                    </button>
                    {custom && (
                      <>
                        <button
                          aria-label={`Export ${label}`}
                          title="Export theme"
                          onClick={() => download(theme)}
                        >
                          <Download size={12} />
                        </button>
                        <button
                          aria-label={`Delete ${label}`}
                          title="Delete theme"
                          onClick={() => remove(theme)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="settings-helper">
        Choose a theme name for both modes, or a swatch for just light or dark. System follows your
        device.
      </p>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {draft && (
        <div className="appearance-editor" ref={editor}>
          <h3>{draft.originalId ? 'Edit theme' : 'Create theme'}</h3>
          <p className="settings-helper">
            Choose colors for each appearance. Use hex, RGB, HSL, or OKLCH values.
          </p>
          <ThemeColorEditor json={draft.json} onChange={(json) => setDraft({ ...draft, json })} />
          <details className="theme-advanced">
            <summary>Advanced · edit all color roles</summary>
            <label className="field">
              Theme JSON
              <textarea
                className="input"
                aria-label="Theme JSON"
                spellCheck={false}
                value={draft.json}
                onChange={(e) => setDraft({ ...draft, json: e.target.value })}
              />
            </label>
          </details>
          <div className="settings-form-actions">
            <button
              className="button"
              onClick={() => {
                setDraft(null);
                setError('');
              }}
            >
              Cancel
            </button>
            <button
              className="button primary"
              onClick={() => {
                try {
                  install(parseThemeFile(JSON.parse(draft.json)), draft.originalId);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Invalid theme.');
                }
              }}
            >
              Save theme
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
