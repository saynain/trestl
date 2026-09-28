import { useEffect, useId, useState } from 'react';

let renderQueue = Promise.resolve();
let initialized = false;

export function MermaidDiagram({ source }: { source: string }) {
  const id = `trestl-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(false);
    if (source.length > 20_000) {
      setError(true);
      return;
    }
    const render = renderQueue.then(async () => {
      const { default: mermaid } = await import('mermaid');
      if (!initialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          maxTextSize: 20_000,
          theme: 'neutral',
          flowchart: { htmlLabels: false },
        });
        initialized = true;
      }
      return mermaid.render(id, source);
    });
    renderQueue = render.then(
      () => undefined,
      () => undefined,
    );
    void render.then(
      (result) => {
        if (active) setSvg(result.svg);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id, source]);

  if (error)
    return (
      <div className="item-diagram-error">
        <span>Could not render diagram</span>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  return (
    <div
      className="item-diagram"
      role="img"
      aria-label="Mermaid diagram"
      aria-busy={!svg}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    >
      {!svg ? 'Rendering diagram…' : undefined}
    </div>
  );
}
