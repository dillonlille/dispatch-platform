These `.py.fixture` files exercise the first installed Python-to-Rust handoff.
`runtime_artifact.py.fixture` and `update-dev.py.fixture` are frozen copies from
`bc8f1c85eee376b467fa193eaa84d792f7a9ab8c`; keep them unchanged so the test verifies
compatibility with the updater already deployed before this migration.

`handoff.py.fixture` runs them in an isolated temporary host with fake service
commands and a loopback health endpoint. The Python tooling suite invokes it;
the Rust suite owns ongoing updater behavior.
