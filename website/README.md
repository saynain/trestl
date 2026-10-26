# Trestl website and documentation

A static Astro website with integrated Fumadocs documentation at `/docs/` and the actual Trestl dashboard embedded as an interactive playground. The demo builds the root application's `src/App.tsx`, components, keyboard shortcuts, and styles without duplicating their implementation. Fonts are bundled locally. Marketing, docs, and the demo import the product artwork from `public/trestl-mark.svg` and `public/favicon.svg`; there is no separate website logo to maintain. Asset URLs change with the artwork to refresh browser caches.

## Develop

Install both the product and website dependencies from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir website install --frozen-lockfile
pnpm --dir website dev
```

Open the URL printed by Astro (normally http://127.0.0.1:4321). Use Node.js 22.12+ or a supported newer even-numbered LTS release.

Astro reloads marketing content during development. After changing product source or the demo adapter, run `pnpm --dir website build:demo` and reload the demo. The dashboard is built once when `dev` starts.

## Build and preview

```sh
pnpm --dir website test:demo
pnpm --dir website build
pnpm --dir website preview
```

The build checks the demo's TypeScript, builds the real application with its isolated data adapter, checks Astro, generates `website/dist/`, and verifies the built docs links and anchors. The site must be served from a domain root. No API server or live Trestl instance is needed. `/play/` is the standalone dashboard; `/demo/` contains its generated assets. `/api/search.json` is a static documentation search index, not a Trestl API proxy.

The deployed demo updates when the website is rebuilt and deployed; publishing an app release alone does not update static hosting. The embedded and full-demo URLs include a fingerprint of the built app document so returning visitors load the current bundle after deployment.

The dashboard retains the product's dependencies, including the lazily loaded Excalidraw canvas editor, fonts, and workers. Its bundle is larger than an illustrative mockup. The iframe is lazy-loaded so marketing content does not wait for the app.

## Deploy

The site is published at [trestl.dev](https://trestl.dev) as an assets-only Cloudflare Worker. `wrangler.jsonc` serves `dist/` on the `trestl.dev` custom domain, with `src/pages/404.astro` for unknown paths and no `workers.dev` or preview URLs.

The **Website** workflow builds and deploys the site when a `v*` release tag is pushed, so the docs match the version people can install. Run it manually from **Actions → Website → Run workflow** to redeploy. It uses the `website` environment, whose deployment policy allows release tags and `main`:

- `CLOUDFLARE_API_TOKEN` (environment secret): an account API token created from the **Edit Cloudflare Workers** template, limited to the Trestl account and the `trestl.dev` zone.
- `CLOUDFLARE_ACCOUNT_ID` (environment variable): the Cloudflare account that owns the zone.

To deploy from a workstation after `pnpm --dir website build`, sign in with `npx wrangler@4.152.0 login`, then run `npx wrangler@4.152.0 deploy` in `website/` with `CLOUDFLARE_ACCOUNT_ID` set.

## Documentation

Fumadocs UI supplies the notebook layout, responsive sidebar, table of contents, previous/next navigation, and accessible search dialog. Fumadocs Core builds a section-aware search index, downloaded only when a visitor opens search. The React island is server-rendered by Astro, so article content is present in the generated HTML. Marketing and docs share the palette in `src/styles/tokens.css`, local fonts, brand mark, and `trestl.website.theme` appearance preference.

`src/lib/docs-manifest.ts` defines guide titles, descriptions, navigation order, and source files. Existing guides are read directly from the repository's `docs/`, `deploy/`, `cli/`, and Raycast directories at build time. Edit those source files to update the site; there are no copied versions to synchronize. Quick start and the API overview live in `src/content/docs/`. Add a Markdown file and a manifest entry to add a guide. Rebuild after content changes; development requests read the current files.

`src/lib/docs.ts` compiles GitHub-flavored Markdown, adds syntax highlighting, extracts headings, and rewrites repository-relative links to local docs pages. Links to files without a docs route continue to GitHub. Raw HTML in Markdown is not enabled. Search uses the same source content and heading anchors. The generated `/docs/openapi.json` comes directly from `server/openapi.ts`; a deployed Trestl server's own contract remains authoritative for that version.

Run `pnpm --dir website check:docs` after a build to verify all built internal links and fragments, one H1 and metadata per guide, section-level search data, and the generated API contract. This check also runs as the last step of `build`.

## Structure

- `src/pages/index.astro`: marketing content, metadata, navigation, and installation tabs.
- `src/components/ProductDemo.astro`: iframe, full demo link, reset control, and explanatory copy.
- `src/components/Integrations.astro`: GitHub/Gitea repositories and issues, API, CLI, and Raycast.
- `src/styles/site.css`: marketing typography, layout, responsive design, and reduced-motion support.
- `src/pages/docs/[...slug].astro`: statically generated docs pages.
- `src/components/docs/`: Fumadocs shell, guide content, home, and search.
- `src/styles/docs.css`: Coolify-inspired documentation layout with Trestl branding.
- `src/pages/api/search.json.ts`: static full-text search index.
- `scripts/check-docs.mjs`: built documentation integrity checks.
- `demo/main.tsx`: the real product entry point and styles.
- `demo/vite.config.ts`: reuses the product build and substitutes its API transport and demo appearance preferences. A build guard rejects the production HTTP and canvas WebSocket transports. `demo/canvas-collaboration.ts` keeps canvas saves in the frame and labels the editor **Local demo**.
- `demo/themes.ts`: reuses the product palette library and editor while preserving website theme inheritance and manual overrides.
- `demo/api.ts`: per-instance, in-memory adapter; unsupported requests fail closed without contacting a backend.
- `demo/seed.ts`: sample projects, work items, issues, milestones, roadmap, and canvas.
- `demo/api.test.ts`: mutation, isolation, revision, cleanup, and unsupported-action checks.

Generated `public/demo/` and `.generated/` files are ignored by Git. Build the demo before running Astro directly.

## Demo behavior

Visitors use the same board, list, inbox, item editor, filters, Gantt, roadmap, resources, and canvas editor as the application. Common edits, comments, project creation, and canvas saves work against sample data. Resetting or reloading starts a fresh session; visitors never share data. The in-memory adapter is not the production server and does not reproduce every backend validation or automation rule.

The compact sun/moon toggle defaults to system appearance and remembers an explicit light or dark choice. The demo follows the website until a visitor chooses Light, Dark, or System in the app's Account settings → Appearance. That manual override persists across reloads. Canvas appearance also follows until changed separately. “Match website theme” clears these demo appearance overrides without resetting work. The standalone demo uses the website's saved choice, then the system appearance. Preferences continue to work for the current session if browser storage is blocked.

`demo/preferences.ts` supplies the demo-only inheritance policy. The actual settings and canvas components subscribe to appearance changes, keeping already-open controls synchronized without reloading the app or losing edits.

Git connections and imported issues are illustrative. Live sync, credentials, account administration, and token creation require a real installation. The marketing copy describes inbound issue sync accurately: edits in Trestl are not posted back to Git providers. External source and documentation links remain ordinary links.

## Before public launch

The root README currently says the repository is private. Make it publicly accessible before marketing the source as available to everyone. Source and license links point to `https://github.com/saynain/trestl`; documentation links stay under `/docs/`. This website does not change repository visibility or publish anything.

Set Astro's `site` configuration and add a canonical URL when the production domain is selected. The $0 claim refers to the MIT-licensed software; users provide hosting. Docker and Kubernetes links lead to the full configuration guides.
