import { describe, expect, it, vi } from "vitest";
import {
  AuthRequestCancelledError,
  loadAuthorization,
  nextAuthorizationRequestVersion,
} from "@workspace/replit-auth-web";

const capabilities = {
  canManageAccess: false,
  canEditAllocations: false,
  canPreviewRoles: false,
  canWriteGroupLimits: false,
  canWriteUserLimitsIn: [],
};

const authorizedEnvelope = {
  user: {
    id: "caller",
    email: null,
    firstName: null,
    lastName: null,
    profileImageUrl: null,
  },
  auth: {
    role: "member" as const,
    roles: ["member" as const],
    workspaceIds: [],
    teamNames: [],
    groupIds: [],
    userIds: ["caller"],
    isPreview: false,
  },
  capabilities,
};

describe("authorization request state", () => {
  it("retries a temporary 503 and resolves a later success", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(authorizedEnvelope));
    const sleep = vi.fn(async () => undefined);

    await expect(loadAuthorization({
      previewAs: "member:caller",
      signal: new AbortController().signal,
      fetcher,
      sleep,
    })).resolves.toEqual({
      availability: "authorized",
      envelope: authorizedEnvelope,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get("X-Preview-As"))
      .toBe("member:caller");
  });

  it("exhausts bounded retries into unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    await expect(loadAuthorization({
      previewAs: null,
      signal: new AbortController().signal,
      fetcher,
      sleep,
    })).resolves.toEqual({ availability: "unavailable", envelope: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "signed-out"],
    [403, "denied"],
    [400, "unavailable"],
  ] as const)("classifies HTTP %s as %s without retrying", async (status, availability) => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    const sleep = vi.fn(async () => undefined);
    await expect(loadAuthorization({
      previewAs: null,
      signal: new AbortController().signal,
      fetcher,
      sleep,
    })).resolves.toEqual({ availability, envelope: null });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("classifies an invalid selected preview separately", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 400 }));
    await expect(loadAuthorization({
      previewAs: "member:missing",
      signal: new AbortController().signal,
      fetcher,
    })).resolves.toEqual({ availability: "invalid-preview", envelope: null });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stops a superseded request without publishing a false state", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadAuthorization({
      previewAs: null,
      signal: controller.signal,
      fetcher: vi.fn(),
    })).rejects.toBeInstanceOf(AuthRequestCancelledError);
  });

  it("increments the request version used by the manual Retry action", () => {
    expect(nextAuthorizationRequestVersion(4)).toBe(5);
  });
});