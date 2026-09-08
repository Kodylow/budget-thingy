import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const FETCH_MODES = new Set([
  "cors",
  "navigate",
  "no-cors",
  "same-origin",
  "websocket",
]);

export function sendHealth(_req: Request, res: Response): void {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

export function rootProbeDiagnostic(req: Request): {
  sourceKind:
    | "browser"
    | "curl"
    | "go-http-client"
    | "node-undici"
    | "unknown";
  secFetchMode: string;
  isNavigation: boolean;
  hasForwarded: boolean;
  hasReferer: boolean;
} {
  const userAgent = req.header("user-agent") ?? "";
  const sourceKind = /^Go-http-client(?:\/|$)/i.test(userAgent)
    ? "go-http-client"
    : /^curl(?:\/|$)/i.test(userAgent)
      ? "curl"
      : /^undici$/i.test(userAgent)
        ? "node-undici"
      : /(Mozilla\/|Chrome\/|Chromium\/|Firefox\/|Safari\/)/i.test(userAgent)
        ? "browser"
        : "unknown";
  const rawFetchMode = req.header("sec-fetch-mode");
  const secFetchMode =
    rawFetchMode && FETCH_MODES.has(rawFetchMode) ? rawFetchMode : rawFetchMode ? "other" : "missing";
  return {
    sourceKind,
    secFetchMode,
    isNavigation: secFetchMode === "navigate",
    hasForwarded: [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ].some((header) => req.headers[header] !== undefined),
    hasReferer: req.headers.referer !== undefined,
  };
}

export function isDocumentNavigation(req: Request): boolean {
  if (req.header("sec-fetch-mode") === "navigate") return true;
  return (req.header("accept") ?? "")
    .split(",")
    .some((value) => value.trim().toLowerCase().startsWith("text/html"));
}

function sendRootHealth(req: Request, res: Response): void {
  req.log.info(
    { event: "api.root_probe", ...rootProbeDiagnostic(req) },
    "API root requested",
  );
  sendHealth(req, res);
}

// The API artifact itself is mounted at /api. Keep that exact root useful to
// artifact probes without turning unknown paths into successful health checks.
router.get("/", sendRootHealth);
router.get("/healthz", sendHealth);

export default router;
