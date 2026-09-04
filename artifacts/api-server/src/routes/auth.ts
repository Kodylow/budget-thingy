import {
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  GetCurrentAuthUserResponse,
  LogoutMobileSessionResponse,
} from '@workspace/api-zod';
import { db, usersTable } from '@workspace/db';
import { Router, type IRouter, type Request, type Response } from 'express';
import * as oidc from 'openid-client';

import {
  clearSession,
  createSession,
  deleteSession,
  getOidcConfig,
  getRequestOrigin,
  getSessionId,
  ISSUER_URL,
  setSessionCookie,
  type SessionData,
} from '../lib/auth';
import {
  BOOTSTRAP_ACCOUNT_ADMIN_EMAIL,
  isPersistedAppAdmin,
  asAuthorizationUnavailable,
  InvalidPreviewError,
  maybeBootstrapAppAdmin,
  normalizeEmail,
  resolveCurrentAuthorization,
  resolvePreviewAuthorization,
} from '../lib/authz';
import {
  getDirectory,
  getDirectoryFreshness,
  getDirectoryHydrationState,
} from '../lib/enterprise';

const OIDC_COOKIE_TTL = 10 * 60 * 1000;

const router: IRouter = Router();
function setOidcCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: OIDC_COOKIE_TTL,
  });
}

export function getSafeReturnTo(value: unknown, origin: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';

  try {
    const resolved = new URL(value, origin);
    if (resolved.origin !== origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorStatus(
  value: Record<string, unknown>,
): number | string | undefined {
  if (typeof value.status === 'number' || typeof value.status === 'string') {
    return value.status;
  }
  if (
    typeof value.statusCode === 'number' ||
    typeof value.statusCode === 'string'
  ) {
    return value.statusCode;
  }
  return undefined;
}

function getSafeErrorMetadata(error: unknown) {
  if (!isRecord(error)) {
    return { errorName: typeof error };
  }

  const errorStatus = getErrorStatus(error);
  const causeStatus = isRecord(error.cause)
    ? getErrorStatus(error.cause)
    : undefined;

  return {
    errorName: error instanceof Error ? error.name : 'Error',
    errorStatus: errorStatus ?? causeStatus,
  };
}

async function upsertUser(claims: Record<string, unknown>) {
  const userData = {
    id: claims.sub as string,
    email: (claims.email as string) || null,
    firstName: (claims.first_name as string) || null,
    lastName: (claims.last_name as string) || null,
    profileImageUrl: (claims.profile_image_url || claims.picture) as
      | string
      | null,
  };

  const [user] = await db
    .insert(usersTable)
    .values(userData)
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        ...userData,
        updatedAt: new Date(),
      },
    })
    .returning();
  return user;
}

router.get('/auth/user', async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.json(GetCurrentAuthUserResponse.parse({
      user: null,
      auth: null,
      capabilities: {
        canViewAccountUsage: false,
        canManageAccess: false,
        canEditAllocations: false,
        canManageNotifications: false,
        canManageSystem: false,
        canPreviewRoles: false,
        canWriteGroupLimits: false,
        canWriteUserLimitsIn: [],
        canRunChecks: false,
        canSendTestEmail: false,
      },
    }));
    return;
  }
  let realAuth;
  let auth;
  try {
    realAuth = await resolveCurrentAuthorization(req.user.id);
    auth = realAuth
      ? await resolvePreviewAuthorization(realAuth, req.header('X-Preview-As'))
      : null;
  } catch (err) {
    if (err instanceof InvalidPreviewError) {
      res.status(400).json({ error: err.message, previewInvalid: true });
      return;
    }
    const unavailable = asAuthorizationUnavailable(err, 'authorization');
    req.log.error(
      { errorName: unavailable.name, source: unavailable.source },
      'authorization lookup unavailable',
    );
    res.status(503).json({
      error: 'Authorization temporarily unavailable',
      retryable: true,
    });
    return;
  }
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.user,
      auth: auth
        ? {
            role: auth.role,
            roles: auth.roles,
            workspaceIds: auth.workspaceIds,
            teamNames: auth.teamNames,
            groupIds: auth.groupIds,
            userIds: auth.userIds,
            isPreview: auth.isPreview ?? false,
          }
        : null,
      capabilities: auth
        ? {
            ...auth.capabilities,
            canPreviewRoles: realAuth?.capabilities.canPreviewRoles === true,
          }
        : {
            canViewAccountUsage: false,
            canManageAccess: false,
            canEditAllocations: false,
            canManageNotifications: false,
            canManageSystem: false,
            canPreviewRoles: false,
            canWriteGroupLimits: false,
            canWriteUserLimitsIn: [],
            canRunChecks: false,
            canSendTestEmail: false,
          },
    }),
  );
});

router.get('/login', async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getRequestOrigin(req);
  const callbackUrl = `${origin}/api/callback`;

  const returnTo = getSafeReturnTo(req.query.returnTo, origin);

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login consent',
    state,
    nonce,
  });

  setOidcCookie(res, 'code_verifier', codeVerifier);
  setOidcCookie(res, 'nonce', nonce);
  setOidcCookie(res, 'state', state);
  setOidcCookie(res, 'return_to', returnTo);

  res.redirect(redirectTo.href);
});

