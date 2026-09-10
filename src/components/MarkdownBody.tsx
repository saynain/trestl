import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './MarkdownBody.css';

export function MarkdownBody({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`item-markdown ${className}`.trim()}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
      >
        {children}
      </Markdown>
    </div>
  );
}
