import { MonthTaskData, TaskFlowV2Data } from "./v2Schema";

export function createEmptyTaskFlowV2Data(updatedAt = new Date(0).toISOString()): TaskFlowV2Data {
  return {
    version: 2,
    updatedAt,
    files: {}
  };
}

export function createEmptyMonthTaskData(): MonthTaskData {
  return {
    tasks: {},
    weeks: {},
    confirmedTaskLogs: {
      taskIds: []
    }
  };
}
