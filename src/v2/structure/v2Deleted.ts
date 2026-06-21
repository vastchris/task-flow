import { TFile, Vault } from "obsidian";
import {
  flattenOrderArray,
  getDayTaskIds,
  MonthTaskData,
  TaskFlowV2Data,
  TaskRecord,
} from "../store/v2Schema";
import { TaskFlowV2Store } from "../store/v2Store";
import { findTasklog, removeTaskLinesBatch } from "./v2Document";
import { recalcGlobalStatus } from "./v2Status";

// ── Types ──

export type DeletionLevel = "simple" | "parent_cascade" | "cross_area" | "root_continuation";

export interface DeletionPreview {
  taskId: string;
  taskName: string;
  level: DeletionLevel;
  /** Names of child tasks that will be cascade-deleted */
  childNames: string[];
  /** Day instance info for cross-area cascade */
  dayInstances: Array<{ date: string; name: string }>;
  /** Continuation chain info for root deletion */
  continuationInfo: {
    /** The task being deleted */
    deletedTaskName: string;
    /** Children affected */
    children: Array<{
      name: string;
      action: "delete" | "promote";
      promoteDate?: string;
    }>;
    /** The new root after promotion (if any) */
    newRootName: string | null;
    newRootDate: string | null;
    /** Unaffected continuation count */
    unchangedCount: number;
  } | null;
  /** Empty parent warnings */
  emptyParentWarnings: Array<{ date: string; parentName: string }>;
  /** Total tasks that will be deleted */
  totalCount: number;
}

// ── Public API ──

export async function deleteTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskId: string,
): Promise<void> {
  let scope = new Set<string>();
  await store.mutate((data) => {
    const month = requireMonth(data.files[file.path]);
    if (!month.tasks[taskId]) {
      throw new Error("任务不存在或已被删除");
    }
    scope = computeDeletionScope(month, taskId);
    executeDeletion(month, scope, taskId);
  });

  // Document sync: remove deleted task lines
  if (scope.size > 0) {
    const content = await vault.read(file);
    const newContent = removeTaskLinesBatch(content, scope);
    if (newContent !== content) {
      await vault.modify(file, newContent);
    }
  }

  await recalcGlobalStatus(store, vault, file);
}

export async function deleteTasks(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskIds: string[],
): Promise<void> {
  let scope = new Set<string>();
  await store.mutate((data) => {
    const month = requireMonth(data.files[file.path]);
    scope = new Set<string>();
    for (const taskId of taskIds) {
      if (!month.tasks[taskId]) {
        throw new Error("任务不存在或已被删除");
      }
      const taskScope = computeDeletionScope(month, taskId);
      for (const id of taskScope) {
        scope.add(id);
      }
    }
    executeDeletion(month, scope, taskIds[0]);
  });

  // Document sync
  const content = await vault.read(file);
  const newContent = removeTaskLinesBatch(content, scope);
  if (newContent !== content) {
    await vault.modify(file, newContent);
  }

  await recalcGlobalStatus(store, vault, file);
}

export async function deleteProjectionDescendants(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  parentTaskId: string,
  dayKey: string,
): Promise<void> {
  let scope = new Set<string>();
  await store.mutate((data) => {
    const month = requireMonth(data.files[file.path]);
    if (!month.tasks[parentTaskId]) {
      throw new Error("父任务不存在或已被删除");
    }

    const dayIds = getDayTaskIds(month, dayKey);
    const directChildren = flattenOrderArray(dayIds).filter((id) => {
      const task = month.tasks[id];
      return task && task.parentId === parentTaskId;
    });

    if (directChildren.length === 0) {
      return;
    }

    scope = new Set<string>();
    for (const childId of directChildren) {
      const childScope = computeDeletionScope(month, childId);
      for (const id of childScope) {
        scope.add(id);
      }
    }

    scope.delete(parentTaskId);

    executeDeletion(month, scope, directChildren[0]);
  });

  // Document sync
  if (scope.size > 0) {
    const content = await vault.read(file);
    const newContent = removeTaskLinesBatch(content, scope);
    if (newContent !== content) {
      await vault.modify(file, newContent);
    }
  }

  await recalcGlobalStatus(store, vault, file);
}

