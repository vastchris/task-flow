import { TaskArea, TaskFlowV2Data } from "./v2Schema";

export function createTaskId(data: TaskFlowV2Data, area: TaskArea): string {
  const prefix = area === "week" ? "tf-w" : "tf-d";
  let highest = 0;
  for (const month of Object.values(data.files)) {
    for (const id of Object.keys(month.tasks)) {
      const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
      if (match) {
        highest = Math.max(highest, Number(match[1]));
      }
    }
  }

  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}
