# Development

Use Node 22/24, npm, Python 3 and Linux. Build in a new directory outside source:

```sh
npm run bootstrap -- /absolute/build/workspace
npm run check -- /absolute/build/workspace
npm run build -- /absolute/build/workspace
npm test -- /absolute/build/workspace
npm run test:integration -- /absolute/build/workspace
```

Bootstrap assembles portable Core and DSP source trees, copies top-level plugins
into the DSP build workspace, merges shared UI source with each product's owned
entry points, and installs locked compiler dependencies plus versioned SDK copies.
These assembled trees are disposable, not additional source repositories. After
editing source, bootstrap a fresh workspace before final verification.

DSP browser collector tests need trusted Chrome, Xvfb, setpriv and X11 libraries;
the hosted checks prepare these on an isolated runner. Tests use synthetic data.

Use feature branches and PRs. The owner authorizes autonomous PR creation and
merging after review and successful checks. Publication and installation remain
separate. See RELEASES.md. Never develop in live/ or installed DSP directories.