export function getDeletionTasklogIds(
  month: MonthTaskData,
  taskIds: string[],
  content: string,
): string[] {
  const scope = new Set<string>();
  for (const taskId of taskIds) {
    if (!month.tasks[taskId]) continue;
    for (const id of computeDeletionScope(month, taskId)) scope.add(id);
  }
  const tasklogs = findTasklog(content);
  return [...scope].filter((id) => tasklogs.has(id));
}

export function getProjectionDeletionTasklogIds(
  month: MonthTaskData,
  parentTaskId: string,
  dayKey: string,
  content: string,
): string[] {
  const directChildren = flattenOrderArray(getDayTaskIds(month, dayKey)).filter((id) => {
    const task = month.tasks[id];
    return task?.parentId === parentTaskId;
  });
  return getDeletionTasklogIds(month, directChildren, content);
}

export function getDeletionPreview(
  month: MonthTaskData,
  taskId: string,
): DeletionPreview {
  const task = month.tasks[taskId];
  if (!task) {
    throw new Error("任务不存在或已被删除");
  }

  const scope = computeDeletionScope(month, taskId);
  const totalCount = scope.size;

  // Collect child names (tasks deleted due to parent→child cascade)
  const childNames: string[] = [];
  for (const id of scope) {
    if (id === taskId) continue;
    const t = month.tasks[id];
    if (t && t.area === task.area && t.parentId) {
      // This is a child in the same area
      childNames.push(t.name);
    }
  }

  // Collect Day instances (deleted because Week task has weektdayTaskIds)
  const dayInstances: Array<{ date: string; name: string }> = [];
  for (const id of scope) {
    if (id === taskId) continue;
    const t = month.tasks[id];
    if (t && t.area === "day") {
      if (task.area === "week") {
        // Week→Day cascade
        dayInstances.push({ date: t.areaKey, name: t.name });
      } else if (task.area === "day" && !task.parentId && task.childIds.length > 0) {
        // Day parent deleting children that are Day instances
        // These are already counted in childNames, skip
      }
    }
  }

  // Determine level
  let level: DeletionLevel = "simple";
  if (task.daytdayTaskIds && task.daytdayTaskIds.length > 0 && !task.sourceDayTaskId) {
    // Continuation root
    level = "root_continuation";
  } else if (task.area === "week" && task.weektdayTaskIds.length > 0) {
    level = "cross_area";
  } else if (task.childIds.length > 0) {
    level = "parent_cascade";
  }

  // Continuation info for root deletion
  let continuationInfo: DeletionPreview["continuationInfo"] = null;
  if (task.daytdayTaskIds && task.daytdayTaskIds.length > 0 && !task.sourceDayTaskId) {
    const surviving = task.daytdayTaskIds
      .filter((id) => !scope.has(id))
      .sort((a, b) => {
        const ta = month.tasks[a];
        const tb = month.tasks[b];
        if (!ta || !tb) return 0;
        return ta.areaKey.localeCompare(tb.areaKey);
      });

    const newRoot = surviving.length > 0 ? month.tasks[surviving[0]] : null;
    const unchangedCount = Math.max(0, surviving.length - 1);

    const children: NonNullable<DeletionPreview["continuationInfo"]>["children"] = [];
    // Deleted children: root's own children
    for (const childId of task.childIds) {
      const child = month.tasks[childId];
      if (!child) continue;
      const childSurviving = (child.daytdayTaskIds ?? [])
        .filter((id) => !scope.has(id))
        .sort((a, b) => {
          const ta = month.tasks[a];
          const tb = month.tasks[b];
          if (!ta || !tb) return 0;
          return ta.areaKey.localeCompare(tb.areaKey);
        });
      if (childSurviving.length > 0) {
        const promotedChild = month.tasks[childSurviving[0]];
        children.push({
          name: child.name,
          action: "promote",
          promoteDate: promotedChild?.areaKey ?? undefined,
        });
      } else {
        children.push({ name: child.name, action: "delete" });
      }
    }

    continuationInfo = {
      deletedTaskName: task.name,
      children,
      newRootName: newRoot?.name ?? null,
      newRootDate: newRoot?.areaKey ?? null,
      unchangedCount,
    };
  }

  // Empty parent warnings
  const emptyParentWarnings: DeletionPreview["emptyParentWarnings"] = [];
  // After deletion, check if any surviving parent becomes childless
  // (handled post-deletion in executeDeletion, preview just notes it)
  // For now, check Week-source Day parents that would lose all children
  if (task.area === "day" && task.parentId) {
    const parent = month.tasks[task.parentId];
    if (parent && !scope.has(parent.id)) {
      const remainingChildren = parent.childIds.filter((cid) => !scope.has(cid));
      if (remainingChildren.length === 0 && parent.sourceWeekTaskId) {
        emptyParentWarnings.push({
          date: parent.areaKey,
          parentName: parent.name,
        });
      }
    }
  }

  return {
    taskId: task.id,
    taskName: task.name,
    level,
    childNames,
    dayInstances,
    continuationInfo,
    emptyParentWarnings,
    totalCount,
  };
}

