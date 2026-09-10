# Shared GitHub organization connection

Register a GitHub App under an account or organization you control. Grant repository **Issues: Read-only** and **Metadata: Read-only**. This integration polls issues and comments; it does not need webhooks or user OAuth authorization. Install the App on the intended organization and choose **All repositories** or an explicit selection. GitHub organization policy may require an owner to approve installation.

In Trestl, open **Administration → Integrations → Add connection → GitHub App · organization**. Enter a descriptive name, the numeric App ID, installation ID (from the installation's GitHub settings URL), and a generated PEM private key. Trestl verifies that it can mint an installation token before saving the encrypted key. `APP_SECRET` must be configured and backed up privately.

Everyone in this Trestl installation can reference issues from repositories available to that GitHub App installation. Administrators can import a repository into a project. Project visibility controls who sees imported work; it does not restrict which repositories a user can query through the shared connection. Only connect repositories appropriate for the whole installation.

Trestl creates short-lived installation access tokens on the server when needed, requesting only Issues and Metadata read access. GitHub's all/selected repository choice continues to govern access. GitHub suspensions, revocations, and repository restrictions apply when Trestl requests access. No GitHub secret is sent to the browser or native clients.

To rotate the private key, add and verify a replacement connection, reconnect repository imports as needed, then disconnect the old connection and revoke its key on GitHub. Disconnecting preserves imported work and existing links but stops its imports.

The previous [personal GitHub App flow](github-app.md) remains compatible for existing credentials; it is separate from this installation-wide connection.
