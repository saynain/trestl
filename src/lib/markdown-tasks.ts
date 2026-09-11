type MarkdownNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number } };
  children?: MarkdownNode[];
};

function taskText(node: MarkdownNode): string {
  if (node.tagName === 'ul' || node.tagName === 'ol') return '';
  return node.value ?? node.children?.map(taskText).join('') ?? '';
}

// Attach source offsets only to checkboxes produced by the Markdown parser.
// Text that resembles a task in code blocks must never become editable.
export function rehypeTaskCheckboxes() {
  return (tree: MarkdownNode, file: { toString(): string }) => {
    const source = file.toString();
    function visit(node: MarkdownNode) {
      if (node.tagName === 'li' && node.position?.start.offset !== undefined) {
        const start = node.position.start.offset;
        const marker = /^(?:[-+*]|\d+[.)])[\t ]+\[[ xX]\]/.exec(source.slice(start));
        const first = node.children?.find((child) => child.type === 'element');
        const input = first?.tagName === 'p' ? first.children?.[0] : first;
        if (marker && input?.tagName === 'input' && input.properties?.type === 'checkbox') {
          input.properties['data-task-offset'] = start + marker[0].length - 2;
          input.properties['aria-label'] = `Task: ${taskText(node).trim()}`;
        }
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

export function setMarkdownTaskChecked(source: string, offset: number, checked: boolean): string {
  if (
    !Number.isInteger(offset) ||
    offset < 1 ||
    !/^\[[ xX]\]$/.test(source.slice(offset - 1, offset + 2))
  )
    return source;
  return source.slice(0, offset) + (checked ? 'x' : ' ') + source.slice(offset + 1);
}
