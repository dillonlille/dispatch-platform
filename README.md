# Dispatch Platform

One repository and one platform release, with independent Core installation and
Dev-first DSP rollout.

- [core/](core/): Platform Owner dashboard, API, SDK and shared services.
- [dsp/](dsp/): DSP dashboard and runtime.
- [plugins/](plugins/): Paycom and future optional plugins, released with DSP updates.
- [shared/](shared/): reusable dashboard source compiled separately per product.
- [tooling/](tooling/): development, verification, publication and migration.

The Updates page groups Core, DSP and Plugins changes. **Update Core** installs
Core. **Update Dev → Rollout Update** installs the complete DSP experience,
including installed plugins and the approved catalog. Dashboard assets are stored
centrally per release; DSP credentials, settings and databases remain independent.

See [DEVELOPMENT.md](DEVELOPMENT.md), [RELEASES.md](RELEASES.md) and [AGENTS.md](AGENTS.md).
No deployment credentials or DSP private data belong in this public repository.
