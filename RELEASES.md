# Platform releases

One public repository and one platform version: vX.Y.Z. Prepare only on request.
Report the last published release, installed versions and changes under Core,
DSP and Plugins, then ask for a clickable patch/minor/major version unless supplied.

The manual release.yml workflow accepts version, expected_main and changes (a JSON
object with core/dsp/plugins strings). It requires successful main checks, builds
immutable artifacts, verifies provenance and uploaded bytes, and publishes one
release. No deployment credentials are used by GitHub. Existing tags are immutable.

platform-release.json binds the Core and DSP component digests. Unchanged components
reference the last release containing those exact packages, so plugin-only changes
never create a Core update. Shared source changes rebuild affected products. Core
and DSP manifests/archives have distinct asset names. SDK and plugin package
versions must change when their installed bytes change.

The single owner Updates page has Core, DSP and Plugins sections. Update Core
installs only the selected release's Core package. Update Dev installs the DSP
package only on permanent Dev: dashboard, runtime, installed plugins and catalog.
Plugin-only changes are DSP updates. Other DSPs keep their current dashboard and
catalog. The owner tests Dev and clicks Rollout Update for sequential activation.
New candidates require another Dev test; active rollouts keep their pinned digest.
Failures pause rollout. Credentials/settings/databases remain independent.

Core APIs must support installed DSP protocol versions; incompatible activation
is rejected. A Core update never rewrites DSP dependency copies. DSP dashboards
are cached centrally once per release and selected through authenticated sessions.
New DSPs use the completed production rollout and only builtin Cortex by default.

Migration retains legacy manifests and freezes the currently deployed dashboard
for DSP releases that predate dashboard packaging. Do not remove old repositories
or release assets while installed/rollback references still use them. The initial
bootstrap requires verified release assets, an idle updater, dashboard snapshots,
and a reversible Core activation. Publishing alone does not perform this cutover.
