# Product direction

## Website copy to keep

> Trestl helps you manage your responsibilities, capture ideas and follow-ups, and collaborate on ongoing work and projects. Run it yourself, alone or with your team, with all features included.

Keep this wording for the future project website.

## Core product

One named installation, one user identity per person, private inboxes and private or shared projects. Ongoing responsibilities and platforms use ongoing projects; bounded deliveries use fixed projects. The same complete application runs locally or on a team's server. No central account, subscription, or hosted authentication service is required.

First-run onboarding creates the installation and its password-protected administrator. Administrators configure local sign-in, Google, OpenID Connect (OIDC), or a trusted authentication proxy, and manage people and server-side integrations. Personal API access belongs to the account. Integration configuration identifies which credentials and repositories are shared; the server must reach the external service.

## Deferred ideas

A future cross-platform desktop application could store multiple installation/account profiles, each tied to its server URL. Keep API clients independent of a single hard-coded server. This is an idea, not part of the current implementation.

Hosting multiple customer organizations in one installation is out of scope. A hosting provider can operate separate installations until there is a demonstrated need for multi-tenancy. Do not add organization switching, billing, or SaaS provisioning to the core product.

Real deployment hostnames, company email domains, and secrets belong only in private deployment configuration.
