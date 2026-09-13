"use strict";
const fs = require("node:fs");
const {
  AccessStore,
  AccessControlService,
} = require("../../../accounts/src");
const root = process.env.DISPATCH_LOCAL_ROOT;
(async () => {
  const store = new AccessStore({
    databaseRoot: root + "/data/access-control",
    database: root + "/data/access-control/access-control.sqlite3",
  });
  const access = new AccessControlService(store, {
    installationOperatorEnabled: true,
    installationBackend: "native_service_v1",
  });
  const invite = access.createPlatformBootstrap({
    email: "platform@example.test",
  });
  await access.acceptNewUser({
    token: invite.token,
    firstName: "Lab",
    lastName: "Platform",
    password: "disposable lab password 123",
    confirmPassword: "disposable lab password 123",
  });
  store.close();
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
