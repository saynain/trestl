import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ShortcutMatcher,
  shortcuts,
  type ShortcutDefinition,
  type ShortcutId,
  type ItemAction,
} from './shortcuts';

type ScopeName = 'global' | 'list' | 'item' | 'composer';
type Actions = Partial<Record<ShortcutId, () => void | boolean>>;
type Scope = {
  name: ScopeName;
  actions: Actions;
  enabled: boolean;
  root?: RefObject<HTMLElement | null>;
};
const Registry = createContext<((get: () => Scope) => () => void) | null>(null);
export function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      !!target.closest(
        'input,textarea,select,[role="textbox"],[role="combobox"],[contenteditable]:not([contenteditable="false"])',
      ))
  );
}
export function activateItemControl(root: HTMLElement | null, action: ItemAction) {
  const element = root?.querySelector<HTMLElement>(
    `[data-shortcut="${shortcuts[action].keys[0]}"]`,
  );
  if (!element || element.matches(':disabled')) return false;
  element.focus();
  if (element instanceof HTMLButtonElement) element.click();
  else if (element instanceof HTMLInputElement && element.type === 'date') {
    try {
      element.showPicker();
    } catch {
      /* Focusing still permits keyboard date entry. */
    }
  }
  return true;
}
export function KeyboardProvider({ children }: { children: ReactNode }) {
  const scopes = useRef(new Map<symbol, () => Scope>());
  const [prefix, setPrefix] = useState('');
  const register = useCallback((get: () => Scope) => {
    const id = Symbol();
    scopes.current.set(id, get);
    return () => {
      scopes.current.delete(id);
    };
  }, []);
  useEffect(() => {
    const matcher = new ShortcutMatcher();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      matcher.reset();
      setPrefix('');
      clearTimeout(timer);
    };
    const handle = (event: KeyboardEvent) => {
      if (document.querySelector('.canvas-editor') || event.defaultPrevented || event.isComposing) {
        reset();
        return;
      }
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return;
      const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1);
      const typing = isTyping(event.target);
      const menu = document.querySelector('.popover, .profile-popover');
      if (document.querySelector('.picker-panel:popover-open')) {
        reset();
        return;
      }
      const available = new Map<ShortcutId, () => void | boolean>();
      const registered = [...scopes.current.values()]
        .map((get) => get())
        .filter((scope) => scope.enabled);
      // Contextual actions take precedence over workspace actions.
      registered.sort((a, b) => Number(a.name === 'global') - Number(b.name === 'global'));
      for (const scope of registered) {
        if (scope.root && !scope.root.current?.isConnected) continue;
        if (scope.name === 'list' && dialog) continue;
        if (
          (scope.name === 'item' || scope.name === 'composer') &&
          (!dialog || !scope.root?.current || !dialog.contains(scope.root.current))
        )
          continue;
        for (const [id, run] of Object.entries(scope.actions) as [
          ShortcutId,
          () => void | boolean,
        ][]) {
          const definition: ShortcutDefinition = shortcuts[id];
          if (menu && !definition.dialog && id !== 'filter' && id !== 'dismiss') continue;
          if (typing && !definition.typing) continue;
          if (scope.name === 'global' && dialog && !definition.dialog) continue;
          if (!available.has(id)) available.set(id, run);
        }
      }
      const result = matcher.match(event, [...available.keys()], mac, performance.now());
      if (result.prefix) {
        event.preventDefault();
        setPrefix(result.prefix);
        clearTimeout(timer);
        timer = setTimeout(reset, 1000);
      } else if (result.id) {
        reset();
        if (available.get(result.id)?.() !== false) event.preventDefault();
      } else reset();
    };
    window.addEventListener('keydown', handle);
    window.addEventListener('blur', reset);
    document.addEventListener('pointerdown', reset, true);
    document.addEventListener('focusin', reset);
    window.addEventListener('hashchange', reset);
    return () => {
      reset();
      window.removeEventListener('keydown', handle);
      window.removeEventListener('blur', reset);
      document.removeEventListener('pointerdown', reset, true);
      document.removeEventListener('focusin', reset);
      window.removeEventListener('hashchange', reset);
    };
  }, []);
  return (
    <Registry.Provider value={register}>
      {children}
      {prefix && (
        <div className="shortcut-sequence" role="status">
          <kbd>{prefix.toUpperCase()}</kbd>
          <span>{prefix === 'g' ? 'Go to…' : 'Open…'}</span>
          <small>Esc to cancel</small>
        </div>
      )}
    </Registry.Provider>
  );
}
export function useShortcuts(
  name: ScopeName,
  actions: Actions,
  options: { enabled?: boolean; root?: RefObject<HTMLElement | null> } = {},
) {
  const register = useContext(Registry);
  const current = useRef<Scope>({
    name,
    actions,
    enabled: options.enabled ?? true,
    root: options.root,
  });
  current.current = { name, actions, enabled: options.enabled ?? true, root: options.root };
  useEffect(() => register?.(() => current.current), [register]);
}
