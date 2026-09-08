import { Router } from "express";
import { GetMyMembershipContextResponse } from "@workspace/api-zod";
import { getCachedDirectory } from "../lib/enterprise";
import { buildMembershipContext } from "../lib/membership-context";

const router = Router();

router.get("/me/membership-context", async (req, res): Promise<void> => {
  try {
    const directory = await getCachedDirectory();
    const context = buildMembershipContext(
      req.authz!.userId,
      directory,
      req.configurationSnapshot!,
    );
    res.json(GetMyMembershipContextResponse.parse(context));
  } catch (error) {
    req.log.error({ err: error }, "personal membership context unavailable");
    res.status(503).json({
      error: "Cached personal membership context unavailable",
    });
  }
});

export default router;