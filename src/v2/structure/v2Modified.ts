import { TFile, Vault } from "obsidian";
import {
  TaskFlowV2Store,
} from "../store/v2Store";
import { getTaskDisplayName, parseStoredTaskName, parseTaskInput, replaceStoredTaskTag } from "../taskTags";
import {
  MonthTaskData,
  TaskRecord,
  TaskOrderItem,
  TaskArea,
  getWeekTaskIds,
  getDayTaskIds,
  flattenOrderArray,
  findOrderItem,
  removeFromOrderArray,
  addChildToOrderArray,
} from "../store/v2Schema";
import { createTaskId } from "../store/v2Id";
import {
  hasDayBlock,
  insertTaskLine,
  insertTaskLinesBatch,
  removeTaskLine,
  removeTaskLinesBatch,
  removeTaskWithTasklog,
  renameTaskLine,
  renameTasklogHeading,
  reorderTaskLines,
  taskHasTasklog,
} from "./v2Document";
import {
  tag,
  tagMonth,
  pushUnique,
  identity,
  sameWeek,
  findDayInstance,
  findByIdentity,
} from "./v2Helpers";
import { recalcGlobalStatus } from "./v2Status";

// ── Local helpers ──

function newTask(id: string, area: TaskArea, areaKey: string, name: string): TaskRecord {
  return {
    id,
    area,
    areaKey,
    name,
    tags: parseStoredTaskName(name).tags,
    status: "todo",
    parentId: null,
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null,
  };
}

function linkChildToParent(month: MonthTaskData, child: TaskRecord): void {
  const parent = tag(month, child.parentId!);
  if (parent.areaKey === child.areaKey) {
    pushUnique(parent.childIds, child.id);
    if (child.area === "week") {
      addChildToOrderArray(getWeekTaskIds(month, child.areaKey), parent.id, child.id);
    } else {
      addChildToOrderArray(getDayTaskIds(month, child.areaKey), parent.id, child.id);
    }
  }
}

function pushToDayOrder(month: MonthTaskData, task: TaskRecord, dayKey: string): void {
  const ids = getDayTaskIds(month, dayKey);
  if (task.parentId) {
    const parent = tag(month, task.parentId);
    if (parent.areaKey === dayKey) {
      addChildToOrderArray(ids, task.parentId, task.id);
      return;
    }
  }
  if (task.childIds.length > 0) {
    ids.push({ id: task.id, childIds: [...task.childIds] });
  } else {
    ids.push(task.id);
  }
}

// ── Identity chain resolution ──

/** Collect all task IDs connected through identity fields (transitive closure). */
function resolveIdentityChain(month: MonthTaskData, taskId: string): Set<string> {
  const chain = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    chain.add(id);
    const t = month.tasks[id];
    if (!t) return;

    if (t.sourceWeekTaskId) visit(t.sourceWeekTaskId);
    if (t.sourceDayTaskId) visit(t.sourceDayTaskId);
    for (const cid of t.weektdayTaskIds) visit(cid);
    if (t.daytdayTaskIds) for (const cid of t.daytdayTaskIds) visit(cid);
  }

  visit(taskId);
  return chain;
}

// ── Rename preview ──

export interface RenamePreviewItem {
  taskId: string;
  name: string;
  areaKey: string;
  area: string;
}

export function getRenamePreview(month: MonthTaskData, taskId: string): RenamePreviewItem[] {
  const chain = resolveIdentityChain(month, taskId);
  const result: RenamePreviewItem[] = [];
  for (const id of chain) {
    const t = month.tasks[id];
    if (t) {
      result.push({ taskId: id, name: t.name, areaKey: t.areaKey, area: t.area });
    }
  }
  return result;
}

// ── Rename ──

