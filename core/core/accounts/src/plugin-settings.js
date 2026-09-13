"use strict";
const { AccessError } = require("./validation");
const { plugin } = require("../../../shared/plugin-sdk/catalog");
function createPluginSettings({ store, access, port }) {
  const fail = (code, status = 409) => {
    throw new AccessError(code, status);
  };
  function context(session, id, write) {
    const view = access.organizationFor(session, "dashboard.view");
    const definition = store.pluginMetadataFor ? store.pluginMetadataFor(view.organization.id,id) : plugin(id);
    if (!definition) fail("plugin_not_found", 404);
    const selected = write
      ? access.requireDspOwner(session)
      : access.organizationFor(
          session,
          definition.pages[0]?.permission || "dashboard.view",
        );
    const installation = store.installationControl(selected.organization.id);
    const row = store.db
      .prepare(
        "SELECT * FROM dsp_plugins WHERE organization_id=? AND plugin_id=?",
      )
      .get(selected.organization.id, id);
    if (
      selected.organization.status !== "active" ||
      installation?.status !== "ready" ||
      !row ||
      row.desired_state !== "enabled" ||
      row.applied_state !== "enabled" ||
      row.revision !== row.applied_revision ||
      store.activeLifecycleJob(selected.organization.id) ||
      store.db
        .prepare("SELECT 1 FROM dsp_removals WHERE organization_id=?")
        .get(selected.organization.id) ||
      store.db
        .prepare(
          "SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')",
        )
        .get(selected.organization.id)
    )
      fail("plugin_unavailable");
    return {
      organizationId: selected.organization.id,
      runtimeKey: installation.runtimeKey,
      installationRevision: installation.revision,
      revision: row.revision,
    };
  }
  return async function settings(session, id, action, input) {
    if (!["get", "options", "update", "history"].includes(action))
      fail("invalid_input", 400);
    const write = action === "update",
      before = context(session, id, write || action === "history");
    if (typeof port !== "function") fail("plugin_unavailable", 503);
    let result;
    try {
      result = await port(before.runtimeKey, id, {
        action,
        ...(write
          ? { input, actor: session.user.id }
          : action === "history"
            ? { input }
            : {}),
      });
    } catch (error) {
      const code = error.code || error.message;
      if (["invalid_request", "settings_invalid"].includes(code))
        fail("settings_invalid", 400);
      if (
        [
          "settings_revision_conflict",
          "idempotency_conflict",
          "settings_migration_required",
          "settings_incompatible",
        ].includes(code)
      )
        fail(code);
      fail("settings_unavailable", 503);
    }
    const after = context(session, id, write || action === "history");
    if (JSON.stringify(before) !== JSON.stringify(after))
      fail("plugin_revision_conflict");
    if (write)
      access.audit({
        actorUserId: session.user.id,
        organizationId: before.organizationId,
        action: "plugin.settings.update",
        targetType: "plugin",
        targetId: id,
      });
    if (action === "history") {
      const names = new Map();
      result = {
        ...result,
        items: result.items.map((item) => {
          if (item.updatedBy && !names.has(item.updatedBy))
            names.set(
              item.updatedBy,
              store.db
                .prepare(
                  "SELECT first_name || ' ' || last_name AS name FROM users WHERE id=?",
                )
                .get(item.updatedBy)?.name || "Former user",
            );
          return {
            ...item,
            actorName: item.updatedBy
              ? names.get(item.updatedBy)
              : "Plugin update",
          };
        }),
      };
    }
    return result;
  };
}
module.exports = { createPluginSettings };