export function getBatchDeletionPreview(
  month: MonthTaskData,
  taskIds: string[],
): DeletionPreview {
  const scope = new Set<string>();
  for (const taskId of taskIds) {
    const taskScope = computeDeletionScope(month, taskId);
    for (const id of taskScope) {
      scope.add(id);
    }
  }

  const firstName = month.tasks[taskIds[0]]?.name ?? "?";
  let level: DeletionLevel = "simple";
  let hasParent = false;
  let hasCrossArea = false;

  const childNames: string[] = [];
  const dayInstances: Array<{ date: string; name: string }> = [];

  for (const id of scope) {
    if (taskIds.includes(id)) continue;
    const t = month.tasks[id];
    if (!t) continue;
    if (t.parentId && scope.has(t.parentId)) {
      childNames.push(t.name);
      hasParent = true;
    }
    if (t.area === "day") {
      // Check if any root task is a Week task
      const anyWeekRoot = taskIds.some((tid) => {
        const rt = month.tasks[tid];
        return rt && rt.area === "week";
      });
      if (anyWeekRoot) {
        dayInstances.push({ date: t.areaKey, name: t.name });
        hasCrossArea = true;
      }
    }
  }

  if (hasCrossArea) {
    level = "cross_area";
  } else if (hasParent) {
    level = "parent_cascade";
  }

  return {
    taskId: "",
    taskName: `${taskIds.length} 项任务`,
    level,
    childNames,
    dayInstances,
    continuationInfo: null,
    emptyParentWarnings: [],
    totalCount: scope.size,
  };
}

// ── Scope computation ──

function computeDeletionScope(
  month: MonthTaskData,
  taskId: string,
): Set<string> {
  const scope = new Set<string>();
  const task = month.tasks[taskId];
  if (!task) return scope;

  // Rule: parent-delete cascades to all children
  addTaskAndDescendants(month, taskId, scope);

  // Rule: Week→Day cascade — all Day instances of deleted Week tasks
  cascadeWeekToDay(month, scope);

  // Note: Day→Day continuation instances are NOT cascaded.
  // Continuation instances survive root deletion (the earliest gets promoted per 3.7).
  // They are only deleted when explicitly targeted or cascaded via Week→Day.

  return scope;
}

function addTaskAndDescendants(
  month: MonthTaskData,
  taskId: string,
  scope: Set<string>,
): void {
  if (scope.has(taskId)) return;
  const task = month.tasks[taskId];
  if (!task) return;
  scope.add(taskId);
  for (const childId of task.childIds) {
    addTaskAndDescendants(month, childId, scope);
  }
}

function cascadeWeekToDay(
  month: MonthTaskData,
  scope: Set<string>,
): void {
  const weekTasks = [...scope]
    .map((id) => month.tasks[id])
    .filter((task): task is TaskRecord => task && task.area === "week");

  for (const weekTask of weekTasks) {
    for (const dayId of weekTask.weektdayTaskIds) {
      if (!scope.has(dayId)) {
        addTaskAndDescendants(month, dayId, scope);
      }
    }
  }
}

// ── Execution ──

function executeDeletion(
  month: MonthTaskData,
  scope: Set<string>,
  _rootTaskId: string,
): void {
  // 1. Promote continuation roots BEFORE deletion (3.7)
  promoteContinuationRoots(month, scope);

  // 2. Handle empty parents (Section 5) — must run BEFORE cleanSurvivingReferences
  //    because cleanSurvivingReferences removes childIds, making detection impossible
  handleEmptyParents(month, scope);

  // 3. Clean references in surviving tasks (bidirectional)
  cleanSurvivingReferences(month, scope);

  // 4. Delete all scoped records
  for (const taskId of scope) {
    delete month.tasks[taskId];
  }

  // 5. Clean order arrays
  cleanOrderArrays(month, scope);

  // 6. Clean confirmed task logs
  month.confirmedTaskLogs.taskIds = month.confirmedTaskLogs.taskIds.filter(
    (id) => !scope.has(id),
  );
}