function tasklogTitleForRename(
  month: MonthTaskData,
  taskId: string,
  renamedIds: Set<string>,
  newName: string
): string {
  const task = month.tasks[taskId];
  if (!task) {
    return getTaskDisplayName(newName);
  }
  const taskName = getTaskDisplayName(renamedIds.has(taskId) ? newName : task.name);
  if (!task.parentId) {
    return taskName;
  }
  const parent = month.tasks[task.parentId];
  const parentName = parent
    ? getTaskDisplayName(renamedIds.has(parent.id) ? newName : parent.name)
    : undefined;
  return parentName ? `${taskName} / ${parentName}` : taskName;
}

export async function renameTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskId: string,
  newName: string,
): Promise<void> {
  const parsedInput = parseTaskInput(newName);
  if (parsedInput.name.length === 0) throw new Error("任务名称不能为空");
  const normalizedName = parsedInput.storageName;

  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  if (!snap.tasks[taskId]) throw new Error(`Task not found: ${taskId}`);

  const chain = resolveIdentityChain(snap, taskId);
  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    for (const id of chain) {
      const t = month.tasks[id];
      if (t) {
        t.name = normalizedName;
        t.tags = parsedInput.tags;
      }
    }
  });

  const content = await vault.read(file);
  let newContent = content;
  for (const id of chain) {
    newContent = renameTaskLine(newContent, id, normalizedName);
  }
  const tasklogTitleIds = new Set(chain);
  for (const id of chain) {
    const task = snap.tasks[id];
    for (const childId of task?.childIds ?? []) {
      tasklogTitleIds.add(childId);
    }
  }
  for (const id of tasklogTitleIds) {
    newContent = renameTasklogHeading(newContent, id, tasklogTitleForRename(snap, id, chain, normalizedName));
  }
  await vault.modify(file, newContent);
}

export async function renameTagInTasks(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskIds: string[],
  level: "primary" | "secondary",
  currentPrimary: string,
  currentTag: string,
  newTag: string,
): Promise<void> {
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length === 0) return;

  const changedIds: string[] = [];
  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    for (const id of uniqueIds) {
      const task = month.tasks[id];
      if (!task) {
        continue;
      }
      const tags = task.tags ?? parseStoredTaskName(task.name).tags;
      const matches = level === "primary"
        ? tags.primary === currentTag
        : tags.primary === currentPrimary && tags.secondary === currentTag;
      if (!matches) {
        continue;
      }
      const parsed = replaceStoredTaskTag(task.name, level, newTag);
      task.name = parsed.storageName;
      task.tags = parsed.tags;
      changedIds.push(id);
    }
  });

  if (changedIds.length === 0) return;

  const month = await store.getMonth(file);
  if (!month) return;
  let newContent = await vault.read(file);
  for (const id of changedIds) {
    const task = month.tasks[id];
    if (task) {
      newContent = renameTaskLine(newContent, id, task.name);
    }
  }
  await vault.modify(file, newContent);
}

// ── Reorder ──

