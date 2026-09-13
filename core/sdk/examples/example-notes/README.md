# Example Notes

Edit the manifest to declare settings, operations and permissions. Edit backend/index.js for business logic and frontend/index.tsx for the page.

From the platform source root:

- `bin/dispatch plugin generate example-notes`: regenerate clients and OpenAPI after changing the manifest.
- `bin/dispatch plugin dev example-notes`: build and start a separate synthetic workspace with two DSP owners.
- `bin/dispatch plugin check example-notes`: verify contracts and the installable package.

The starter uses existing dashboard.view and organization.settings.manage grants; choose the existing permission appropriate to each operation. This example does not define new platform roles.

The development runner uses synthetic accounts and DSP-local SQLite files. It is for trusted local development, not a security sandbox. Real DSP installation still goes through the approved package catalog and isolated worker lifecycle.
