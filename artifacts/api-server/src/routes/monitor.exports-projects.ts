import { Router } from "express";
import { handleSpendProjectsCsv } from "./monitor.spend-tables";

const router = Router();

// Compatibility alias. Keeping one handler guarantees identical canonical
// attribution, identity/view filters, full-row selection, and qualifications.
router.get("/projects/export", handleSpendProjectsCsv);

export default router;