const { test, expect } = require("@playwright/test");

async function fixture(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Email address").fill("platform@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic preview password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".desktop-sidebar").waitFor();
  const data = (await (await page.request.get("/api/platform/backups")).json())
    .data;
  data.operations = [];
  data.settings.enabled = false;
  data.schedules.forEach((s) => {
    s.settings.enabled = false;
  });
  const org = data.organizations[0];
  const backup = data.backups.find((b) => b.organizationId === org.id);
  backup.category = "manual";
  backup.trigger = "manual";
  data.sets = [
    {
      id: "streamlined-set",
      createdAt: backup.createdAt,
      status: "verified",
      members: [
        { organizationId: org.id, backupId: backup.id, status: "verified" },
        {
          organizationId: null,
          backupId: "fixture_core_backup",
          status: "verified",
        },
      ],
    },
  ];
  const inputs = [];
  await page.route("**/api/platform/backups", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      inputs.push(input);
      if (input.action === "settings") {
        const policy = data.schedules.find(
          (s) => s.scope === (input.scope || input.organizationId),
        );
        policy.settings = input.settings;
        policy.revision++;
        if (policy.scope === "system") {
          data.settings = input.settings;
          data.revision = policy.revision;
        }
      }
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  return { data, inputs, org, errors };
}
const nav = (page) =>
  page.getByRole("navigation", { name: "Backup navigation" });

test("minimal overview, DSP selection, history filters and recovery links retain their scope", async ({
  page,
}) => {
  const { data, org, errors } = await fixture(page);
  await page.goto("/#/backups");
  await expect(
    page.locator(".backup-header .backup-button-primary"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Latest full-system backup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent activity" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "View details", exact: true }).click();
  await expect(page).toHaveURL(/\/sets\/streamlined-set$/);
  await expect(
    page.getByRole("heading", { name: "Full-system backup", exact: true }),
  ).toBeVisible();
  await nav(page).getByRole("link", { name: "DSPs", exact: true }).click();
  await page
    .getByLabel("DSP", { exact: true })
    .selectOption(data.organizations[1].id);
  await expect(page).toHaveURL(new RegExp(data.organizations[1].id + "$"));
  await expect(
    page.getByRole("heading", {
      name: data.organizations[1].name,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back up DSP", exact: true }).click();
  await expect(page.locator("#backup-select-all")).not.toBeChecked();
  await expect(page.locator("dialog input[data-org]:checked")).toHaveCount(1);
  await expect(page.locator("dialog input[data-org]:checked")).toHaveAttribute(
    "data-org",
    data.organizations[1].id,
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("DSP", { exact: true }).selectOption(org.id);
  await page
    .getByRole("searchbox", { name: "Search backups" })
    .fill("not a backup");
  await expect(page.getByText("No backups available")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search backups" }).fill("");
  await expect(page.locator(".backup-table tbody tr")).toHaveCount(1);
  await nav(page).getByRole("link", { name: "History", exact: true }).click();
  await page.getByLabel("Scope", { exact: true }).selectOption("system");
  await expect(page.locator(".backup-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".backup-table tbody tr")).toContainText(
    "Full system",
  );
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.locator("#backup-history-filters")).toBeHidden();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByLabel("Scope", { exact: true }).selectOption(org.id);
  await page.getByLabel("Category", { exact: true }).selectOption("manual");
  await expect(page.locator(".backup-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".backup-table tbody tr")).toContainText(org.name);
  await page.getByRole("button", { name: "Restores", exact: true }).click();
  await expect(page.getByText("No activity found")).toBeVisible();
  expect(errors).toEqual([]);
});

test("schedule edits preserve drafts and scope, with a single header save action", async ({
  page,
}) => {
  const { data, org, inputs, errors } = await fixture(page);
  await page.goto("/#/backups/dsps/" + org.id);
  await page.getByRole("button", { name: "Edit schedule" }).click();
  await expect(page.getByLabel("Schedule for")).toHaveValue(org.id);
  await expect(page.getByLabel("Frequency", { exact: true })).toBeDisabled();
  await page.getByLabel("Automatic backups", { exact: true }).check();
  await page.getByLabel("Frequency", { exact: true }).selectOption("weekly");
  await page.getByLabel("Day", { exact: true }).selectOption("2");
  await page.getByLabel("Time", { exact: true }).fill("03:45");
  await page.getByLabel("Keep backups", { exact: true }).selectOption("90");
  await page.getByLabel("Automatic backups", { exact: true }).uncheck();
  await page.getByLabel("Automatic backups", { exact: true }).check();
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue("03:45");
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByText("Backup settings saved.", { exact: true }),
  ).toBeVisible();
  expect(inputs.at(-1)).toMatchObject({
    action: "settings",
    organizationId: org.id,
    settings: {
      enabled: true,
      frequency: "weekly",
      weekday: 2,
      time: "03:45",
      retentionDays: 90,
    },
  });
  expect(
    data.schedules.find((s) => s.scope === "system").settings.enabled,
  ).toBe(false);
  await page.getByLabel("Schedule for").selectOption("core");
  await expect(
    page.getByLabel("Automatic backups", { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("Automatic backups", { exact: true }).check();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".backup-header")
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(
    page.getByLabel("Automatic backups", { exact: true }),
  ).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("system restore confirmation tracks polling, and failed or busy recovery stays guarded", async ({
  page,
}) => {
  const { data, inputs, errors } = await fixture(page);
  await page.goto("/#/backups/sets/streamlined-set");
  await page
    .getByRole("button", { name: "Restore full system", exact: true })
    .click();
  const confirm = page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore full system", exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type Full system to confirm").fill("wrong");
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type Full system to confirm").fill("Full system");
  await expect(confirm).toBeEnabled();
  data.sets[0].busy = true;
  await expect(confirm).toBeDisabled({ timeout: 10000 });
  await expect(page.getByRole("dialog")).toContainText("no longer available");
  expect(inputs).toHaveLength(0);
  await page.keyboard.press("Escape");
  data.sets[0].busy = false;
  data.sets[0].status = "incomplete";
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Restore full system", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("all six surfaces fit mobile, retain visible data and disclose storage details", async ({
  page,
}) => {
  const { errors } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    "",
    "/dsps",
    "/history",
    "/storage",
    "/core",
    "/settings",
  ]) {
    await page.goto("/#/backups" + path);
    await expect(page.locator(".backup-split")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const cell of await page.locator(".backup-table tbody td").all()) {
      const box = await cell.boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(391);
    }
  }
  await page.goto("/#/backups/storage");
  await page.locator("#backup-storage-retained > summary").click();
  await expect(
    page.getByRole("region", { name: "Removed DSPs — retained backups" }),
  ).toContainText("Pine Delivery");
  await page.locator("#backup-storage-additional > summary").click();
  await expect(
    page.getByText("Backup archives", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
