# Signed-out landing verification

## Scope

Only the signed-out shell and its scoped styles changed. Login navigation helpers,
other access states, protected pages, and the backend were left unchanged.

## Evidence

Before/after captures are saved in `screenshots/signed-out/` at the workspace root:

- `before-desktop.jpg` and `after-desktop.jpg`: 1440 × 900.
- `before-mobile.jpg` and `after-mobile.jpg`: 390 × 844.

The screenshots contain only public signed-out content, not financial examples or
user identities.

The architectural artwork was subsequently replaced at the user's request with
Comcast's official corporate logo, downloaded unchanged from the image linked on
the Comcast corporate homepage:
https://corporate.comcast.com/media/img/original/2024/03/corporate_NewComcastLogo_16x9.png

The local `public/comcast-logo.png` retains the source aspect ratio and colors.
It is displayed with `object-contain`, never cropped or stretched. The original
before/after captures above document the first redesign; `comcast-desktop.jpg`
and `comcast-mobile.jpg` in the same screenshot directory show this revision.

## Checks

- Frontend typecheck and production build passed. The build reports existing
  sourcemap-location warnings in unrelated UI components.
- All 9 focused auth-shell unit tests passed, including the loading, denied,
  invalid-preview and authorized branches. The frontend suite also passed
  (314 tests) before the final layout refinement.
- All 8 focused browser scenarios passed. A fixture initially reinserted the
  logout latch on the login destination; after limiting fixture setup to the
  starting page, the affected keyboard-login scenario passed on its focused rerun.
- At 1440 × 900 and 1024 × 768: headline fits two lines, login fits without
  scrolling, and no horizontal overflow.
- At 390 × 844 and 320 × 640: content and login precede the image, login fits
  without scrolling, and no horizontal overflow.
- At 320 × 400 with 200% root text size: natural scrolling, no horizontal
  overflow, and login remains reachable.
- Keyboard focus and Enter activation, image-load failure, reduced motion,
  unavailable-state reconnect, and absence of protected API requests passed.
- Normal login contrast is approximately 4.93:1; muted text is 5.74:1 on white.
  Hover and pressed button states use darker blue to maintain white-text contrast.

Run the focused checks with:

```sh
pnpm --filter @workspace/budget-monitor exec vitest run src/components/auth-gate.test.tsx
pnpm --filter @workspace/budget-monitor run typecheck
pnpm --filter @workspace/budget-monitor exec playwright test e2e/signed-out-landing.spec.ts
```

Where Playwright's bundled browser is unavailable, set `CHROMIUM_PATH` to an
installed Chromium executable. The existing Playwright configuration builds and
serves the production frontend for these tests.

## Navigation verification boundary

The browser tests preserve the actual sign-in click handler and verify same-tab
standalone navigation, encoded path/query return targets, and explicit logout
latch clearing. The embedded test verifies top-level navigation from a simulated
sandboxed iframe that permits user-activated top navigation.

Only the destination response is intercepted. These tests do **not** establish
the actual Replit editor sandbox policy, provider entry, or completed OAuth
authentication. No credentials, identities, backend settings, or permissions
were changed to perform this verification.

The broader route-suite repairs remain outside this focused check.