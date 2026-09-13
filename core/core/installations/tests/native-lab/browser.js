"use strict";
// Real UI and real HTTP server in the VM. No route interception or fake API.
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const {
  chromium,
  expect,
} = require("../../../../dashboard/node_modules/@playwright/test");
async function main() {
  const baseURL = process.argv[2],
    output = process.argv[3];
  assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);
  const browser = await chromium.launch({ headless: true });
  const cases = [];
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const login = async (email) => {
      await page.goto("/");
      await page.getByLabel("Email address").fill(email);
      await page
        .getByLabel("Password", { exact: true })
        .fill("disposable lab password 123");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("navigation", { name: "Primary navigation" }),
      ).toBeVisible();
    };
    await login("platform@example.test");
    await expect(
      page.getByRole("button", { name: "Lab DSP 0 L0", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Lab DSP 1 L1", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create new DSP", exact: true })
      .click();
    await page
      .getByLabel("Owner email", { exact: true })
      .fill("after-restore@example.test");
    await page
      .getByRole("button", { name: "Create DSP & send invite", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("tab", { name: "Onboarding", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "after-restore@example.test Awaiting DSP details",
        exact: true,
      }),
    ).toBeVisible();
    cases.push({
      name: "browser creates a DSP invitation against restored dashboard",
      status: "passed",
    });
    await page
      .locator(".desktop-sidebar")
      .getByRole("link", { name: "Backups", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Backups", exact: true }),
    ).toBeVisible();
    cases.push({
      name: "browser opens restored backup catalog",
      status: "passed",
    });
    await context.clearCookies();
    await login("owner1@example.test");
    await page
      .locator(".desktop-sidebar")
      .getByRole("link", { name: "Team & Roles", exact: true })
      .click();
    await page.getByRole("tab", { name: "Roles", exact: true }).click();
    await expect(page.locator('.role-row h2')).toHaveText(['Owner', 'Manager', 'Dispatcher', 'Driver']);
    await expect(page.getByRole('button', { name: 'Create role', exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Invite member", exact: true })
      .click();
    await page.getByLabel("Email address").fill("reviewer@example.test");
    await page
      .getByLabel("Role", { exact: true })
      .selectOption({ label: "Dispatcher" });
    await page
      .getByRole("button", { name: "Send invitation", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("tab", { name: /^Invitations/ }).click();
    await expect(
      page.getByRole("cell", { name: "reviewer@example.test", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Revoke invitation for reviewer@example.test",
      })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke invitation", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "reviewer@example.test", exact: true }),
    ).toHaveCount(0);
    cases.push({
      name: "browser creates a DSP role and invites and revokes a member",
      status: "passed",
    });
    assert.deepEqual(errors, []);
    cases.push({
      name: "real dashboard browser session has no uncaught JavaScript errors",
      status: "passed",
    });
    fs.writeFileSync(
      output,
      JSON.stringify({ status: "passed", cases }, null, 2),
    );
  } catch (e) {
    fs.writeFileSync(
      output,
      JSON.stringify({ status: "failed", cases, error: e.message }, null, 2),
    );
    throw e;
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
