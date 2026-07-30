export interface ProjectMetric {
  id: string;
  name: string;
  /** Category: ai, hosting, storage, or other */
  category: string;
  costUsd: number;
}

export interface GroupProject {
  projectId: string;
  /** Project title, or null if untitled */
  title: string | null;
  totalCostUsd: number;
  metrics: ProjectMetric[];
}

export interface GroupProjectsResponse {
  projects: GroupProject[];
  /** Group spend not attributable to any returned project row */
  unattributedSpendUsd: number;
  /** False while project usage is still loading; poll every ~8s until true */
  isComplete: boolean;
}

export interface GetGroupProjectsParams {
  rangeType?: 'billing' | 'mtd' | 'ytd' | 'custom';
  startDate?: string;
  endDate?: string;
}
