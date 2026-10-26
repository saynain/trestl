# Contributing to Trestl

Trestl is a small-team and personal project workspace. Prefer improvements that
make everyday capture, planning, and collaboration simpler. Keep advanced
features optional and deployment configuration portable.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report
security problems privately as described in the [security policy](SECURITY.md),
not in a public issue.

Looking for a place to start? Try the issues labeled
[good first issue](https://github.com/saynain/trestl/labels/good%20first%20issue)
or [help wanted](https://github.com/saynain/trestl/labels/help%20wanted).

## Development

Follow the [development guide](docs/development.md). Use a disposable local
workspace for testing. Do not commit local databases, backups, credentials, or
screenshots containing real workspace data.

Before a pull request, run `pnpm typecheck`, `pnpm test`, `pnpm build`, and
`pnpm format:check`. Add regression coverage for changed behavior. For CLI
changes, also run `pnpm test:cli-package`. For deployment changes, render the
Kustomize example and run the Docker smoke test described in the development
guide. Run the extension's checks when changing Raycast code.

Describe the problem, resulting behavior, and relevant verification in the
pull request. Discuss substantial changes in an issue before implementing
them. Keep unrelated cleanup separate.

## Deployment boundaries

The product repository owns its image, generic Kubernetes resources, and
self-hosting instructions. Each operator owns their hostnames, ingress,
database, image pins, secret provisioning, and environment configuration in
a separate deployment repository. Never add a company-specific deployment
overlay here.

## License

Contributions are provided under the project's [MIT license](LICENSE).