export async function reorderTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskId: string,
  targetIndex: number,
): Promise<void> {
  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  const task = snap.tasks[taskId];
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (targetIndex < 0) throw new Error("Invalid target index");

  const isChild = task.parentId !== null;
  const areaKey = task.areaKey;
  const area: "week" | "day" = task.area;

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, taskId);

    if (isChild) {
      const parent = tag(month, t.parentId!);
      const oldIdx = parent.childIds.indexOf(taskId);
      if (oldIdx === -1) throw new Error("Task not found in parent");
      parent.childIds.splice(oldIdx, 1);
      const idx = Math.min(targetIndex, parent.childIds.length);
      parent.childIds.splice(idx, 0, taskId);

      // Also update the TaskIdNode in the order array (it holds a copy)
      const orderArray = area === "week"
        ? getWeekTaskIds(month, areaKey)
        : getDayTaskIds(month, areaKey);
      const orderItem = findOrderItem(orderArray, t.parentId!);
      if (orderItem && typeof orderItem.item !== "string") {
        const nodeChildIds = (orderItem.item as { id: string; childIds: string[] }).childIds;
        const nodeIdx = nodeChildIds.indexOf(taskId);
        if (nodeIdx >= 0) {
          nodeChildIds.splice(nodeIdx, 1);
          nodeChildIds.splice(idx, 0, taskId);
        }
      }
    } else {
      const orderArray = area === "week"
        ? getWeekTaskIds(month, areaKey)
        : getDayTaskIds(month, areaKey);
      const found = findOrderItem(orderArray, taskId);
      if (!found) throw new Error("Task not found in order array");
      orderArray.splice(found.index, 1);
      const idx = Math.min(targetIndex, orderArray.length);
      orderArray.splice(idx, 0, found.item);
    }
  });

  // Read back the reordered state for document sync
  const month = await store.getMonth(file);
  if (!month) return;

  const content = await vault.read(file);
  const orderItems = area === "week"
    ? getWeekTaskIds(month, areaKey)
    : getDayTaskIds(month, areaKey);
  const newContent = reorderTaskLines(content, areaKey, area, orderItems, month.tasks);
  await vault.modify(file, newContent);
}

// ── Date move ──

export async function reorderTagGroups(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  area: "week" | "day",
  areaKey: string,
  primaryOrder: string[],
  secondaryOrders: Record<string, string[]>,
): Promise<void> {
  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const orderItems = area === "week"
      ? getWeekTaskIds(month, areaKey)
      : getDayTaskIds(month, areaKey);
    orderItems.splice(0, orderItems.length, ...orderItemsByTagOrder(
      orderItems,
      month.tasks,
      primaryOrder,
      secondaryOrders
    ));
  });

  const month = await store.getMonth(file);
  if (!month) return;
  const content = await vault.read(file);
  const orderItems = area === "week"
    ? getWeekTaskIds(month, areaKey)
    : getDayTaskIds(month, areaKey);
  const newContent = reorderTaskLines(content, areaKey, area, orderItems, month.tasks);
  await vault.modify(file, newContent);
}

function orderItemsByTagOrder(
  orderItems: TaskOrderItem[],
  tasks: Record<string, TaskRecord>,
  primaryOrder: string[],
  secondaryOrders: Record<string, string[]>,
): TaskOrderItem[] {
  const untagged: TaskOrderItem[] = [];
  const primaryBuckets = new Map<string, {
    plain: TaskOrderItem[];
    subgroups: Map<string, TaskOrderItem[]>;
    secondaryCounts: Map<string, number>;
  }>();

  for (const item of orderItems) {
    const task = tasks[orderItemId(item)];
    const tags = task?.tags ?? parseStoredTaskName(task?.name ?? "").tags;
    const primary = tags.primary;
    if (!primary) {
      untagged.push(item);
      continue;
    }
    let bucket = primaryBuckets.get(primary);
    if (!bucket) {
      bucket = { plain: [], subgroups: new Map(), secondaryCounts: new Map() };
      primaryBuckets.set(primary, bucket);
    }
    if (tags.secondary) {
      bucket.secondaryCounts.set(tags.secondary, (bucket.secondaryCounts.get(tags.secondary) ?? 0) + 1);
    }
  }

  for (const item of orderItems) {
    const task = tasks[orderItemId(item)];
    const tags = task?.tags ?? parseStoredTaskName(task?.name ?? "").tags;
    const primary = tags.primary;
    if (!primary) continue;
    const bucket = primaryBuckets.get(primary);
    if (!bucket) continue;
    const secondary = tags.secondary;
    if (!secondary || (bucket.secondaryCounts.get(secondary) ?? 0) < 2) {
      bucket.plain.push(item);
      continue;
    }
    const subgroup = bucket.subgroups.get(secondary) ?? [];
    subgroup.push(item);
    bucket.subgroups.set(secondary, subgroup);
  }

  const orderedPrimaryTags = mergeKnownOrder(primaryOrder, [...primaryBuckets.keys()]);
  const result = [...untagged];
  for (const primary of orderedPrimaryTags) {
    const bucket = primaryBuckets.get(primary);
    if (!bucket) continue;
    result.push(...bucket.plain);
    const orderedSecondaryTags = mergeKnownOrder(
      secondaryOrders[primary] ?? [],
      [...bucket.subgroups.keys()]
    );
    for (const secondary of orderedSecondaryTags) {
      result.push(...(bucket.subgroups.get(secondary) ?? []));
    }
  }
  return result;
}

