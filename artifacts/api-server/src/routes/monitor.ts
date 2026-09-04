import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import groupsListRouter from "./monitor.groups-list";
import groupsDetailRouter from "./monitor.groups-detail";
import summaryRouter from "./monitor.summary";
import teamsRouter from "./monitor.teams";
import limitsRouter from "./monitor.limits";
import alertsRouter, { canSeeAlertEntity } from "./monitor.alerts";
import adminRouter from "./monitor.admin";
import directoryRouter from "./monitor.directory";
import projectExportsRouter from "./monitor.exports-projects";
import userExportsRouter from "./monitor.exports-users";

const router: IRouter = Router();
router.use(requireAuth);
router.use(groupsListRouter);
router.use(groupsDetailRouter);
router.use(summaryRouter);
router.use(teamsRouter);
router.use(limitsRouter);
router.use(alertsRouter);
router.use(adminRouter);
router.use(directoryRouter);
router.use(projectExportsRouter);
router.use(userExportsRouter);

export { canSeeAlertEntity };
export default router;
