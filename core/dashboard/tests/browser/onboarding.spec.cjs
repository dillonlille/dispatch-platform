const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
const password = "synthetic preview password";

async function ownerInvitation(playwright, baseURL, email) {
  const admin = await playwright.request.newContext({ baseURL });
  try {
    const login = await admin.post("/api/auth/login", {
      data: { email: "platform@example.test", password },
    });
    expect(login.ok()).toBeTruthy();
    const session = (await login.json()).data;
    const created = await admin.post("/api/platform/organizations", {
      headers: { "X-Dispatch-CSRF": session.csrfToken, Origin: baseURL },
      data: {
        ownerEmail: email,
        idempotencyKey: `browser:onboarding:${randomUUID()}`,
      },
    });
    expect(created.status()).toBe(201);
    return (await created.json()).data.invitationPath;
  } finally {
    await admin.dispose();
  }
}

async function existingOwner(playwright, baseURL) {
  const email = `existing-${randomUUID()}@example.test`;
  const link = await ownerInvitation(playwright, baseURL, email);
  const client = await playwright.request.newContext({ baseURL });
  try {
    const registration = await client.post("/api/auth/register", {
      data: {
        token: link.split("/").at(-1),
        firstName: "Existing",
        lastName: "Owner",
        password,
        confirmPassword: password,
      },
    });
    expect(registration.status()).toBe(201);
  } finally {
    await client.dispose();
  }
  return email;
}

async function saveDetails(page) {
  await expect(page).toHaveURL(/#\/onboarding$/);
  await expect(page).toHaveTitle("Set up your DSP · Dispatch");
  await expect(
    page.getByRole("heading", { name: "Set up your DSP" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to workspace" }),
  ).toHaveCount(0);
  await page
    .getByLabel("DSP name", { exact: true })
    .fill("Onboarding Logistics");
  await page.getByLabel("Abbreviation (optional)").fill("OL");
  await page.getByLabel("Station code").fill("TST4");
  await page.getByLabel("Business timezone").fill("America/Chicago");
  await page.getByRole("button", { name: "Save DSP details" }).click();
  await expect(
    page.getByText("Your DSP details are saved.", { exact: false }),
  ).toBeVisible();
  const profile = (
    await (await page.request.get("/api/organization/profile")).json()
  ).data;
  expect(profile.details).toEqual({
    name: "Onboarding Logistics",
    abbreviation: "OL",
    stationCode: "TST4",
    timezone: "America/Chicago",
  });
  await page.reload();
  await expect(
    page.getByText("Your DSP details are saved.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: /^(Settings|DSPs)$/ }),
  ).toBeVisible();
}

for (const mobile of [false, true]) {
  test(`new DSP owner creates account then saves DSP details (${mobile ? "mobile" : "desktop"})`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const link = await ownerInvitation(
      playwright,
      baseURL,
      `new-${randomUUID()}@example.test`,
    );
    await page.goto(link);
    await expect(
      page.getByRole("heading", { name: "Create your DSP" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveCount(0);
    await page.getByLabel("First name").fill("New");
    await page.getByLabel("Last name").fill("Owner");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password", { exact: true }).fill(password);
    await page.screenshot({
      path: `/tmp/dispatch-onboarding-account-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Create account and continue" })
      .click();
    await expect(page.getByLabel("DSP name", { exact: true })).toBeVisible();
    await page.screenshot({
      path: `/tmp/dispatch-onboarding-details-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await saveDetails(page);
    expect(errors).toEqual([]);
    await page.goto(link);
    await expect(
      page.getByText(
        "This invitation is invalid, expired, revoked, or already used.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("First name")).toHaveCount(0);
  });
}

for (const account of ["DSP owner", "platform owner"]) {
  test(`existing account can join a DSP only when it has no DSP membership: ${account}`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    const email =
      account === "platform owner"
        ? "platform@example.test"
        : await existingOwner(playwright, baseURL);
    const probe = await playwright.request.newContext({ baseURL });
    const initial = await probe.post('/api/auth/login', { data: { email, password } });
    const membershipCount = (await initial.json()).data.memberships.length;
    await probe.dispose();
    const link = await ownerInvitation(playwright, baseURL, email);
    await page.goto(link);
    await expect(
      page.getByText("You already have a Dispatch account.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveValue("");
    await expect(page.getByLabel("First name")).toHaveCount(0);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in and continue" }).click();
    if (membershipCount === 0) await saveDetails(page);
    else {
      await expect(page.getByText('This user already belongs to another DSP.')).toBeVisible();
      await expect(page).toHaveURL(new URL(link, baseURL).href);
      expect((await (await page.request.get('/api/auth/session')).json()).data.memberships).toHaveLength(membershipCount);
    }
  });
}

test("wrong account cannot accept; switching accounts preserves the invitation", async ({
  page,
  playwright,
  baseURL,
}) => {
  const email = await existingOwner(playwright, baseURL);
  const link = await ownerInvitation(playwright, baseURL, email);
  await page.goto(link);
  await page.getByLabel("Email address").fill("platform@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in and continue" }).click();
  await expect(
    page.getByText(
      "Sign in with the exact email address named by this invitation.",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(new URL(link, baseURL).href);
  await page.getByRole("button", { name: "Use another account" }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in and continue" }).click();
  await expect(page.getByText('This user already belongs to another DSP.')).toBeVisible();
  await expect(page).toHaveURL(new URL(link, baseURL).href);
});

test("signed-in owner cannot add a second DSP membership", async ({
  page,
  playwright,
  baseURL,
}) => {
  const email = await existingOwner(playwright, baseURL);
  const link = await ownerInvitation(playwright, baseURL, email);
  await page.request.post("/api/auth/login", { data: { email, password } });
  await page.goto(link);
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  await page.getByRole("button", { name: "Continue to DSP setup" }).click();
  await expect(page.getByText('This user already belongs to another DSP.')).toBeVisible();
  await expect(page).toHaveURL(new URL(link, baseURL).href);
});

test("password confirmation errors keep new owners in account creation", async ({
  page,
  playwright,
  baseURL,
}) => {
  const link = await ownerInvitation(
    playwright,
    baseURL,
    `confirmation-${randomUUID()}@example.test`,
  );
  await page.goto(link);
  await page.getByLabel("First name").fill("New");
  await page.getByLabel("Last name").fill("Owner");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("a different password");
  await page
    .getByRole("button", { name: "Create account and continue" })
    .click();
  await expect(
    page.getByText("The password confirmation does not match."),
  ).toBeVisible();
  await expect(page).toHaveURL(new URL(link, baseURL).href);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create account and continue" })
    .click();
  await expect(page.getByLabel("DSP name", { exact: true })).toBeVisible();
});