function mergeKnownOrder(preferred: string[], current: string[]): string[] {
  const currentSet = new Set(current);
  const result = preferred.filter((tagName) => currentSet.has(tagName));
  for (const tagName of current) {
    if (!result.includes(tagName)) {
      result.push(tagName);
    }
  }
  return result;
}

function orderItemId(item: TaskOrderItem): string {
  return typeof item === "string" ? item : item.id;
}

export async function moveDayTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  taskId: string,
  targetDayKey: string,
): Promise<void> {
  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  const task = snap.tasks[taskId];
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.area !== "day") throw new Error("Only Day tasks can be moved between days");
  if (task.status !== "todo") throw new Error("已开始或已完成的任务不能移动日期");
  if (task.areaKey === targetDayKey) throw new Error("Task already on target day");
  if (!sameWeek(task.areaKey, targetDayKey)) throw new Error("不能移动到其他周");

  // Pre-check: target day block must exist
  const content = await vault.read(file);
  if (!hasDayBlock(content, targetDayKey)) {
    throw new Error(`请在文档中创建 ${targetDayKey} 的日期区域后再移动任务`);
  }

  const sourceDayKey = task.areaKey;

  if (task.sourceWeekTaskId) {
    // Week-source
    if (task.childIds.length > 0) {
      await moveWeekSourceParent(store, vault, file, task, targetDayKey);
    } else if (task.parentId) {
      await moveWeekSourceChild(store, vault, file, task, targetDayKey);
    } else {
      await moveWeekSourceIndependent(store, vault, file, task, targetDayKey);
    }
  } else {
    // Day-created
    if (task.childIds.length > 0) {
      await moveDayCreatedParent(store, vault, file, task, targetDayKey);
    } else if (task.parentId) {
      await moveDayCreatedChild(store, vault, file, task, targetDayKey);
    } else {
      await moveDayCreatedIndependent(store, vault, file, task, targetDayKey);
    }
  }

  await recalcGlobalStatus(store, vault, file);
}

// ── 4.1 Week-source parent instance ──

async function moveWeekSourceParent(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  task: TaskRecord,
  targetDayKey: string,
): Promise<void> {
  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  const sourceDayKey = task.areaKey;

  // Reject if any child not todo
  for (const childId of task.childIds) {
    const child = snap.tasks[childId];
    if (child && child.status !== "todo") {
      throw new Error(`子任务"${child.name}"已开始或已完成，不能移动。请先将该子任务延续或删除后再操作。`);
    }
  }

  const movedIds: string[] = [];
  const deletedIds: string[] = [];

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, task.id);

    // Collect all child IDs before we modify anything
    const childIds = [...t.childIds];
    movedIds.push(t.id);
    for (const cid of childIds) movedIds.push(cid);

    const existingParent = findDayInstance(month, t.sourceWeekTaskId!, targetDayKey);

    if (existingParent) {
      // Merge: move children to existing parent
      for (const childId of childIds) {
        const child = tag(month, childId);
        child.areaKey = targetDayKey;
        child.parentId = existingParent.id;
      }
      existingParent.childIds.push(...childIds);
      // Update order arrays at target
      for (const childId of childIds) {
        addChildToOrderArray(getDayTaskIds(month, targetDayKey), existingParent.id, childId);
        removeFromOrderArray(getDayTaskIds(month, sourceDayKey), childId);
      }

      // Delete source parent
      removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);
      delete month.tasks[t.id];
      // Remove from Week source's weektdayTaskIds
      const weekSource = tag(month, t.sourceWeekTaskId!);
      weekSource.weektdayTaskIds = weekSource.weektdayTaskIds.filter((id) => id !== t.id);
      deletedIds.push(t.id);
    } else {
      // Simple move
      t.areaKey = targetDayKey;
      for (const childId of childIds) {
        const child = tag(month, childId);
        child.areaKey = targetDayKey;
      }
      removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);
      pushToDayOrder(month, t, targetDayKey);
    }
  });

  // Document sync: always remove ALL affected tasks (parent + children)
  // from wherever they currently are, then rebuild the target block.
  let docContent = await vault.read(file);
  docContent = removeTaskLinesBatch(docContent, new Set(movedIds));

  // Re-read to get correct state for insertion
  const month = await store.getMonth(file);
  if (!month) return;

  // Rebuild target block from order array
  const targetOrder = getDayTaskIds(month, targetDayKey);
  docContent = reorderTaskLines(docContent, targetDayKey, "day", targetOrder, month.tasks);
  await vault.modify(file, docContent);
}

