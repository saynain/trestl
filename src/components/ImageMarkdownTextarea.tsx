import { useRef, useState, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import { ImagePlus } from 'lucide-react';
import { api } from '../lib/api';
import { MentionTextarea } from './MentionTextarea';

type Props = Omit<ComponentProps<typeof MentionTextarea>, 'value' | 'onChange' | 'onPaste'> & {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  onBusyChange?: (busy: boolean) => void;
};

const accepted = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageMarkdown(name: string, url: string) {
  const label =
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[\[\]\\]/g, '')
      .trim() || 'Screenshot';
  return `![${label}](${url})`;
}

export function ImageMarkdownTextarea({ value, setValue, onBusyChange, ...props }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function insertImages(files: File[], position: number) {
    if (busy || !files.length) return;
    setError('');
    setBusy(true);
    onBusyChange?.(true);
    try {
      const markdown: string[] = [];
      for (const file of files) {
        if (!accepted.has(file.type)) throw new Error('Choose a PNG, JPEG, GIF, or WebP image');
        if (file.size > 8 * 1024 * 1024) throw new Error('Images must be 8 MB or smaller');
        const { url } = await api<{ url: string }>('/images', {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        markdown.push(imageMarkdown(file.name, url));
      }
      const insertion = markdown.join('\n\n');
      setValue((current) => {
        const at = Math.min(position, current.length);
        const before = current.slice(0, at);
        const after = current.slice(at);
        return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${insertion}${after && !after.startsWith('\n') ? '\n' : ''}${after}`;
      });
      root.current?.querySelector('textarea')?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload image');
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      if (picker.current) picker.current.value = '';
    }
  }

  return (
    <div className="image-markdown-editor" ref={root}>
      <MentionTextarea
        {...props}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
          );
          if (!files.length) return;
          event.preventDefault();
          void insertImages(files, event.currentTarget.selectionStart);
        }}
      />
      <div className="image-markdown-actions">
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            const position =
              root.current?.querySelector('textarea')?.selectionStart ?? value.length;
            void insertImages(files, position);
          }}
        />
        <button
          type="button"
          className="image-markdown-upload"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={14} aria-hidden="true" /> {busy ? 'Uploading…' : 'Add image'}
        </button>
        <span className="muted">or paste a screenshot</span>
      </div>
      {error && (
        <p className="image-markdown-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