// ── Continuation root promotion (3.7) ──

function promoteContinuationRoots(
  month: MonthTaskData,
  scope: Set<string>,
): void {
  // Find all continuation roots in the deletion scope.
  // Process children first (those with parentId in scope), then parents.
  const rootsToPromote = [...scope]
    .map((id) => month.tasks[id])
    .filter(
      (task): task is TaskRecord =>
        task &&
        task.area === "day" &&
        task.sourceDayTaskId === null &&
        task.daytdayTaskIds !== null &&
        task.daytdayTaskIds.length > 0,
    );

  // Sort: tasks whose parent is also being deleted are handled by the parent's
  // promoteContinuationRoot — skip them here.
  const topLevel = rootsToPromote.filter(
    (r) => !r.parentId || !scope.has(r.parentId),
  );

  for (const root of topLevel) {
    promoteContinuationRoot(month, scope, root);
  }
}

function promoteContinuationRoot(
  month: MonthTaskData,
  scope: Set<string>,
  root: TaskRecord,
): void {
  // Find earliest surviving continuation
  const surviving = (root.daytdayTaskIds ?? [])
    .filter((id) => !scope.has(id))
    .sort((a, b) => {
      const ta = month.tasks[a];
      const tb = month.tasks[b];
      if (!ta || !tb) return 0;
      return ta.areaKey.localeCompare(tb.areaKey);
    });

  if (surviving.length === 0) {
    return;
  }

  const newRootId = surviving[0];
  const newRoot = month.tasks[newRootId];
  if (!newRoot) return;

  // Promote: clear sourceDayTaskId, inherit remaining daytdayTaskIds
  newRoot.sourceDayTaskId = null;
  newRoot.daytdayTaskIds = surviving.length > 1 ? surviving.slice(1) : null;

  // Repair parent linkage: if this root has a surviving parent,
  // replace old root ID with new root ID in parent's childIds
  if (root.parentId) {
    const parent = month.tasks[root.parentId];
    if (parent && !scope.has(parent.id)) {
      const idx = parent.childIds.indexOf(root.id);
      if (idx >= 0) {
        parent.childIds[idx] = newRootId;
      }
      newRoot.parentId = parent.id;
    }
  }

  // Handle children: for each child of the old root, promote their continuations too
  const newChildIds: string[] = [];
  for (const childId of root.childIds) {
    const child = month.tasks[childId];
    if (!child) continue;

    if (scope.has(childId)) {
      // Child root is being deleted — promote its earliest continuation
      if (child.daytdayTaskIds && child.daytdayTaskIds.length > 0) {
        const childSurviving = child.daytdayTaskIds
          .filter((id) => !scope.has(id))
          .sort((a, b) => {
            const ta = month.tasks[a];
            const tb = month.tasks[b];
            if (!ta || !tb) return 0;
            return ta.areaKey.localeCompare(tb.areaKey);
          });

        if (childSurviving.length > 0) {
          const newChildRootId = childSurviving[0];
          const newChildRoot = month.tasks[newChildRootId];
          if (newChildRoot) {
            newChildRoot.sourceDayTaskId = null;
            newChildRoot.daytdayTaskIds =
              childSurviving.length > 1 ? childSurviving.slice(1) : null;
            newChildRoot.parentId = newRootId;
            newChildIds.push(newChildRootId);
          }
        }
      }
    } else {
      // Child survives — keep it
      newChildIds.push(childId);
    }
  }
  newRoot.childIds = newChildIds;

  // Update remaining continuations' sourceDayTaskId
  for (let i = 1; i < surviving.length; i++) {
    const cont = month.tasks[surviving[i]];
    if (cont) {
      cont.sourceDayTaskId = newRootId;
    }
  }

  // Update Week source reference
  if (root.sourceWeekTaskId) {
    const weekSource = month.tasks[root.sourceWeekTaskId];
    if (weekSource && !scope.has(weekSource.id)) {
      const idx = weekSource.weektdayTaskIds.indexOf(root.id);
      if (idx >= 0) {
        weekSource.weektdayTaskIds[idx] = newRootId;
      }
    }
  }
}

