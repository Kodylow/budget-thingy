import { expect, test, type Page } from '@playwright/test';

// Optional system browser for environments without Playwright's bundled browser.
test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

async function signedOut(page: Page, status = 401) {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    return route.fulfill({ status: path === '/api/auth/user' ? status : 200, json: {} });
  });
  return requests;
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`signed-out content and login fit ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = await signedOut(page);
    await page.goto('/spend?tab=members');
    const login = page.getByTestId('button-login');
    await expect(login).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await noHorizontalOverflow(page);
    const loginBox = (await login.boundingBox())!;
    expect(loginBox.y + loginBox.height).toBeLessThanOrEqual(viewport.height);
    expect(loginBox.height).toBeGreaterThanOrEqual(44);
    const headline = page.getByRole('heading', { level: 1 });
    await expect(headline).toHaveText('Your Replit spend. In clear view.');
    if (viewport.width >= 1024) {
      const lines = await headline.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
      expect(lines).toBeLessThanOrEqual(2.1);
    } else {
      const art = page.locator('img[src$="comcast-logo.png"]');
      expect((await art.boundingBox())!.y).toBeGreaterThan(loginBox.y + loginBox.height);
    }
    await expect(page.getByTestId('button-reconnect')).toHaveCount(0);
    expect(requests.every(path => path === '/api/auth/user')).toBe(true);
  });
}

test('keyboard sign-in retains path/query, clears explicit logout, and stays in this tab', async ({ page, context }) => {
  await signedOut(page);
  await page.addInitScript(() => {
    if (location.pathname === '/spend') {
      localStorage.setItem(`budget-monitor:auth-signed-out:${location.origin}`, '1');
    }
  });
  await page.goto('/spend?tab=members&search=team%20one');
  const login = page.getByTestId('button-login');
  await expect(login).toHaveAttribute('href', '/api/login?returnTo=%2Fspend%3Ftab%3Dmembers%26search%3Dteam%2520one');
  await expect(login).toHaveAttribute('target', '_self');
  await page.keyboard.press('Tab');
  await expect(login).toBeFocused();
  const focus = await login.evaluate(el => {
    const style = getComputedStyle(el);
    return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
  });
  expect(focus).toBe(true);
  // Intercept only the destination, not the real click handler or navigation.
  await page.route('**/api/login?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Login destination</h1>' }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/api\/login\?returnTo=/);
  expect(context.pages()).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem(`budget-monitor:auth-signed-out:${location.origin}`))).toBeNull();
});

test('embedded sign-in navigates the top-level tab on explicit click', async ({ page, context }) => {
  await signedOut(page);
  await page.route('**/landing-frame', route => route.fulfill({
    contentType: 'text/html',
    body: '<iframe title="App preview" sandbox="allow-scripts allow-same-origin allow-top-navigation-by-user-activation" src="/spend?tab=members"></iframe>',
  }));
  await page.goto('/landing-frame');
  const login = page.frameLocator('iframe').getByTestId('button-login');
  await expect(login).toHaveAttribute('target', '_top');
  await page.route('**/api/login?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Login destination</h1>' }));
  await login.click();
  await expect(page).toHaveURL(/\/api\/login\?returnTo=%2Fspend%3Ftab%3Dmembers/);
  expect(context.pages()).toHaveLength(1);
});

test('unavailable access offers a working reconnect without protected requests', async ({ page }) => {
  const requests = await signedOut(page, 503);
  await page.goto('/');
  const reconnect = page.getByTestId('button-reconnect');
  await expect(reconnect).toBeVisible();
  const before = requests.length;
  await reconnect.click();
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  await expect(reconnect).toBeVisible();
  expect(requests.every(path => path === '/api/auth/user')).toBe(true);
});

test('image failure, enlarged text, short viewport and reduced motion stay usable', async ({ page }) => {
  await signedOut(page);
  await page.route('**/comcast-logo.png', route => route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 400 });
  await page.goto('/');
  const login = page.getByTestId('button-login');
  await expect(login).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await noHorizontalOverflow(page);
  await login.scrollIntoViewIfNeeded();
  await expect(login).toBeInViewport();
  const image = page.locator('img[src$="comcast-logo.png"]');
  await expect(image).toBeHidden();
  const duration = await login.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThanOrEqual(0.001);
});