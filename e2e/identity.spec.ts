import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Who the server thinks you are.
 *
 * Identity here is two httpOnly cookies scoped per room code — one for the host,
 * one for the player. A browser context is a cookie jar, so each context in
 * these tests is a separate person, and two pages in ONE context are two tabs
 * belonging to the same person. That distinction is the whole subject of this
 * file, and it is why these tests cannot be unit tests.
 */

/** Create a room and return its code. The context that does this is the host. */
async function createRoom(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /create a room/i }).click();
  await page.waitForURL(/\/admin\/[A-Z0-9]+/, { timeout: 30_000 });
  const code = new URL(page.url()).pathname.split("/").pop()!;
  expect(code, "room code should be in the dashboard URL").toMatch(/^[A-Z0-9]{6}$/);
  return code;
}

/** Join a room as a player, from whatever context this page belongs to. */
async function join(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/join/${code}`);
  await page.getByLabel(/your name/i).fill(name);
  await page.getByRole("button", { name: /board the ship/i }).click();
  await page.waitForURL(new RegExp(`/play/${code}`), { timeout: 30_000 });
}

/** What the server reports this context to be, straight from the state API. */
async function viewer(
  context: BrowserContext,
  code: string,
): Promise<{ viewerRole: string; selfName: string | null }> {
  const response = await context.request.get(`/api/rooms/${code}/state`);
  expect(response.ok(), "state endpoint should answer").toBeTruthy();
  const body = (await response.json()) as {
    viewerRole: string;
    self: { displayName: string } | null;
  };
  return { viewerRole: body.viewerRole, selfName: body.self?.displayName ?? null };
}

test.describe("identity", () => {
  test("a host who also joins can play in their own room", async ({ browser }) => {
    // The bug this guards: `resolveViewer` matched the host cookie and returned
    // immediately, never looking at the player cookie. `self` is only built for
    // a player, so a facilitator who joined their own room got `self: null` —
    // and /play renders "You haven't joined this room yet" whenever self is
    // null. Joining redirected back to /play, which still had no self, so the
    // join screen reappeared forever.
    const context = await browser.newContext();
    const page = await context.newPage();

    const code = await createRoom(page);
    await join(page, code, "Facilitator");

    const state = await viewer(context, code);

    // Host privileges are deliberately kept — that is what the dashboard needs.
    expect(state.viewerRole, "hosting must still win for privileges").toBe("host");
    // ...but identity must survive alongside them.
    expect(state.selfName, "a host who joined must have a self").toBe("Facilitator");

    // And the phone must show the game rather than the join prompt.
    await page.goto(`/play/${code}`);
    await expect(page.getByText(/you haven't joined this room yet/i)).toHaveCount(0);
    await expect(page.getByText("Facilitator")).toBeVisible();

    await context.close();
  });

  test("two tabs in one browser are the same player, not two", async ({ browser }) => {
    // Not a bug — the anti-ghost rule. A phone that locked, or a tab closed and
    // reopened, must land back on the same player rather than creating a ghost
    // who holds a symbol nobody is carrying.
    const host = await browser.newContext();
    const code = await createRoom(await host.newPage());

    const player = await browser.newContext();
    const tabOne = await player.newPage();
    await join(tabOne, code, "Sam");

    const tabTwo = await player.newPage();
    await tabTwo.goto(`/join/${code}`);
    const rejoin = await player.request.post(`/api/rooms/${code}/join`, {
      data: { displayName: "Someone Else" },
    });
    expect((await rejoin.json()).rejoined, "second tab must reuse the same player").toBe(true);

    const state = await viewer(player, code);
    expect(state.selfName, "still the original player").toBe("Sam");

    await host.close();
    await player.close();
  });

  test("separate browser contexts are separate players", async ({ browser }) => {
    // The supported way to test locally: one private window per player.
    const host = await browser.newContext();
    const code = await createRoom(await host.newPage());

    const one = await browser.newContext();
    const two = await browser.newContext();
    await join(await one.newPage(), code, "Ada");
    await join(await two.newPage(), code, "Bo");

    expect((await viewer(one, code)).selfName).toBe("Ada");
    expect((await viewer(two, code)).selfName).toBe("Bo");

    await host.close();
    await one.close();
    await two.close();
  });
});
