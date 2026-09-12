import { createContext, useContext } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeTaskCheckboxes, setMarkdownTaskChecked } from '../lib/markdown-tasks';
import './MarkdownBody.css';

const TaskContext = createContext<{
  source: string;
  onChange?: (markdown: string) => void;
  saving: boolean;
}>({ source: '', saving: false });

const markdownComponents: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  input: function TaskCheckbox({ node, ...props }) {
    const { source, onChange, saving } = useContext(TaskContext);
    const offset = node?.properties['data-task-offset'];
    const editable = !!onChange && typeof offset === 'number';
    return (
      <input
        {...props}
        disabled={!editable}
        aria-disabled={editable && saving}
        onChange={(event) => {
          if (editable && !saving)
            onChange(setMarkdownTaskChecked(source, offset, event.target.checked));
        }}
      />
    );
  },
};

export function MarkdownBody({
  children,
  className = '',
  onChange,
  saving = false,
}: {
  children: string;
  className?: string;
  onChange?: (markdown: string) => void;
  saving?: boolean;
}) {
  return (
    <div className={`item-markdown ${className}`.trim()}>
      <TaskContext.Provider value={{ source: children, onChange, saving }}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeTaskCheckboxes]}
          components={markdownComponents}
        >
          {children}
        </Markdown>
      </TaskContext.Provider>
    </div>
  );
}
