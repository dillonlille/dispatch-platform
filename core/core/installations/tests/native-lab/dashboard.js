"use strict";
// Test-only email boundary: no message can leave this VM.
const fs = require("node:fs");
require("../../../../dashboard/server/main")
  .main(["--installation-operator", "--operator"], {
    invitationDelivery: {
      send: async (invitation) => {
        fs.appendFileSync(
          process.env.DISPATCH_LOCAL_ROOT + "/inbox.jsonl",
          JSON.stringify(invitation) + "\n",
          { mode: 0o600 },
        );
        return { status: "accepted" };
      },
    },
  })
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  });