// ── Empty parent handling (Section 5) ──

function handleEmptyParents(
  month: MonthTaskData,
  scope: Set<string>,
): void {
  // After scope is computed but before deletion, check which surviving
  // parents will become childless and handle per Section 5 rules.

  for (const task of Object.values(month.tasks)) {
    if (scope.has(task.id)) continue;

    // Check if this task will lose children
    const remainingChildren = task.childIds.filter((cid) => !scope.has(cid));
    if (remainingChildren.length > 0) continue;
    if (task.childIds.length === 0) continue; // already empty, no change

    // This task's childIds will become empty after deletion
    if (task.area === "week" && task.parentId === null) {
      // Week parent: keep as independent task (downgrade to string in order array)
      // Handled by cleanOrderArrays which checks childIds after deletion
      task.childIds = [];
    } else if (task.area === "day" && task.sourceWeekTaskId) {
      // Day instance from Week source: auto-delete (Section 5, row 2)
      scope.add(task.id);
      // Also clean up Week source's reference
      const weekSource = month.tasks[task.sourceWeekTaskId];
      if (weekSource && !scope.has(weekSource.id)) {
        weekSource.weektdayTaskIds = weekSource.weektdayTaskIds.filter(
          (id) => id !== task.id,
        );
      }
    } else if (task.area === "day") {
      // Day created/continuation parent: keep as independent task (Section 5, row 3)
      task.childIds = [];
    }
  }
}

// ── Reference cleanup ──

function cleanSurvivingReferences(
  month: MonthTaskData,
  scope: Set<string>,
): void {
  for (const task of Object.values(month.tasks)) {
    if (scope.has(task.id)) continue;

    // Clean childIds
    task.childIds = task.childIds.filter((id) => !scope.has(id));

    // Clean weektdayTaskIds
    task.weektdayTaskIds = task.weektdayTaskIds.filter((id) => !scope.has(id));

    // Clean daytdayTaskIds
    if (task.daytdayTaskIds) {
      task.daytdayTaskIds = task.daytdayTaskIds.filter((id) => !scope.has(id));
      if (task.daytdayTaskIds.length === 0) {
        task.daytdayTaskIds = null;
      }
    }

    // Clean sourceWeekTaskId
    if (task.sourceWeekTaskId && scope.has(task.sourceWeekTaskId)) {
      task.sourceWeekTaskId = null;
    }

    // Clean sourceDayTaskId
    if (task.sourceDayTaskId && scope.has(task.sourceDayTaskId)) {
      task.sourceDayTaskId = null;
    }

    // Clean parentId
    if (task.parentId && scope.has(task.parentId)) {
      task.parentId = null;
    }
  }
}

// ── Order array cleanup ──

function cleanOrderArrays(
  month: MonthTaskData,
  scope: Set<string>,
): void {
  for (const week of Object.values(month.weeks)) {
    week.weekTaskIds = week.weekTaskIds.filter((item) => {
      const id = typeof item === "string" ? item : item.id;
      return !scope.has(id);
    });

    // Remove deleted children from TaskIdNode.childIds, downgrade to string if empty
    for (let i = 0; i < week.weekTaskIds.length; i++) {
      const item = week.weekTaskIds[i];
      if (typeof item !== "string") {
        item.childIds = item.childIds.filter((cid) => !scope.has(cid));
        if (item.childIds.length === 0) {
          week.weekTaskIds[i] = item.id;
        }
      }
    }

    for (const day of Object.values(week.days)) {
      day.dayTaskIds = day.dayTaskIds.filter((item) => {
        const id = typeof item === "string" ? item : item.id;
        return !scope.has(id);
      });

      for (let i = 0; i < day.dayTaskIds.length; i++) {
        const item = day.dayTaskIds[i];
        if (typeof item !== "string") {
          item.childIds = item.childIds.filter((cid) => !scope.has(cid));
          if (item.childIds.length === 0) {
            day.dayTaskIds[i] = item.id;
          }
        }
      }
    }
  }
}

// ── Helpers ──

function requireMonth(month: MonthTaskData | undefined): MonthTaskData {
  if (!month) {
    throw new Error("数据加载失败，请刷新后重试");
  }
  return month;
}
