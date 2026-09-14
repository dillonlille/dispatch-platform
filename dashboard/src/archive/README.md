# Archived Dispatch presentation

`styles.css` is the unchanged published stylesheet from
`archive/2026-09-14T004629Z/live/dashboard/public/assets/styles.css`.
`paycom-workforce.css` is the archived Paycom frontend stylesheet from
`archive/2026-09-14T004629Z/worktrees/platform-monorepo/plugins/paycom/frontend/`.
The matching Inter font and its license are in `dashboard/public/assets/`.

The archived UI is the presentation reference. Plugins and Backups pages are
intentionally excluded. The shell, authentication, DSP directory and detail
sheets, owner onboarding, Home Page, Paycom tables and settings, Connections,
Team & Roles, Theme, Diagnostics and Updates restore the archived layouts.
Application-specific adjustments belong in `../styles.css`, not the reference CSS.

The rebuilt shared services remain authoritative. Updates show the shared build
and automatic deployment status instead of per-DSP installations. First and last
names remain separate. Browser assistance uses the current isolated browser service.
DSP removal suspends access and retains data for restoration. Diagnostics creates
isolated synthetic test DSPs without provider credentials or collection jobs.
Paycom preferences, scheduling and revision history are private to each DSP.
No archived server, credentials, databases or customer data are imported.
