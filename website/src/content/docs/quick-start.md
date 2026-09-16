# Quick start

Trestl is a self-hosted project workspace for personal projects and small teams. Run it locally with an embedded database, or use [Docker Compose](/docs/self-hosting/docker/) for a packaged installation.

## Before you begin

You need **Node.js 22.9+**, **pnpm 10.7.1**, and Git. Repository access is required while the project is private.

## Start Trestl

```sh
git clone https://github.com/saynain/trestl.git
cd trestl
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API runs on port 4317. Your local data persists in `.data/` through PGlite; no external database is required.

## Make it yours

On your first visit, name the installation and create your administrator account with your name, email, and password. There are no default credentials. Start empty or choose to include example projects.

One installation supports one person or a team. Keep private tasks in your **Personal inbox**, and use projects to organize shared work. Administrators manage people and authentication in **Administration**. Your profile, appearance, and API tokens live in **Account settings**, available from the account menu at the bottom of the sidebar.

## Capture your first task

Use quick capture on **Home** to add a task, follow-up, or someday idea. It starts in your private inbox without needing a project. Open the item to add details, dates, or a project when you're ready.

Use **⌘K / Ctrl+K** to open search and **C** to create a work item when you're not typing in a field. See the [user guide](/docs/user-guide/) for boards, timelines, roadmaps, and canvases.

## Choose your next step

- [Installation & accounts](/docs/installation/): configure sign-in and invite your team.
- [Docker Compose](/docs/self-hosting/docker/): set up persistent hosting, HTTPS, and backups.
- [CLI & agents](/docs/integrations/cli/): work from any repository or terminal.
- [Try the demo](/play/): explore sample projects without installing anything.

Trestl is an early release. Run one application instance, back up before upgrading, and retain your `APP_SECRET`. See the deployment guide for operational limits and backup instructions.
