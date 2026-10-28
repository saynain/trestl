# Product direction

The maintainer adopted this position on 2026-10-29. Use it to decide whether a change belongs in Trestl. The open [epics](https://github.com/saynain/trestl/issues?q=is%3Aissue%20state%3Aopen%20label%3Aepic) hold the roadmap.

## Position

Trestl is project management for small technical teams. It should be bare minimum, really fast, and easy to set up properly.

Trestl also aims to be the self-hosted work queue that a team shares with its coding agents.

## Who it is for

Small technical teams of about 2–15 people who self-host Git.

## The wedge: ready → claim → review

Agents claim unblocked work through the CLI or MCP, do it in the team's own Gitea, Forgejo or GitHub repository, and hand it back for human review with the pull request linked. People see the same queue in the app.

This is direction, not a shipped feature. What exists today:

- Agents with a shell use the [CLI](../../cli/README.md) and its agent skill. They get scoped API tokens, revision checks on updates, and idempotency keys for creates and comments.
- Gitea and GitHub issues can be linked to projects or imported. Sync is inbound only, and pull requests are not imported.

Planned: ready, claim and review states, agent identities, outgoing webhooks and an MCP server ([#69](https://github.com/saynain/trestl/issues/69)); two-way sync, pull request linking and verified Forgejo support ([#68](https://github.com/saynain/trestl/issues/68)).

## What to stress

- MIT, with every feature included. No open core.
- One process on a laptop or a server. The server runs the app and the API, with an embedded database (PGlite) or PostgreSQL.
- Projects move between installations with [project export and import](../project-transfer.md).

## Frozen

These features stay, but get bug fixes only. Don't extend them.

- Live canvas collaboration
- Roadmap presentation and print
- Activity heatmaps
- The theme library
- The Raycast extension
- Confluence search

## Non-goals

- Time tracking or invoicing.
- Chat, wikis or docs. Link to documentation instead.
- Multi-tenancy, organization switching, billing or SaaS provisioning. One installation is one organization. A hosting provider can run separate installations.
- Native mobile apps.
- In-app AI. Agents bring their own model.

## Core product

One named installation, one user identity per person, private inboxes and private or shared projects. Ongoing responsibilities and platforms use ongoing projects; bounded deliveries use fixed projects. The same complete application runs locally or on a team's server. No central account, subscription, or hosted authentication service is required.

First-run onboarding creates the installation and its password-protected administrator. Administrators configure local sign-in, Google, OpenID Connect (OIDC), or a trusted authentication proxy, and manage people and server-side integrations. Personal API access belongs to the account. Integration configuration identifies which credentials and repositories are shared; the server must reach the external service.

## Deferred ideas

The desktop app could later store several installation/account profiles, each tied to its server URL. Keep API clients independent of a single hard-coded server. This is an idea, not part of the current implementation.

Real deployment hostnames, company email domains, and secrets belong only in private deployment configuration.
