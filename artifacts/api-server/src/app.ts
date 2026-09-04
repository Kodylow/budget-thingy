import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { authMiddleware } from "./middlewares/authMiddleware";
import {
  getRequestOrigin,
  requireSameOriginForCookieMutations,
} from "./lib/auth";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
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
  let origin: string;
  try {
    origin = getRequestOrigin(req);
  } catch {
    res.status(400).json({ message: "Invalid request origin" });
    return;
  }

  cors({
    credentials: true,
    origin(requestOrigin, callback) {
      callback(null, requestOrigin == null || requestOrigin === origin);
    },
  })(req, res, next);
});
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireSameOriginForCookieMutations);
app.use(authMiddleware);

app.use("/api", router);

export default app;
