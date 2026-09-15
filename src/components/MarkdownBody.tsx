import { parseMentionHref, mentionTriggers } from '../../shared/mentions';
import { AppContext } from '../lib/context';
import { navigate } from '../lib/model';
import './mentions.css';
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
  a: function MentionLink({ node, ...props }) {
    const app = useContext(AppContext);
    const mention = parseMentionHref(props.href || '');
    if (!mention || !app) return <a {...props} target="_blank" rel="noopener noreferrer" />;
    const target =
      mention.kind === 'user'
        ? app.data.users.find((u) => u.id === mention.id)
        : mention.kind === 'project'
          ? app.data.projects.find((p) => p.id === mention.id)
          : app.data.items.find((i) => i.id === mention.id);
    if (!target)
      return (
        <span className="mention mention-unavailable">
          Unavailable {mention.kind === 'user' ? 'person' : mention.kind}
        </span>
      );
    const label = 'identifier' in target ? target.identifier : target.name;
    if (mention.kind === 'user')
      return (
        <span className="mention" title={label}>
          {mentionTriggers.user}
          {label}
        </span>
      );
    return (
      <a
        className="mention"
        href={`#/${mention.kind}/${mention.id}`}
        title={'title' in target ? target.title : label}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (mention.kind === 'item') app.openItem(mention.id);
          else navigate('project', mention.id);
        }}
      >
        {mentionTriggers[mention.kind]}
        {label}
      </a>
    );
  },
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