// ── 4.2 Week-source child instance ──

async function moveWeekSourceChild(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  task: TaskRecord,
  targetDayKey: string,
): Promise<void> {
  const sourceDayKey = task.areaKey;
  const weekSourceId = task.sourceWeekTaskId!;

  let sourceParentDeleted = false;
  let sourceParentId = "";
  let newParentCreated = false;
  let weekRootId = weekSourceId;

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, task.id);
    sourceParentId = t.parentId!;
    const sourceParent = tag(month, sourceParentId);

    // Resolve the Week root — the auto-created parent should be a Day instance
    // of the Week ROOT task, not a Week child. sourceParent.sourceWeekTaskId
    // always points to the Week root because addWeekTasksToDay creates Day
    // instances from the root, and our own auto-created parents use it too.
    weekRootId = sourceParent.sourceWeekTaskId ?? weekSourceId;

    // Check if target day already has matching parent
    const existingParent = findDayInstance(month, weekRootId, targetDayKey);
    let targetParentId: string;

    if (existingParent) {
      targetParentId = existingParent.id;
    } else {
      // Auto-create parent
      targetParentId = createTaskId(data, "day");
      const parentName = sourceParent.name;
      data.files[file.path].tasks[targetParentId] = newTask(targetParentId, "day", targetDayKey, parentName);
      const newParent = tag(month, targetParentId);
      newParent.sourceWeekTaskId = weekRootId;
      // Register in Week root
      const weekRoot = tag(month, weekRootId);
      pushUnique(weekRoot.weektdayTaskIds, targetParentId);
      pushToDayOrder(month, newParent, targetDayKey);
      newParentCreated = true;
    }

    // Move this child
    t.areaKey = targetDayKey;
    t.parentId = targetParentId;
    const targetParent = tag(month, targetParentId);
    pushUnique(targetParent.childIds, t.id);
    addChildToOrderArray(getDayTaskIds(month, targetDayKey), targetParentId, t.id);

    // Remove from source parent
    sourceParent.childIds = sourceParent.childIds.filter((id) => id !== t.id);
    removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);

    // Cleanup: empty Week-source parent → auto-delete
    if (sourceParent.childIds.length === 0) {
      removeFromOrderArray(getDayTaskIds(month, sourceDayKey), sourceParent.id);
      const weekRootForCleanup = tag(month, weekRootId);
      weekRootForCleanup.weektdayTaskIds = weekRootForCleanup.weektdayTaskIds.filter((id) => id !== sourceParent.id);
      delete month.tasks[sourceParentId];
      sourceParentDeleted = true;
    }
  });

  // Document sync
  let docContent = await vault.read(file);
  if (sourceParentDeleted) {
    docContent = removeTaskLinesBatch(docContent, new Set([task.id, sourceParentId]));
  } else {
    docContent = removeTaskLine(docContent, task.id);
  }

  const month = await store.getMonth(file);
  if (!month) return;

  if (newParentCreated) {
    const targetParent = month.tasks[findDayInstance(month, weekRootId, targetDayKey)?.id ?? ""];
    if (targetParent) {
      docContent = insertTaskLine(docContent, targetParent);
      docContent = insertTaskLine(docContent, month.tasks[task.id] ?? task, targetParent);
    }
  } else {
    const targetParent = findDayInstance(month, weekRootId, targetDayKey);
    if (targetParent && month.tasks[task.id]) {
      docContent = insertTaskLine(docContent, month.tasks[task.id], targetParent);
    }
  }
  await vault.modify(file, docContent);
}

