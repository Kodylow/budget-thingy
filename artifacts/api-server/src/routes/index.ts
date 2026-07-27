import { Router, type IRouter } from "express";
import healthRouter from "./health";
import monitorRouter from "./monitor";

const router: IRouter = Router();

router.use(healthRouter);
router.use(monitorRouter);

export default router;
