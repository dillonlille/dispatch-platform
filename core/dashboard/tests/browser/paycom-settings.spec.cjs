const { test, expect } = require("@playwright/test");
const path = require("node:path");
test.skip(
  process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE !== "1",
  "Requires the isolated workforce preview",
);
async function login(page, email = "owner@example.test") {
  await page.route("**/api/organization/paycom-setup", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          status: "succeeded",
          workforceAvailable: true,
          canSubmit: false,
          canRetry: false,
          failureCode: null,
        },
      },
    }),
  );
  await page.route("**/api/paycom/sync", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          activity: "idle",
          desiredState: "running",
          lastSucceededAt: "2026-09-11T08:00:00Z",
          nextDueAt: "2026-09-11T09:00:00Z",
          lastError: null,
          alerts: [],
        },
      },
    }),
  );
  await page.goto("/#/paycom?settings");
  await page.getByLabel("Email address").fill(email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic preview password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
}
test("owner settings save, filter Timecards, preserve the full directory, and leave another DSP unchanged", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Paycom settings", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Paycom · Dispatch");
  await page
    .getByRole("tab", { name: "Driver departments", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Include all current and future options" })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Driver 100", exact: true })
    .uncheck();
  await expect(
    page.getByRole("status").filter({ hasText: "6 employees" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  await page.reload();
  await page
    .getByRole("tab", { name: "Driver departments", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Driver 100", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Dispatch 6", exact: true }),
  ).toBeChecked();
  await page.getByRole("link", { name: "Back", exact: false }).click();
  const table = page.getByRole("table", { name: "Daily employee timecards" });
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await page.getByRole("tab", { name: "Employees", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Employee directory" }).locator("tbody tr"),
  ).toHaveCount(100);
  const other = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const sibling = await other.newPage();
  await login(sibling, "owner5@example.test");
  await sibling.goto("/#/plugins");
  await sibling
    .getByRole("button", { name: "Install Paycom", exact: true })
    .click();
  await expect(
    sibling.getByRole("link", { name: "Open Paycom", exact: true }),
  ).toBeVisible();
  await sibling.goto("/#/paycom?settings");
  await sibling
    .getByRole("tab", { name: "Driver departments", exact: true })
    .click();
  await expect(
    sibling.getByRole("checkbox", {
      name: "Include all current and future options",
    }),
  ).toBeChecked();
  await other.close();
  await page.goto("/#/paycom?settings");
  await page
    .getByRole("tab", { name: "Driver departments", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Dispatch 6", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back", exact: false }).click();
  await expect(
    page.getByText("No driver departments selected", { exact: true }),
  ).toBeVisible();
  // Restore shared fixture defaults for other browser specifications.
  await page.goto("/#/paycom?settings");
  await page
    .getByRole("button", { name: "Restore defaults", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore defaults", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
for (const mobile of [false, true])
  test(`settings layout and workspace preferences (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(page);
    await page
      .getByRole("tab", { name: "Workspace view", exact: true })
      .click();
    await page.getByLabel("Rows per page", { exact: true }).selectOption("25");
    await page
      .getByRole("checkbox", { name: "Lunch out", exact: true })
      .uncheck();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Settings saved", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(
        process.env.DISPATCH_UI_ARTIFACTS || "/tmp",
        `paycom-settings-${mobile ? "mobile" : "desktop"}.png`,
      ),
      fullPage: true,
    });
    await page.getByRole("link", { name: "Back", exact: false }).click();
    const table = page.getByRole("table", { name: "Daily employee timecards" });
    await expect(table.locator("tbody tr")).toHaveCount(25);
    await expect(
      table.getByRole("columnheader", { name: /Lunch out/ }),
    ).toHaveCount(0);
    await page.goto("/#/paycom?settings");
    await page
      .getByRole("button", { name: "Restore defaults", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Restore defaults", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Settings saved", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

test("an open Timecard page observes department changes from another session", async ({
  page,
}) => {
  await login(page);
  const snapshot = await (
    await page.request.get("/api/organization/plugins/paycom/settings")
  ).json();
  const session = await (await page.request.get("/api/auth/session")).json();
  await page.getByRole("link", { name: "Back", exact: false }).click();
  await expect(
    page
      .getByRole("table", { name: "Daily employee timecards" })
      .locator("tbody tr"),
  ).toHaveCount(100);
  const response = await page.request.post(
    "/api/organization/plugins/paycom/settings",
    {
      headers: {
        "x-dispatch-csrf": session.csrfToken || session.data?.csrfToken,
      },
      data: {
        values: { ...snapshot.data.values, driver_departments: [] },
        expectedRevision: snapshot.data.revision,
        definitionVersion: snapshot.data.definitionVersion,
        idempotencyKey: "browser:remote-departments",
      },
    },
  );
  expect(response.status()).toBe(200);
  await expect(
    page.getByText("No driver departments selected", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.goto("/#/paycom?settings");
  await page
    .getByRole("button", { name: "Restore defaults", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore defaults", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
});

for (const mobile of [false, true])
  test(`name order saves, sorts, refreshes and stays scoped to one DSP ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    browser,
  }) => {
    test.skip(
      process.env.DISPATCH_PAYCOM_NAME_ORDER_FIXTURE !== "1",
      "Requires canonical synthetic Paycom names",
    );
    test.setTimeout(45000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(page);
    await page
      .getByRole("tab", { name: "Workspace view", exact: true })
      .click();
    await expect(page.getByLabel("Name order", { exact: true })).toHaveValue(
      "first_last",
    );
    await expect(
      page.getByText("Name preview: JANE DOE", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Name order", { exact: true })
        .locator('option[value="first_last"]'),
    ).toHaveText("First Last");
    await page
      .getByLabel("Name order", { exact: true })
      .selectOption("last_first");
    await expect(
      page.getByText("Name preview: DOE, JANE", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Settings saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page
      .getByRole("tab", { name: "Workspace view", exact: true })
      .click();
    await expect(page.getByLabel("Name order", { exact: true })).toHaveValue(
      "last_first",
    );
    await expect(page.getByLabel("Rows per page", { exact: true })).toHaveValue(
      "100",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(
        process.env.DISPATCH_UI_ARTIFACTS || "/tmp",
        `name-order-${mobile ? "mobile" : "desktop"}.png`,
      ),
      fullPage: true,
    });
    await page.getByRole("link", { name: "Back", exact: false }).click();
    const timecards = page.getByRole("table", {
      name: "Daily employee timecards",
    });
    await expect(
      timecards.locator("tbody tr").first().locator("td").first(),
    ).toHaveText("AVERY, ZULU");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(timecards.locator("tbody tr")).toHaveCount(6);
    await expect(
      timecards.locator("tbody tr").last().locator("td").first(),
    ).toHaveText("THOMPSON, MIA");
    await page.getByRole("tab", { name: "Employees", exact: true }).click();
    await page
      .getByLabel("Find employee", { exact: true })
      .fill("THOMPSON, MIA");
    await page
      .getByRole("button", { name: "THOMPSON, MIA", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "THOMPSON, MIA", exact: true }),
    ).toBeVisible();
    const other = await browser.newContext({
      baseURL: new URL(page.url()).origin,
    });
    try {
      const sibling = await other.newPage();
      await login(sibling, "owner5@example.test");
      await sibling.goto("/#/plugins");
      const install = sibling.getByRole("button", {
        name: "Install Paycom",
        exact: true,
      });
      if (await install.count()) await install.click();
      await expect(
        sibling.getByRole("link", { name: "Open Paycom", exact: true }),
      ).toBeVisible();
      await sibling.goto("/#/paycom?settings");
      await sibling
        .getByRole("tab", { name: "Workspace view", exact: true })
        .click();
      await expect(
        sibling.getByLabel("Name order", { exact: true }),
      ).toHaveValue("first_last");
      await sibling.getByRole("link", { name: "Back", exact: false }).click();
      await expect(
        sibling
          .getByRole("table", { name: "Daily employee timecards" })
          .locator("tbody tr")
          .first()
          .locator("td")
          .first(),
      ).toHaveText("ETHAN RIVERA");
    } finally {
      await other.close();
    }
    await page.getByRole("tab", { name: "Timecard", exact: true }).click();
    await expect(
      timecards.locator("tbody tr").first().locator("td").first(),
    ).toHaveText("AVERY, ZULU");
    const snapshot = (
      await (
        await page.request.get("/api/organization/plugins/paycom/settings")
      ).json()
    ).data;
    const session = (await (await page.request.get("/api/auth/session")).json())
      .data;
    const response = await page.request.post(
      "/api/organization/plugins/paycom/settings",
      {
        headers: { "x-dispatch-csrf": session.csrfToken },
        data: {
          values: { ...snapshot.values, name_order: "first_last" },
          expectedRevision: snapshot.revision,
          definitionVersion: snapshot.definitionVersion,
          idempotencyKey: `browser:remote-name-${mobile}`,
        },
      },
    );
    expect(response.status()).toBe(200);
    await expect(
      timecards.locator("tbody tr").first().locator("td").first(),
    ).toHaveText("ETHAN RIVERA", { timeout: 20000 });
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(timecards.locator("tbody tr")).toHaveCount(6);
    await expect(
      timecards.locator("tbody tr").last().locator("td").first(),
    ).toHaveText("ZULU AVERY");
    await page.getByRole("tab", { name: "Employees", exact: true }).click();
    await page
      .getByLabel("Find employee", { exact: true })
      .fill("MIA THOMPSON");
    await page
      .getByRole("button", { name: "MIA THOMPSON", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "MIA THOMPSON", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

for (const mobile of [false, true])
  test(`smarter settings preserve intent, dependencies and restore drafts (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    test.skip(
      process.env.DISPATCH_SMART_SETTINGS_FIXTURE !== "1",
      "Requires the smarter settings scenario",
    );
    test.setTimeout(60000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await login(page);
    const save = async () => {
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(
        page.getByText("Settings saved", { exact: true }),
      ).toBeVisible();
    };
    await page
      .getByRole("button", { name: "Restore defaults", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Restore defaults", exact: true })
      .click();
    if (
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .isEnabled()
    )
      await save();
    const startingRevision = (
      await (
        await page.request.get("/api/organization/plugins/paycom/settings")
      ).json()
    ).data.revision;
    await page
      .getByRole("tab", { name: "Workspace view", exact: true })
      .click();
    await expect(
      page.getByText("Name preview: JANE DOE", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Keep current value for Name order",
        exact: true,
      })
      .click();
    await save();
    await expect(
      page.getByRole("button", {
        name: "Use plugin default for Name order",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Sync schedule", exact: true }).click();
    await page.getByLabel("Sync every", { exact: true }).selectOption("7200");
    await page
      .getByRole("switch", { name: "Automatic sync", exact: true })
      .uncheck();
    await expect(page.getByLabel("Sync every", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Sync every", { exact: true })).toHaveValue(
      "7200",
    );
    await save();
    await expect(
      page.getByText(
        "The schedule is updated after saving. Running collections are allowed to finish.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Automatic sync", exact: true }),
    ).not.toBeChecked();
    await expect(page.getByLabel("Sync every", { exact: true })).toHaveValue(
      "7200",
    );
    await page
      .getByRole("button", {
        name: "Restore Sync schedule defaults",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("switch", { name: "Automatic sync", exact: true }),
    ).toBeChecked();
    await expect(page.getByLabel("Sync every", { exact: true })).toHaveValue(
      "3600",
    );
    await save();
    await page
      .getByRole("tab", { name: "Workspace view", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Use plugin default for Name order",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Change history", exact: true })
      .click();
    const history = page.getByRole("region", {
      name: "Settings change history",
    });
    const initial = history.locator(
      `:scope > details[data-revision="${startingRevision}"]`,
    );
    await expect(initial).toBeVisible();
    await initial.locator(":scope > summary").click();
    await initial
      .getByText("Restore an individual setting", { exact: true })
      .click();
    await initial
      .getByRole("button", { name: "Restore Name order", exact: true })
      .click();
    await expect(
      page.getByText(
        "Restored into your draft. Review your changes before saving.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Keep current value for Name order",
        exact: true,
      }),
    ).toBeVisible();
    await save();
    await page
      .getByRole("button", { name: "Change history", exact: true })
      .click();
    await page
      .getByLabel("Default department", { exact: true })
      .selectOption({ label: "Driver" });
    await page
      .getByRole("tab", { name: "Driver departments", exact: true })
      .click();
    const all = page.getByRole("checkbox", {
      name: "Include all current and future options",
    });
    await expect(
      page.getByRole("checkbox", { name: "Driver 100", exact: true }),
    ).toBeDisabled();
    await all.uncheck();
    await page
      .getByRole("checkbox", { name: "Driver 100", exact: true })
      .uncheck();
    await expect(
      page.getByText(
        "Your default department is excluded from Timecards. Choose an included department or update Driver departments.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "6 employees" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(
      page.getByRole("checkbox", {
        name: "Include all current and future options",
      }),
    ).toBeChecked();
    await expect(
      page.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("tab", { name: "Workspace view", exact: true })
      .click();
    await page.screenshot({
      path: path.join(
        process.env.DISPATCH_UI_ARTIFACTS || "/tmp",
        `smarter-settings-${mobile ? "mobile" : "desktop"}.png`,
      ),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