// ── 4.3 Week-source independent instance ──

async function moveWeekSourceIndependent(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  task: TaskRecord,
  targetDayKey: string,
): Promise<void> {
  const sourceDayKey = task.areaKey;

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, task.id);
    t.areaKey = targetDayKey;
    removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);
    pushToDayOrder(month, t, targetDayKey);
  });

  const content = await vault.read(file);
  let newContent = removeTaskLine(content, task.id);
  const month = await store.getMonth(file);
  if (month && month.tasks[task.id]) {
    newContent = insertTaskLine(newContent, month.tasks[task.id]);
  }
  await vault.modify(file, newContent);
}

// ── 4.4 Day-created parent ──

async function moveDayCreatedParent(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  task: TaskRecord,
  targetDayKey: string,
): Promise<void> {
  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  const sourceDayKey = task.areaKey;

  // Reject if any child not todo
  for (const childId of task.childIds) {
    const child = snap.tasks[childId];
    if (child && child.status !== "todo") {
      throw new Error(`子任务"${child.name}"已开始或已完成，不能移动。请先将该子任务延续或删除后再操作。`);
    }
  }

  const movedIds: string[] = [];

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, task.id);
    const childIds = [...t.childIds];
    movedIds.push(t.id);
    for (const cid of childIds) movedIds.push(cid);

    t.areaKey = targetDayKey;
    for (const childId of childIds) {
      const child = tag(month, childId);
      child.areaKey = targetDayKey;
    }

    removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);
    pushToDayOrder(month, t, targetDayKey);
  });

  const content = await vault.read(file);
  let newContent = removeTaskLinesBatch(content, new Set(movedIds));
  const month = await store.getMonth(file);
  if (month) {
    const targetOrder = getDayTaskIds(month, targetDayKey);
    newContent = reorderTaskLines(newContent, targetDayKey, "day", targetOrder, month.tasks);
  }
  await vault.modify(file, newContent);
}

// ── 4.5 Day-created child ──

