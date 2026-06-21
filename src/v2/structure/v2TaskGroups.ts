import { MonthTaskData, TaskRecord, TaskStatus } from "../store/v2Schema";
import { parseDateKey } from "./v2Helpers";

export interface TaskIdentityGroup {
  key: string;
  name: string;
  status: TaskStatus;
  instances: TaskRecord[];
  latestInstance: TaskRecord;
}

export interface ParentTaskSummary {
  status: TaskStatus;
  completed: number;
  total: number;
  groups: TaskIdentityGroup[];
}

export function taskIdentityKey(task: TaskRecord): string {
  return task.sourceWeekTaskId ?? task.sourceDayTaskId ?? task.id;
}

export function buildParentTaskSummary(
  month: MonthTaskData,
  parent: TaskRecord,
): ParentTaskSummary | undefined {
  if (parent.childIds.length === 0) return undefined;

  const groups = parent.area === "week"
    ? buildWeekChildGroups(month, parent)
    : buildDayChildGroups(month, parent);
  if (groups.length === 0) return undefined;

  const completed = groups.filter((group) => group.status === "done").length;
  const allTodo = groups.every((group) => group.status === "todo");
  const allDone = completed === groups.length;

  return {
    status: allDone ? "done" : allTodo ? "todo" : "doing",
    completed,
    total: groups.length,
    groups,
  };
}

function buildDayChildGroups(
  month: MonthTaskData,
  parent: TaskRecord,
): TaskIdentityGroup[] {
  if (parent.sourceWeekTaskId) {
    const weekParent = month.tasks[parent.sourceWeekTaskId];
    if (weekParent?.area === "week" && weekParent.childIds.length > 0) {
      return buildWeekChildGroups(month, weekParent);
    }
  }

  const parentKey = taskIdentityKey(parent);
  const instances: TaskRecord[] = [];

  for (const candidate of Object.values(month.tasks)) {
    if (
      candidate.area !== "day"
      || candidate.childIds.length === 0
      || taskIdentityKey(candidate) !== parentKey
    ) {
      continue;
    }
    for (const childId of candidate.childIds) {
      const child = month.tasks[childId];
      if (child?.area === "day") instances.push(child);
    }
  }

  return groupInstances(instances);
}

function buildWeekChildGroups(
  month: MonthTaskData,
  parent: TaskRecord,
): TaskIdentityGroup[] {
  const groups: TaskIdentityGroup[] = [];
  for (const childId of parent.childIds) {
    const child = month.tasks[childId];
    if (!child) continue;
    const dayInstances = child.weektdayTaskIds
      .map((id) => month.tasks[id])
      .filter((task): task is TaskRecord => Boolean(task) && task.area === "day");
    const instances = dayInstances.length > 0 ? dayInstances : [child];
    groups.push(toGroup(child.id, child.name, instances));
  }
  return groups;
}

function groupInstances(instances: TaskRecord[]): TaskIdentityGroup[] {
  const grouped = new Map<string, TaskRecord[]>();
  for (const instance of instances) {
    const key = taskIdentityKey(instance);
    const group = grouped.get(key) ?? [];
    group.push(instance);
    grouped.set(key, group);
  }

  return [...grouped.entries()].map(([key, group]) => (
    toGroup(key, group[0].name, group)
  ));
}

function toGroup(
  key: string,
  name: string,
  instances: TaskRecord[],
): TaskIdentityGroup {
  const latestInstance = instances.reduce((latest, candidate) => {
    const latestDate = parseDateKey(latest.areaKey) ?? Number.NEGATIVE_INFINITY;
    const candidateDate = parseDateKey(candidate.areaKey) ?? Number.NEGATIVE_INFINITY;
    if (candidateDate > latestDate) return candidate;
    if (candidate.areaKey === latest.areaKey && candidate.id > latest.id) return candidate;
    return latest;
  });
  const status: TaskStatus = instances.some((task) => task.status === "done")
    ? "done"
    : instances.some((task) => task.status === "doing")
      ? "doing"
      : "todo";

  return { key, name, status, instances, latestInstance };
}
