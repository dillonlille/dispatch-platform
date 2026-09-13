---
title: Repository security policy
status: current
last_verified: 2026-09-02
---

# Security policy

## Sensitive data boundary

This repository must never contain:

- passwords, PINs, recovery answers, API tokens, cookies, or authorization headers;
- Auth Broker master keys or credential databases;
- browser profiles, login databases, session storage, or authenticated caches;
- Paycom, CDF, Collection Manager, Access Control, Provisioner, or other operational databases and backups;
- employee, customer, provider, or account data copied from a live system;
- sockets, service records, logs, staging candidates, or runtime state.

Use synthetic fixtures for tests and documentation. Local operational state belongs in an external owner-private directory configured through `DISPATCH_LOCAL_ROOT` or explicit absolute runtime roots.

Managed installation tests must use temporary synthetic organization/runtime identities and credential-free provider/publication evidence. Do not copy a live installation manifest, outbox/job record, Auth Broker profile, collection batch, publication target, or readiness snapshot into Git. Installation lifecycle repair uses the durable reconciler or closed activation retry—never direct SQL or filesystem edits.

## Reporting a vulnerability

Do not include secret values, personal data, browser artifacts, or live provider responses in a public issue. Contact the repository owner privately or use GitHub private vulnerability reporting when it is enabled.

Include only the minimum sanitized reproduction details needed to understand the problem.

## Accidental exposure

If a credential, key, cookie, browser profile, or private database is pushed, treat it as compromised even if the commit is later deleted:

1. Revoke or rotate the affected credential or key.
2. Invalidate related browser sessions.
3. Preserve a private incident record without copying secret values into Git.
4. Remove the data from Git history and verify the rewritten remote.
5. Review forks, clones, pull-request diffs, workflow artifacts, and caches for continued exposure.

See [runtime/auth-broker/SECURITY.md](runtime/auth-broker/SECURITY.md) for the component trust model and storage requirements.