async function moveDayCreatedChild(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  task: TaskRecord,
  targetDayKey: string,
): Promise<void> {
  const sourceDayKey = task.areaKey;
  let sourceParentId = "";
  let newParentCreated = false;
  let createdParentId = "";

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, task.id);
    sourceParentId = t.parentId!;
    const sourceParent = tag(month, sourceParentId);

    // Identity for Day-created tasks
    const ident = t.sourceDayTaskId ?? sourceParent.sourceDayTaskId ?? sourceParent.id;

    const existingParent = findByIdentity(month, ident, targetDayKey);
    let targetParentId: string;

    if (existingParent) {
      targetParentId = existingParent.id;
    } else {
      // Auto-create parent
      targetParentId = createTaskId(data, "day");
      const parentName = sourceParent.name;
      month.tasks[targetParentId] = newTask(targetParentId, "day", targetDayKey, parentName);
      const newParent = tag(month, targetParentId);
      // Copy source relationships
      newParent.sourceDayTaskId = sourceParent.sourceDayTaskId ?? sourceParent.id;

      // Wire daytdayTaskIds on the root
      const rootId = sourceParent.sourceDayTaskId ?? sourceParent.id;
      const root = tag(month, rootId);
      if (!root.daytdayTaskIds) root.daytdayTaskIds = [];
      pushUnique(root.daytdayTaskIds, targetParentId);

      pushToDayOrder(month, newParent, targetDayKey);
      newParentCreated = true;
      createdParentId = targetParentId;
    }

    // Move child
    t.areaKey = targetDayKey;
    t.parentId = targetParentId;
    const targetParent = tag(month, targetParentId);
    pushUnique(targetParent.childIds, t.id);
    addChildToOrderArray(getDayTaskIds(month, targetDayKey), targetParentId, t.id);

    // Remove from source
    sourceParent.childIds = sourceParent.childIds.filter((id) => id !== t.id);
    removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);

    // Day-created parent with empty childIds stays as independent
    // No deletion needed
  });

  // Document sync
  let docContent = await vault.read(file);
  docContent = removeTaskLine(docContent, task.id);

  const month = await store.getMonth(file);
  if (!month) return;

  if (newParentCreated && createdParentId) {
    const newParent = month.tasks[createdParentId];
    if (newParent) {
      docContent = insertTaskLine(docContent, newParent);
      const childTask = month.tasks[task.id];
      if (childTask) {
        docContent = insertTaskLine(docContent, childTask, newParent);
      }
    }
  } else {
    const targetParent = findByIdentity(month, task.sourceDayTaskId ?? sourceParentId, targetDayKey);
    if (targetParent && month.tasks[task.id]) {
      docContent = insertTaskLine(docContent, month.tasks[task.id], targetParent);
    }
  }
  await vault.modify(file, docContent);
}

// ── 4.6 Day-created independent ──

async function moveDayCreatedIndependent(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  task: TaskRecord,
  targetDayKey: string,
): Promise<void> {
  const sourceDayKey = task.areaKey;

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const t = tag(month, task.id);
    t.areaKey = targetDayKey;
    removeFromOrderArray(getDayTaskIds(month, sourceDayKey), t.id);
    pushToDayOrder(month, t, targetDayKey);
  });

  const content = await vault.read(file);
  let newContent = removeTaskLine(content, task.id);
  const month = await store.getMonth(file);
  if (month && month.tasks[task.id]) {
    newContent = insertTaskLine(newContent, month.tasks[task.id]);
  }
  await vault.modify(file, newContent);
}

// ── moveProjectionChildren ──

export async function moveProjectionChildren(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  parentTaskId: string,
  currentDayKey: string,
  targetDayKey: string,
): Promise<void> {
  if (currentDayKey === targetDayKey) throw new Error("Source and target day are the same");
  if (!sameWeek(currentDayKey, targetDayKey)) throw new Error("不能移动到其他周");

  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");

  // Pre-check: target day block must exist
  const content = await vault.read(file);
  if (!hasDayBlock(content, targetDayKey)) {
    throw new Error(`请在文档中创建 ${targetDayKey} 的日期区域后再移动任务`);
  }

  // Find children to move
  const dayOrder = getDayTaskIds(snap, currentDayKey);
  const childrenToMove: TaskRecord[] = [];
  for (const id of flattenOrderArray(dayOrder)) {
    const t = snap.tasks[id];
    if (t && t.parentId === parentTaskId && t.status === "todo") {
      childrenToMove.push(t);
    }
  }

  if (childrenToMove.length === 0) {
    throw new Error("No todo children found to move");
  }

  // Move each child individually
  for (const child of childrenToMove) {
    if (child.sourceWeekTaskId) {
      await moveWeekSourceChild(store, vault, file, child, targetDayKey);
    } else {
      await moveDayCreatedChild(store, vault, file, child, targetDayKey);
    }
  }

  await recalcGlobalStatus(store, vault, file);
}