// Query params are not validated because the OIDC provider may include
// parameters not expressed in the schema.
router.get('/callback', async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getRequestOrigin(req);
  const callbackUrl = `${origin}/api/callback`;

  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;

  if (!codeVerifier || !expectedState) {
    res.redirect('/api/login');
    return;
  }

  const currentUrl = new URL(
    `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
  );

  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch {
    res.redirect('/api/login');
    return;
  }

  const returnTo = getSafeReturnTo(req.cookies?.return_to, origin);

  res.clearCookie('code_verifier', { path: '/' });
  res.clearCookie('nonce', { path: '/' });
  res.clearCookie('state', { path: '/' });
  res.clearCookie('return_to', { path: '/' });

  const claims = tokens.claims();
  if (!claims) {
    res.redirect('/api/login');
    return;
  }

  const claimsRecord = claims as unknown as Record<string, unknown>;
  const dbUser = await upsertUser(claimsRecord);
  await maybeBootstrapAppAdmin(claimsRecord).catch((err) => {
    req.log.error({ err }, 'app admin bootstrap failed');
  });

  const sessionData: SessionData = {
    user: {
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      profileImageUrl: dbUser.profileImageUrl,
    },
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);
  res.redirect(returnTo);
});

/**
 * GET /api/auth/me/debug
 *
 * Returns the caller's raw Enterprise directory entry, resolved admin flags,
 * workspace roles, editor-allowlist status, and overall authz result.
 *
 * Requires a valid session but intentionally bypasses the `requireAuth` gate
 * so blocked admins can self-diagnose without developer log access. Only
 * describes the caller — never exposes other users' data.
 */
router.get('/auth/me/debug', async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const userId = req.user.id;

  const capture = async <T,>(lookup: () => Promise<T>) => {
    try {
      return { status: 'success' as const, value: await lookup() };
    } catch (error) {
      return {
        status: 'failed' as const,
        error: getSafeErrorMetadata(error),
      };
    }
  };
  const [directoryResult, appAdminResult, authzResult] = await Promise.all([
    capture(() => getDirectory()),
    capture(() => isPersistedAppAdmin(userId)),
    capture(() => resolveCurrentAuthorization(userId)),
  ]);

  const member = directoryResult.status === 'success'
    ? directoryResult.value.members.get(userId) ?? null
    : null;

  res.json({
    userId,
    hydration: {
      ...getDirectoryHydrationState(),
      ...getDirectoryFreshness(),
    },
    directory: directoryResult.status === 'failed'
      ? directoryResult
      : {
          status: member ? 'success' : 'missing',
          isAccountAdmin: member?.isAccountAdmin ?? false,
          workspaces: member
            ? [...member.workspaces.entries()].map(([workspaceId, ws]) => ({
                workspaceId,
                role: ws.role,
                isDisabled: ws.isDisabled,
              }))
            : [],
        },
    appAdmin: appAdminResult.status === 'failed'
      ? appAdminResult
      : {
          status: appAdminResult.value ? 'success' : 'missing',
          active: appAdminResult.value,
        },
    authorization: authzResult.status === 'failed'
      ? authzResult
      : {
          status: authzResult.value ? 'success' : 'missing',
          role: authzResult.value?.role ?? null,
          roles: authzResult.value?.roles ?? [],
        },
    bootstrap: appAdminResult.status === 'failed'
      ? { status: 'lookup_failed' }
      : appAdminResult.value
        ? { status: 'active_record_confirmed' }
        : typeof req.user.email === 'string' &&
            normalizeEmail(req.user.email) === BOOTSTRAP_ACCOUNT_ADMIN_EMAIL
          ? { status: 'verified_oidc_sign_in_required' }
          : { status: 'not_designated_identity' },
  });
});

router.post('/logout', async (req: Request, res: Response) => {
  const config = await getOidcConfig();
  const origin = getRequestOrigin(req);
  const returnTo = getSafeReturnTo(req.query.returnTo, origin);
  const postLogoutRedirectUrl = new URL(returnTo, `${origin}/`).href;

  const sid = getSessionId(req);
  await clearSession(res, sid);

  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: postLogoutRedirectUrl,
  });

  res.redirect(endSessionUrl.href);
});

router.post(
  '/mobile-auth/token-exchange',
  async (req: Request, res: Response) => {
    const parsed = ExchangeMobileAuthorizationCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required parameters' });
      return;
    }

    const { code, code_verifier, redirect_uri, state, nonce } = parsed.data;

    try {
      const config = await getOidcConfig();

      const callbackUrl = new URL(redirect_uri);
      callbackUrl.searchParams.set('code', code);
      callbackUrl.searchParams.set('state', state);
      callbackUrl.searchParams.set('iss', ISSUER_URL);

      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: code_verifier,
        expectedNonce: nonce ?? undefined,
        expectedState: state,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims) {
        res.status(401).json({ error: 'No claims in ID token' });
        return;
      }

      const claimsRecord = claims as unknown as Record<string, unknown>;
      const dbUser = await upsertUser(claimsRecord);
      await maybeBootstrapAppAdmin(claimsRecord).catch((err) => {
        req.log.error({ err }, 'app admin bootstrap failed');
      });

      const sessionData: SessionData = {
        user: {
          id: dbUser.id,
          email: dbUser.email,
          firstName: dbUser.firstName,
          lastName: dbUser.lastName,
          profileImageUrl: dbUser.profileImageUrl,
        },
      };

      const sid = await createSession(sessionData);
      res.json(ExchangeMobileAuthorizationCodeResponse.parse({ token: sid }));
    } catch (err) {
      req.log.error(getSafeErrorMetadata(err), 'Mobile token exchange error');
      res.status(500).json({ error: 'Token exchange failed' });
    }
  },
);

router.post('/mobile-auth/logout', async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) {
    await deleteSession(sid);
  }
  res.json(LogoutMobileSessionResponse.parse({ success: true }));
});

export default router;
