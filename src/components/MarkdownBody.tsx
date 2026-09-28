import { parseMentionHref, mentionTriggers } from '../../shared/mentions';
import { AppContext } from '../lib/context';
import { navigate } from '../lib/model';
import './mentions.css';
import { createContext, useContext } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeTaskCheckboxes, setMarkdownTaskChecked } from '../lib/markdown-tasks';
import { MermaidDiagram } from './MermaidDiagram';
import './MarkdownBody.css';

const TaskContext = createContext<{
  source: string;
  onChange?: (markdown: string) => void;
  saving: boolean;
}>({ source: '', saving: false });

const markdownComponents: Components = {
  pre: function CodeBlock({ node, children, ...props }) {
    const code = node?.children[0];
    if (code?.type === 'element' && code.tagName === 'code') {
      const classes = code.properties.className;
      const language = Array.isArray(classes)
        ? classes.find((value) => typeof value === 'string' && value.startsWith('language-'))
        : undefined;
      if (language === 'language-mermaid' || language === 'language-flowchart') {
        const raw = code.children
          .map((child) => (child.type === 'text' ? child.value : ''))
          .join('');
        const source =
          language === 'language-flowchart' && !/^\s*(?:flowchart|graph)\b/i.test(raw)
            ? `flowchart TD\n${raw}`
            : raw;
        return <MermaidDiagram source={source} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
  a: function MentionLink({ node, ...props }) {
    const app = useContext(AppContext);
    const mention = parseMentionHref(props.href || '');
    if (!mention || !app) return <a {...props} target="_blank" rel="noopener noreferrer" />;
    const target =
      mention.kind === 'user'
        ? app.data.users.find((u) => u.id === mention.id)
        : mention.kind === 'milestone'
          ? app.data.milestones.find((m) => m.id === mention.id)
          : mention.kind === 'canvas'
            ? app.data.canvases?.find((c) => c.id === mention.id)
            : mention.kind === 'project'
              ? app.data.projects.find((p) => p.id === mention.id)
              : app.data.items.find((i) => i.id === mention.id);
    if (!target)
      return (
        <span className="mention mention-unavailable">
          Unavailable {mention.kind === 'user' ? 'person' : mention.kind}
        </span>
      );
    const label =
      'identifier' in target ? target.identifier : 'name' in target ? target.name : target.title;
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
        href={
          mention.kind === 'canvas' && 'projectId' in target
            ? `#/project/${target.projectId}?tab=${encodeURIComponent(`canvases/${mention.id}`)}`
            : mention.kind === 'milestone' && 'projectId' in target
              ? `#/project/${target.projectId}?tab=overview/${mention.id}`
              : `#/${mention.kind}/${mention.id}`
        }
        title={'title' in target ? target.title : label}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (mention.kind === 'item') app.openItem(mention.id);
          else if (mention.kind === 'canvas' && 'projectId' in target)
            navigate('project', target.projectId!, `canvases/${mention.id}`);
          else if (mention.kind === 'milestone' && 'projectId' in target)
            navigate('project', target.projectId!, `overview/${mention.id}`);
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
