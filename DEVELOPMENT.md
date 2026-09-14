# Development

## Start and stop

`npm run dev` seeds three synthetic DSPs, starts the API on loopback 5180, and
starts Vite on loopback 5173. The permanent Dev DSP uses Preview’s separate job
database and browser manager. In this convenient local mode, both environments
run the current source. Testing two different artifacts uses the separate
Preview process and gateway, exercised by the operations and artifact tests.

No npm command installs a system service, changes a proxy, opens a public port,
reads archived credentials, or changes the future live directories.
`npm run build` writes only `.build/` inside this repository. It bundles API and
worker code, installs locked production dependencies into the artifact, and
writes a complete SHA-256 inventory. It does not activate the artifact.

Use Ctrl+C to stop `npm run dev`. Remove its explicitly selected fixture state
directory only after the process exits. The browser verification scripts remove
their own temporary state automatically; `tooling/clean-test-output.mjs` removes
the known screenshots and reports. Do not remove unrelated `/tmp` entries.

## Workflows to exercise

1. Sign in as the platform owner. Search DSPs and open Northline Logistics.
2. Browse employees, search by name/code, open an employee, and inspect timecards.
3. Open Connections, save synthetic Paycom credentials, and collect data.
4. Use password `require-verification` to exercise the owner verification flow;
   fixture code is `123456`. `invalid-password` exercises a failed connection.
5. Enable a daily schedule in the DSP’s timezone. Check Jobs for completion.
6. Create a DSP, generate an owner invitation, accept it, and test owner/manager/
   member boundaries. Development mail is written privately to
   `local/platform/development-mail` inside the selected fixture state root.
7. Suspend and resume a DSP. The permanent Dev DSP cannot be suspended.
8. Import a build into a disposable state root with the CLI and inspect Releases.
   Deployment controls remain disabled unless an operator explicitly enables them.

Browser assistance is available for real native fixture/provider sessions that
need verification. The fast in-memory fixtures support code verification and do
not fabricate browser screenshots.

## Checks

`npm test` covers account/role/CSRF boundaries, DSP view tampering, provisioning,
invitations, reset revocation, encrypted credential binding, schedules, durable
jobs, failed-publication preservation, artifact integrity, private-state
preservation, backup checksums, and separate Preview routing. Native and compiled
supervisor tests are opt-in commands because they require a built artifact.

`npm run test:ui` checks the built API and dashboard together: owner login, DSP
search, employee detail, punches, credentials, verification, collection results,
restricted member navigation, mobile layout, and JavaScript errors.

CI runs typechecking, service tests, dependency audit, the build, the compiled
supervisor simulation, and browser checks. It has read-only repository permission.
There is no release-publishing or deployment workflow in this rebuild.

## Changes and data compatibility

Update shared contracts and both producer/consumer paths together. Validate
provider data before publication and preserve the last successful dataset on
failure. Never accept a DSP filesystem path from a request. Provider workers
must not receive the platform state root or vault path.

Shared account schemas are controlled by the production process. Preview refuses
to migrate that shared database. Shared authentication, routing, or account-schema
changes require an isolated full-platform staging run before promotion. A Dev
DSP alone cannot validate a replacement for the gateway currently routing to it.
