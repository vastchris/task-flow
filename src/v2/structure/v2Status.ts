import { TFile, Vault } from "obsidian";
import { TaskFlowV2Store } from "../store/v2Store";
import {
  MonthTaskData,
  TaskRecord,
  TaskStatus,
} from "../store/v2Schema";
import {
  tag,
  tagMonth,
} from "./v2Helpers";
import {
  findTasklog,
  updateStatusMark,
} from "./v2Document";
import { computeWeekKey } from "../calendar";
import { buildParentTaskSummary, taskIdentityKey } from "./v2TaskGroups";

const statusDocumentQueues = new Map<string, Promise<void>>();

export async function runStatusDocumentOperation<T>(
  file: TFile,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = statusDocumentQueues.get(file.path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  statusDocumentQueues.set(file.path, gate);

  try {
    await previous.catch(() => undefined);
    return await operation();
  } finally {
    release();
    if (statusDocumentQueues.get(file.path) === gate) {
      statusDocumentQueues.delete(file.path);
    }
  }
}

// ── Public API ──

/** Single-point status change triggered by circle click or tasklog change.
 *  Follows the 7.1.7 unified flow. */
export async function changeDayTaskStatus(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskId: string,
  newStatus: TaskStatus,
  options: {
    tasklogTrigger?: boolean;
    documentContent?: string;
    documentReader?: () => string | Promise<string>;
    documentWriter?: (newContent: string, previousContent: string) => void | Promise<void>;
  } = {},
): Promise<void> {
  return runStatusDocumentOperation(file, async () => {
  // Pre-validate: must be a non-parent Day task
  const month = await store.getMonth(file);
  if (!month) throw new Error("Month data not found");
  const task = month.tasks[taskId];
  if (!task) throw new Error("Task not found");
  if (task.area !== "day") throw new Error("Only Day tasks can change status");
  if (task.childIds.length > 0) throw new Error("Parent tasks cannot change status directly");

  // Reject special-state tasks (✅ marks from same-source group resolution)
  if (!options.tasklogTrigger && hasSpecialMark(month, taskId)) {
    throw new Error("Special-state tasks cannot be changed manually");
  }

  const content = options.documentReader
    ? await options.documentReader()
    : options.documentContent ?? await vault.read(file);
  const newContent = await applyDayTaskStatusChanges(
    store,
    file,
    [{ taskId, newStatus }],
    content,
  );
  if (newContent !== content) {
    if (options.documentWriter) {
      await options.documentWriter(newContent, content);
    } else {
      await vault.modify(file, newContent);
    }
  }
  });
}

export async function applyDayTaskStatusChanges(
  store: TaskFlowV2Store,
  file: TFile,
  changes: Array<{ taskId: string; newStatus: TaskStatus }>,
  content: string,
): Promise<string> {
  if (changes.length === 0) return content;
  const changedIds = new Set<string>();

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const parentIds = new Set<string>();
    const weekKeys = new Set<string>();

    for (const change of changes) {
      const task = month.tasks[change.taskId];
      if (!task || task.area !== "day" || task.childIds.length > 0) continue;
      if (task.status !== change.newStatus) {
        task.status = change.newStatus;
        changedIds.add(task.id);
      }
      applyCrossDateSameSourceGroup(month, task.id, changedIds);
      if (task.parentId) parentIds.add(task.parentId);
      weekKeys.add(computeWeekKey(task.areaKey));
    }

    for (const parentId of parentIds) {
      applyDayParentStatus(month, parentId, changedIds);
    }
    for (const weekKey of weekKeys) {
      applyWeekDaySync(month, weekKey, changedIds);
    }
  });

  if (changedIds.size === 0) return content;
  const month = await store.getMonth(file);
  if (!month) return content;

  let newContent = content;
  for (const id of changedIds) {
    const task = month.tasks[id];
    if (task) {
      newContent = updateStatusMark(
        newContent,
        id,
        task.status,
        hasSpecialMark(month, id),
      );
    }
  }
  return newContent;
}

