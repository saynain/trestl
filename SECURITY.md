# Security policy

## Supported versions

Security fixes are made on `main` and shipped in the next release. Run the
latest release of the server, CLI, desktop app, and container image.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**.

Include the affected version or commit, how to reproduce the problem, and its
impact. If you found it on a running installation, describe the deployment
(Docker Compose, Kubernetes, desktop) without sharing real workspace data or
credentials.

Trestl is maintained by a small team. Reports are acknowledged as soon as
possible, and you will be kept informed while a fix is prepared. Please allow
time for a release before disclosing details publicly.

## Scope

This covers the code in this repository: the server, web app, CLI, desktop app,
Raycast extension, and published release artifacts. Each operator is
responsible for their own hostnames, ingress, database, secrets, and
environment configuration.
