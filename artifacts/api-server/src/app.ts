import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import router from "./routes";
import { authMiddleware } from "./middlewares/authMiddleware";
import {
  getRequestOrigin,
  requireSameOriginForCookieMutations,
} from "./lib/auth";
import { logger } from "./lib/logger";
import { DEV_VIEW_AS_HEADER, isDevViewEnabled } from "./lib/dev-view";

const app: Express = express();
const SAFE_DEV_VIEW_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function devViewReadOnlyBoundary(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (
    isDevViewEnabled() &&
    req.header(DEV_VIEW_AS_HEADER) &&
    !SAFE_DEV_VIEW_METHODS.has(req.method)
  ) {
    res.status(403).json({ error: "Development view-as is read-only" });
    return;
  }
  next();
}

function diagnosticEndpoint(url: string | undefined): string {
  const segments = (url?.split("?")[0] ?? "/").split("/");
  return segments
    .map((segment, index) => {
      try {
        const decoded = decodeURIComponent(segment);
        const previous = segments[index - 1];
        const beforePrevious = segments[index - 2];
        const dynamic =
          previous === "groups" ||
          previous === "clusters" ||
          previous === "workspaces" ||
          previous === "admins" ||
          previous === "app-admins" ||
          previous === "alerts" ||
          previous === "operations" ||
          (previous === "members" && decoded !== "budget") ||
          (beforePrevious === "reporting" &&
            (previous === "details" || previous === "teams")) ||
          (previous === "team-budgets" && decoded !== "targets") ||
          previous === "targets" ||
          beforePrevious === "targets";
        return dynamic || decoded.includes("@") || decoded.length > 128
          ? "[redacted]"
          : segment;
      } catch {
        return "[redacted]";
      }
    })
    .join("/");
}

app.use(
  pinoHttp({
    logger,
    autoLogging: false,
    genReqId(_req, res) {
      const requestId = randomUUID();
      res.setHeader("x-request-id", requestId);
      return requestId;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: diagnosticEndpoint(req.url),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const details = {
      requestId: req.id,
      endpoint: diagnosticEndpoint(req.originalUrl),
      method: req.method,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    };
    if (res.statusCode >= 500) {
      req.log.error(details, "HTTP request failed");
    } else if (res.statusCode >= 400) {
      req.log.warn(details, "HTTP request completed with client error");
    } else {
      req.log.info(details, "HTTP request completed");
    }
  });
  next();
});
app.use((req, res, next) => {
  let origin: string;
  try {
    origin = getRequestOrigin(req);
  } catch {
    res.status(400).json({ message: "Invalid request origin" });
    return;
  }

  cors({
    credentials: true,
    exposedHeaders: ["x-request-id"],
    origin(requestOrigin, callback) {
      callback(null, requestOrigin == null || requestOrigin === origin);
    },
  })(req, res, next);
});
app.use(devViewReadOnlyBoundary);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireSameOriginForCookieMutations);
app.use(authMiddleware);
app.use((_req, res, next) => {
  // Authenticated JSON and CSV must never be shared by browsers or proxies.
  // The in-process Spend cache remains authorization- and generation-scoped.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader(
    "Vary",
    "Authorization, Cookie, X-Dev-View-As, Accept-Encoding",
  );
  next();
});

app.use("/api", router);

export default app;