/** Global status recalculation after structural changes (7.2). */
export async function recalcGlobalStatus(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
): Promise<void> {
  return runStatusDocumentOperation(file, async () => {
  const changedIds = new Set<string>();
  const content = await vault.read(file);
  const currentTaskLogs = findTasklog(content);

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);

    // Step 4: Reset status for removed tasklogs
    const removedTaskLogs = month.confirmedTaskLogs.taskIds.filter(
      (id) => !currentTaskLogs.has(id),
    );
    for (const id of removedTaskLogs) {
      const task = month.tasks[id];
      if (task && task.area === "day" && task.childIds.length === 0) {
        if (task.status === "doing" || task.status === "done") {
          task.status = "todo";
          changedIds.add(id);
        }
      }
    }

    // Step 5: Recompute all same-source groups
    const processedGroups = new Set<string>();
    for (const task of Object.values(month.tasks)) {
      if (task.area !== "day" || task.childIds.length > 0) continue;
      const key = sameSourceKey(task);
      if (!key || processedGroups.has(key)) continue;
      processedGroups.add(key);
      applySameSourceGroupByKey(month, key, changedIds);
    }

    // Step 6: Recompute all Day parent statuses
    const processedParents = new Set<string>();
    for (const task of Object.values(month.tasks)) {
      if (task.area !== "day" || task.childIds.length === 0) continue;
      const parentKey = taskIdentityKey(task);
      if (processedParents.has(parentKey)) continue;
      processedParents.add(parentKey);
      applyDayParentStatus(month, task.id, changedIds);
    }

    // Step 7: Sync Week for all weeks in this month
    for (const weekKey of Object.keys(month.weeks)) {
      applyWeekDaySync(month, weekKey, changedIds);
    }
  });

  // Document sync
  if (changedIds.size > 0) {
    const content = await vault.read(file);
    let newContent = content;
    const m = await store.getMonth(file);
    if (m) {
      for (const id of changedIds) {
        const t = m.tasks[id];
        if (t) {
          newContent = updateStatusMark(newContent, id, t.status, hasSpecialMark(m, id));
        }
      }
    }
    if (newContent !== content) {
      await vault.modify(file, newContent);
    }
  }

  // Step 8: Update confirmedTaskLogs
  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    month.confirmedTaskLogs.taskIds = [...currentTaskLogs];
  });
  });
}

// ── Special mark detection ──

/** Check if a task should display the ✅ suffix (another task in its same-source group is done). */
export function hasSpecialMark(month: MonthTaskData, taskId: string): boolean {
  const task = month.tasks[taskId];
  if (!task || task.status === "done") return false;

  const key = sameSourceKey(task);
  if (!key) return false;

  for (const t of Object.values(month.tasks)) {
    if (t.area !== "day" || t.childIds.length > 0) continue;
    if (t.id !== taskId && sameSourceKey(t) === key && t.status === "done") {
      return true;
    }
  }
  return false;
}

// ── Same-source group (7.1.3) ──

function applyCrossDateSameSourceGroup(
  month: MonthTaskData,
  triggerTaskId: string,
  changedIds: Set<string>,
): void {
  const key = sameSourceKey(month.tasks[triggerTaskId]);
  if (!key) return;
  applySameSourceGroupByKey(month, key, changedIds);
}

function applySameSourceGroupByKey(
  month: MonthTaskData,
  key: string,
  changedIds: Set<string>,
): void {
  const group: TaskRecord[] = [];
  for (const task of Object.values(month.tasks)) {
    if (task.area !== "day" || task.childIds.length > 0) continue;
    if (sameSourceKey(task) === key) {
      group.push(task);
    }
  }
  if (group.length <= 1) return;

  // Special state is derived rather than stored. Mark every group member dirty so
  // both the sidebar and Markdown receive/clear the ✅ decoration together.
  for (const task of group) changedIds.add(task.id);
}

