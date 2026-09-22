import {
  ArrowRight,
  Blocks,
  Command,
  FileCode2,
  GitBranch,
  PanelsTopLeft,
  Rocket,
  Terminal,
} from 'lucide-react';

export const homeToc = [
  { title: 'Make yourself at home', url: '#make-yourself-at-home', depth: 2 },
  { title: 'Connect your workflow', url: '#connect-your-workflow', depth: 2 },
  { title: 'On your terms', url: '#on-your-terms', depth: 2 },
];

const starters = [
  {
    title: 'Quick start',
    text: 'Run locally and create your first account.',
    href: '/docs/quick-start/',
    Icon: Rocket,
  },
  {
    title: 'Self-host with Docker',
    text: 'Bring Trestl to your own infrastructure.',
    href: '/docs/self-hosting/docker/',
    Icon: Blocks,
  },
  {
    title: 'Explore the workspace',
    text: 'Find your way around projects and tasks.',
    href: '/docs/user-guide/',
    Icon: PanelsTopLeft,
  },
];
const connections = [
  {
    title: 'GitHub & Gitea',
    text: 'Bring repository issues into your projects.',
    href: '/docs/integrations/github/',
    Icon: GitBranch,
  },
  {
    title: 'Raycast',
    text: 'Keep your work a keyboard shortcut away.',
    href: '/docs/integrations/raycast/',
    Icon: Command,
  },
  {
    title: 'CLI & agents',
    text: 'Capture and update work from your terminal.',
    href: '/docs/integrations/cli/',
    Icon: Terminal,
  },
  {
    title: 'API reference',
    text: 'Build on Trestl with its scoped API.',
    href: '/docs/api/',
    Icon: FileCode2,
  },
];

export default function DocsHome() {
  return (
    <div className="docs-home">
      <header className="docs-intro">
        <h1>
          A little structure.
          <br className="intro-break" /> A lot of <em>Trestl.</em>
        </h1>
        <p>Your guide to setting up, using, and making Trestl your own.</p>
      </header>
      <section aria-labelledby="make-yourself-at-home" className="home-section">
        <h2 id="make-yourself-at-home">Make yourself at home</h2>
        <p>Start with a workspace that belongs to you.</p>
        <div className="start-guides">
          {starters.map(({ title, text, href, Icon }) => (
            <a key={href} href={href} className="start-guide">
              <Icon size={29} strokeWidth={1.5} aria-hidden="true" />
              <h3>{title}</h3>
              <div>
                <p>{text}</p>
                <ArrowRight size={18} aria-hidden="true" />
              </div>
            </a>
          ))}
        </div>
      </section>
      <section aria-labelledby="connect-your-workflow" className="home-section">
        <h2 id="connect-your-workflow">Connect your workflow</h2>
        <p>Explore tools and integrations to fit your setup.</p>
        <div className="connection-guides">
          {connections.map(({ title, text, href, Icon }) => (
            <a key={href} href={href} className="connection-guide">
              <Icon size={23} strokeWidth={1.5} aria-hidden="true" />
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
      <section aria-labelledby="on-your-terms" className="home-section docs-ownership">
        <h2 id="on-your-terms">On your terms</h2>
        <p>MIT licensed. Self-hosted. Every feature included.</p>
        <a href="/docs/self-hosting/docker/">
          Read the deployment guide <ArrowRight size={16} aria-hidden="true" />
        </a>
      </section>
    </div>
  );
}