function findLatestDone(tasks: TaskRecord[]): TaskRecord {
  return tasks.reduce((latest, t) => {
    if (t.areaKey > latest.areaKey) return t;
    if (t.areaKey === latest.areaKey && t.id > latest.id) return t;
    return latest;
  });
}

// ── Day parent aggregation (7.1.4) ──

function applyDayParentStatus(
  month: MonthTaskData,
  parentId: string,
  changedIds: Set<string>,
): void {
  const parent = month.tasks[parentId];
  if (!parent || parent.area !== "day" || parent.childIds.length === 0) return;
  const summary = buildParentTaskSummary(month, parent);
  if (!summary) return;

  // Update all date-instances of this parent (same identity means same status)
  const parentIdentity = taskIdentityKey(parent);
  for (const task of Object.values(month.tasks)) {
    if (task.area === "day" && task.childIds.length > 0 && taskIdentityKey(task) === parentIdentity) {
      if (task.status !== summary.status) {
        task.status = summary.status;
        changedIds.add(task.id);
      }
    }
  }
}

// ── Week/Day sync (7.1.6) ──

function applyWeekDaySync(
  month: MonthTaskData,
  weekKey: string,
  changedIds: Set<string>,
): void {
  const weekData = month.weeks[weekKey];
  if (!weekData) return;

  for (const weekTask of Object.values(month.tasks)) {
    if (weekTask.area !== "week" || weekTask.areaKey !== weekKey) continue;

    const hasDayInstances = weekTask.weektdayTaskIds.length > 0;

    if (weekTask.childIds.length > 0) continue;

    if (hasDayInstances) {
      // Week child/independent with Day instances — take from Day side
      let bestDayTask: TaskRecord | undefined;
      for (const dayId of weekTask.weektdayTaskIds) {
        const dayTask = month.tasks[dayId];
        if (dayTask) {
          bestDayTask = dayTask;
          break;
        }
      }
      if (bestDayTask) {
        const effective = getDayEffectiveStatus(month, bestDayTask);
        if (weekTask.status !== effective) {
          weekTask.status = effective;
          changedIds.add(weekTask.id);
        }
      }
    } else if (weekTask.status !== "todo") {
      weekTask.status = "todo";
      changedIds.add(weekTask.id);
    }
    // Without Day instances → keep own status
  }
  for (const weekTask of Object.values(month.tasks)) {
    if (
      weekTask.area !== "week"
      || weekTask.areaKey !== weekKey
      || weekTask.childIds.length === 0
    ) {
      continue;
    }
    const summary = buildParentTaskSummary(month, weekTask);
    const newStatus = summary?.status ?? "todo";
    if (weekTask.status !== newStatus) {
      weekTask.status = newStatus;
      changedIds.add(weekTask.id);
    }
  }
}

function getDayEffectiveStatus(month: MonthTaskData, dayTask: TaskRecord): TaskStatus {
  const key = sameSourceKey(dayTask);
  if (!key) return dayTask.status;

  const group: TaskRecord[] = [];
  for (const task of Object.values(month.tasks)) {
    if (task.area !== "day" || task.childIds.length > 0) continue;
    if (sameSourceKey(task) === key) {
      group.push(task);
    }
  }
  if (group.length <= 1) return dayTask.status;
  return resolveGroupEffectiveStatus(group);
}

function resolveGroupEffectiveStatus(group: TaskRecord[]): TaskStatus {
  if (group.some((task) => task.status === "done")) return "done";
  if (group.some((task) => task.status === "doing")) return "doing";
  return "todo";
}

// ── Helpers ──

function sameSourceKey(task: TaskRecord): string | null {
  if (task.sourceWeekTaskId) return task.sourceWeekTaskId;
  if (task.sourceDayTaskId) return task.sourceDayTaskId;
  if (task.area === "day" && task.daytdayTaskIds && task.daytdayTaskIds.length > 0) {
    return task.id;
  }
  return null;
}
