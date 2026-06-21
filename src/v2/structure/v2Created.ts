import { TFile, Vault } from "obsidian";
import { createTaskId } from "../store/v2Id";
import { parseStoredTaskName, parseTaskInput } from "../taskTags";
import {
  addChildToOrderArray,
  flattenOrderArray,
  getDayTaskIds,
  getWeekTaskIds,
  MonthTaskData,
  TaskArea,
  TaskFlowV2Data,
  TaskOrderItem,
  TaskRecord,
} from "../store/v2Schema";
import { TaskFlowV2Store } from "../store/v2Store";
import { hasDayBlock, hasWeekBlock, insertTaskLine, insertTaskLinesBatch } from "./v2Document";
import { recalcGlobalStatus } from "./v2Status";
import {
  tag,
  tagMonth,
  pushUnique,
  identity,
  sameWeek,
  parseDateKey,
  findDayInstance,
  findByIdentity,
} from "./v2Helpers";

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

function areaIds(month: MonthTaskData, area: TaskArea, areaKey: string): TaskOrderItem[] {
  return area === "week" ? getWeekTaskIds(month, areaKey) : getDayTaskIds(month, areaKey);
}

function isEmptyName(name: string): boolean {
  return name.trim().length === 0;
}

function isDayInWeekRange(dayKey: string, weekKey: string): boolean {
  const [s, e] = splitWeekKey(weekKey);
  const d = parseDateKey(dayKey);
  const start = parseDateKey(s);
  const end = parseDateKey(e);
  return d !== null && start !== null && end !== null && d >= start && d <= end;
}

function splitWeekKey(wk: string): [string, string] {
  const m = /^(\d{4}\.\d{1,2}\.\d{1,2})-(\d{1,2}\.\d{1,2})$/.exec(wk);
  if (!m) return ["", ""];
  const year = m[1].split(".")[0];
  return [m[1], `${year}.${m[2]}`];
}

// ── Section 2: Top-level create ──

export async function createTopLevelTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  area: TaskArea,
  areaKey: string,
  name: string,
): Promise<string> {
  const parsedInput = parseTaskInput(name);
  if (isEmptyName(parsedInput.name)) throw new Error("任务名称不能为空");

  // Pre-check: document block must exist
  const content = await vault.read(file);
  if (area === "week" && !hasWeekBlock(content, areaKey)) {
    throw new Error("请在文档中创建对应的周区域");
  }
  if (area === "day" && !hasDayBlock(content, areaKey)) {
    throw new Error("请在文档中创建对应的日期区域");
  }

  let id = "";
  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    id = createTaskId(data, area);
    month.tasks[id] = newTask(id, area, areaKey, parsedInput.storageName);
    areaIds(month, area, areaKey).push(id);
  });

  // Write document
  const task = (await store.getMonth(file))!.tasks[id];
  const newContent = insertTaskLine(content, task);
  await vault.modify(file, newContent);

  await recalcGlobalStatus(store, vault, file);
  return id;
}

// ── Section 3: Child create ──

export async function createChildTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  parentId: string,
  name: string,
): Promise<string> {
  const parsedInput = parseTaskInput(name);
  if (isEmptyName(parsedInput.name)) throw new Error("任务名称不能为空");

  // Pre-flight snapshot
  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  const snapParent = tag(snap, parentId);
  const content = await vault.read(file);

  if (snapParent.parentId) throw new Error("Only one child level is supported");
  if (snapParent.area === "week" && !hasWeekBlock(content, snapParent.areaKey)) {
    throw new Error("请在文档中创建对应的周区域");
  }
  if (snapParent.area === "day" && !hasDayBlock(content, snapParent.areaKey)) {
    throw new Error("请在文档中创建对应的日期区域");
  }
  if (snapParent.area === "day" && snapParent.sourceWeekTaskId) {
    const weekSource = tag(snap, snapParent.sourceWeekTaskId);
    if (!hasWeekBlock(content, weekSource.areaKey)) {
      throw new Error("请在文档中创建对应的周区域");
    }
  }

  // Route Week-sourced Day tasks
  if (snapParent.area === "day" && snapParent.sourceWeekTaskId) {
    return createChildUnderWeekSourceAndArrange(store, vault, file, snapParent, name.trim());
  }

  // Rejection: Day independent → parent
  if (snapParent.area === "day" && snapParent.childIds.length === 0) {
    if (snapParent.status !== "todo") {
      throw new Error("已开始或已完成的任务不能变为父任务");
    }
  }

  // Rejection: Week independent → parent
  if (snapParent.area === "week" && snapParent.childIds.length === 0 && snapParent.weektdayTaskIds.length > 0) {
    let hasNonTodo = false;
    for (const did of snapParent.weektdayTaskIds) {
      const d = snap.tasks[did];
      if (d && d.status !== "todo") { hasNonTodo = true; break; }
    }
    if (hasNonTodo) {
      throw new Error("该任务已有进行中或已完成的日实例，不能变为父任务");
    }
  }

  let childId = "";
  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const parent = tag(month, parentId);
    if (parent.parentId) throw new Error("Only one child level is supported");

    childId = createTaskId(data, parent.area);
    month.tasks[childId] = {
      ...newTask(childId, parent.area, parent.areaKey, parsedInput.storageName),
      parentId,
    };
    parent.childIds.push(childId);
    addChildToOrderArray(areaIds(month, parent.area, parent.areaKey), parentId, childId);
  });

  // Write document: insert child line under parent
  const child = (await store.getMonth(file))!.tasks[childId];
  const parent = (await store.getMonth(file))!.tasks[parentId];
  const newContent = insertTaskLine(content, child, parent);
  if (newContent !== content) await vault.modify(file, newContent);

  await recalcGlobalStatus(store, vault, file);
  return childId;
}

// Week-sourced Day task child creation: create under Week source, arrange to Day
async function createChildUnderWeekSourceAndArrange(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  dayParent: TaskRecord,
  name: string,
): Promise<string> {
  const weekSourceId = dayParent.sourceWeekTaskId!;
  const targetDayKey = dayParent.areaKey;

  // Rejection: if day parent is independent (childIds empty) and status != todo
  if (dayParent.childIds.length === 0 && dayParent.status !== "todo") {
    throw new Error("已开始或已完成的任务不能变为父任务");
  }

  // Step 1: create child under the Week source
  const weekChildId = await createChildTask(store, vault, file, weekSourceId, name);

  // Step 2: arrange to Day
  await addWeekTaskToDay(store, vault, file, weekChildId, targetDayKey);

  return weekChildId;
}

// Re-check: all Day instances from Week independent must be todo
async function recheckWeekIndependentDayStatus(
  store: TaskFlowV2Store,
  file: TFile,
  weekTaskId: string,
): Promise<void> {
  const snap = await store.getMonth(file);
  if (!snap) throw new Error("Month data not found");
  const weekTask = tag(snap, weekTaskId);
  for (const did of weekTask.weektdayTaskIds) {
    const d = snap.tasks[did];
    if (d && d.status !== "todo") {
      throw new Error("该任务已有进行中或已完成的日实例，不能变为父任务");
    }
  }
}

// ── Section 4: Week → Day arrange ──

export async function addWeekTaskToDay(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  weekTaskId: string,
  targetDayKey: string,
): Promise<string> {
  const results = await addWeekTasksToDay(store, vault, file, [weekTaskId], targetDayKey);
  return results[0];
}

export async function addWeekTasksToDay(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  weekTaskIds: string[],
  targetDayKey: string,
): Promise<string[]> {
  // Pre-check: day block must exist
  const content = await vault.read(file);
  if (!hasDayBlock(content, targetDayKey)) {
    throw new Error("请在文档中创建对应的日期区域");
  }

  const affectedRootIds: string[] = [];
  const createdDayIds: string[] = [];

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const weekKey = computeWeekKeyForDay(targetDayKey, data, file.path);

    // Resolve sources: expand child→parent if parent included
    const resolved = resolveWeekSources(month, [...new Set(weekTaskIds)]);

    for (const src of resolved) {
      if (src.area !== "week") throw new Error("Only Week tasks can be arranged to Day");
      if (src.areaKey !== weekKey || !isDayInWeekRange(targetDayKey, weekKey)) {
        throw new Error("Week task and target date must belong to the same week");
      }

      const sourceRoot = src.parentId ? tag(month, src.parentId) : src;
      const sourceTasks = src.parentId
        ? [sourceRoot, src]
        : [sourceRoot, ...sourceRoot.childIds.map((cid) => tag(month, cid))];

      // Build Day instances
      const dayBySourceId = new Map<string, TaskRecord>();
      let anyCreated = false;

      for (const st of sourceTasks) {
        const exist = findDayInstance(month, st.id, targetDayKey);
        if (exist) {
          dayBySourceId.set(st.id, exist);
          continue;
        }

        const did = createTaskId(data, "day");
        const dt: TaskRecord = {
          ...newTask(did, "day", targetDayKey, st.name),
          sourceWeekTaskId: st.id,
        };
        month.tasks[did] = dt;
        pushUnique(st.weektdayTaskIds, did);
        dayBySourceId.set(st.id, dt);
        createdDayIds.push(did);
        anyCreated = true;
      }

      if (!anyCreated) continue;

      // Wire parent-child in Day
      if (sourceTasks.length > 1) {
        const dayRoot = dayBySourceId.get(sourceRoot.id)!;
        for (const cid of sourceRoot.childIds) {
          const dc = dayBySourceId.get(cid);
          if (dc) {
            dc.parentId = dayRoot.id;
            if (!dayRoot.childIds.includes(dc.id)) {
              dayRoot.childIds.push(dc.id);
            }
          }
        }
      }

      // Add to order array
      const dayIds = getDayTaskIds(month, targetDayKey);
      const dayRoot = dayBySourceId.get(sourceRoot.id)!;
      if (dayRoot.childIds.length > 0) {
        const existingIdx = findOrderItemIdx(dayIds, dayRoot.id);
        if (existingIdx >= 0) {
          const item = dayIds[existingIdx];
          if (typeof item !== "string") {
            for (const cid of dayRoot.childIds) {
              if (!item.childIds.includes(cid)) item.childIds.push(cid);
            }
          }
        } else {
          dayIds.push({ id: dayRoot.id, childIds: [...dayRoot.childIds] });
        }
      } else {
        if (!flattenOrderArray(dayIds).includes(dayRoot.id)) {
          dayIds.push(dayRoot.id);
        }
      }

      affectedRootIds.push(dayRoot.id);
    }
  });

  if (affectedRootIds.length === 0) {
    throw new Error("所选任务已全部存在于目标日期");
  }

  // Write document: insert new day tasks
  if (createdDayIds.length > 0) {
    const month = (await store.getMonth(file))!;
    const batch = createdDayIds.map((did) => {
      const task = month.tasks[did];
      const parentTask = task.parentId ? month.tasks[task.parentId] : undefined;
      return { task, parentTask };
    });
    const latest = await vault.read(file);
    const newContent = insertTaskLinesBatch(latest, batch);
    await vault.modify(file, newContent);
  }

  await recalcGlobalStatus(store, vault, file);
  return affectedRootIds;
}

function resolveWeekSources(month: MonthTaskData, ids: string[]): TaskRecord[] {
  const set = new Set(ids);
  const emitted = new Set<string>();
  const out: TaskRecord[] = [];

  for (const id of ids) {
    const t = tag(month, id);
    // If parent also selected (or all children selected), use parent as source
    const parent = t.parentId ? tag(month, t.parentId) : null;
    const source = parent && (set.has(parent.id) || parent.childIds.every((c) => set.has(c)))
      ? parent
      : t;

    if (!emitted.has(source.id)) {
      emitted.add(source.id);
      out.push(source);
    }
  }
  return out;
}

function findOrderItemIdx(items: TaskOrderItem[], id: string): number {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it === "string" ? it === id : it.id === id) return i;
  }
  return -1;
}

function computeWeekKeyForDay(dayKey: string, _data: TaskFlowV2Data, _filePath: string): string {
  // Derive week key from dayKey. We use the simple formula:
  // dayKey = "YYYY.M.D", convert to Date, find Monday
  const ts = parseDateKey(dayKey);
  if (ts === null) throw new Error("Invalid day key");
  const d = new Date(ts);
  const wd = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (wd === 0 ? -6 : 1 - wd));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (dt: Date) => `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}`;
  const short = (dt: Date) => `${dt.getMonth() + 1}.${dt.getDate()}`;
  return `${fmt(mon)}-${short(sun)}`;
}

// ── Section 5: Day → Week add ──

export async function addDayTaskToWeek(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  dayTaskId: string,
): Promise<string> {
  const results = await addDayTasksToWeek(store, vault, file, [dayTaskId]);
  return results[0];
}

export async function addDayTasksToWeek(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  dayTaskIds: string[],
): Promise<string[]> {
  const createdRootIds: string[] = [];
  const createdWeekIds: string[] = [];
  let weekKey = "";

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const ids = [...new Set(dayTaskIds)];

    // Validate original IDs before resolution
    for (const id of ids) {
      const t = tag(month, id);
      if (t.area !== "day") throw new Error("Only Day tasks can be added to Week");
      if (t.parentId) throw new Error("子任务不能添加到周任务");
      if (t.sourceWeekTaskId) throw new Error("该任务已有周来源");
    }

    const sources = resolveDaySources(month, ids);

    for (const src of sources) {
      weekKey = computeWeekKeyForDay(src.areaKey, data, file.path);
      // Collect all Day task IDs linked to this source (including continuation chain)
      const relatedDayIds = collectDayChainIds(month, src);

      // Create Week tasks for each unique source identity in the chain
      const srcTasks = resolveDaySourceTasks(month, src);
      const createdBySource = new Map<string, string>();

      for (const st of srcTasks) {
        const stRelatedIds = collectDayChainIds(month, st);
        const wkId = createTaskId(data, "week");
        month.tasks[wkId] = {
          ...newTask(wkId, "week", weekKey, st.name),
          weektdayTaskIds: stRelatedIds,
        };
        createdBySource.set(st.id, wkId);
        createdWeekIds.push(wkId);

        // Wire Day tasks to Week
        for (const rid of stRelatedIds) {
          const rt = tag(month, rid);
          rt.sourceWeekTaskId = wkId;
        }
      }

      // Parent-child in Week
      const rootWkId = createdBySource.get(src.id)!;
      createdRootIds.push(rootWkId);
      const rootWk = tag(month, rootWkId);
      for (const cid of src.childIds) {
        const wcId = createdBySource.get(cid);
        if (wcId) {
          tag(month, wcId).parentId = rootWkId;
          rootWk.childIds.push(wcId);
        }
      }

      // Add to Week order
      const wkIds = getWeekTaskIds(month, weekKey);
      if (rootWk.childIds.length > 0) {
        wkIds.push({ id: rootWkId, childIds: [...rootWk.childIds] });
      } else {
        wkIds.push(rootWkId);
      }
    }
  });

  // Pre-check + write document
  if (weekKey) {
    const content = await vault.read(file);
    if (!hasWeekBlock(content, weekKey)) {
      throw new Error("请在文档中创建对应的周区域");
    }

    if (createdWeekIds.length > 0) {
      const month = (await store.getMonth(file))!;
      const batch = createdWeekIds.map((wid) => {
        const task = month.tasks[wid];
        const parentTask = task.parentId ? month.tasks[task.parentId] : undefined;
        return { task, parentTask };
      });
      const latest = await vault.read(file);
      const newContent = insertTaskLinesBatch(latest, batch);
      await vault.modify(file, newContent);
    }
  }

  await recalcGlobalStatus(store, vault, file);
  return createdRootIds;
}

function resolveDaySources(month: MonthTaskData, ids: string[]): TaskRecord[] {
  const emitted = new Set<string>();
  const out: TaskRecord[] = [];

  for (const id of ids) {
    let t = tag(month, id);
    // Follow sourceDayTaskId to the root
    while (t.sourceDayTaskId) {
      t = tag(month, t.sourceDayTaskId);
    }
    // For children, resolve to parent
    if (t.parentId) {
      t = tag(month, t.parentId);
    }

    if (!emitted.has(t.id)) {
      emitted.add(t.id);
      out.push(t);
    }
  }
  return out;
}

// Resolve source tasks for Day chain: the root + direct children (as identities)
function resolveDaySourceTasks(month: MonthTaskData, root: TaskRecord): TaskRecord[] {
  const tasks: TaskRecord[] = [root];
  for (const cid of root.childIds) {
    tasks.push(tag(month, cid));
  }
  return tasks;
}

// Collect all Day IDs on the same chain (root + continuation instances)
function collectDayChainIds(month: MonthTaskData, task: TaskRecord): string[] {
  const ids: string[] = [];
  // Find the root
  let root = task;
  while (root.sourceDayTaskId) {
    root = tag(month, root.sourceDayTaskId);
  }
  ids.push(root.id);
  if (root.daytdayTaskIds) {
    ids.push(...root.daytdayTaskIds);
  }
  return [...new Set(ids)];
}

// ── Section 6: Day continuation ──

export async function continueDayTask(
  store: TaskFlowV2Store,
  vault: Vault,
  file: TFile,
  sourceDayTaskId: string,
  targetDayKey: string,
): Promise<string> {
  // Pre-check: day block must exist
  const content = await vault.read(file);
  if (!hasDayBlock(content, targetDayKey)) {
    throw new Error("请在文档中创建对应的日期区域");
  }

  const createdIds: string[] = [];
  let createdId = "";

  await store.mutate((data) => {
    const month = tagMonth(data, file.path);
    const source = tag(month, sourceDayTaskId);
    if (source.area !== "day") throw new Error("Only day tasks can be continued");
    if (!sameWeek(source.areaKey, targetDayKey)) throw new Error("日任务只能延续到同周内日期");
    const continuationStatuses = source.childIds.length > 0
      ? source.childIds.map((id) => tag(month, id).status)
      : [source.status];
    if (
      continuationStatuses.length === 0
      || continuationStatuses.some((status) => status !== "doing")
    ) {
      throw new Error("只有当前日期下全部处于进行中的任务才能延续");
    }

    const ident = identity(source);

    // Already has same-identity task on target day?
    const existing = findByIdentity(month, ident, targetDayKey);
    if (existing) {
      if (source.childIds.length === 0) {
        throw new Error("该任务已存在于目标日期");
      }
      // Has children: fill in missing children
      fillMissingChildren(month, source, existing, targetDayKey, data, createdIds);
      createdId = existing.id;
      return;
    }

    // Resolve parent FIRST so createdIds has parent before child.
    // This ensures document sync inserts the parent line before the child line.
    let parentIdForInstance: string | null = null;
    if (source.parentId) {
      parentIdForInstance = resolveTargetParent(month, source.parentId, targetDayKey, data, createdIds);
    }

    // Create continuation instance
    createdId = createTaskId(data, "day");
    createdIds.push(createdId);
    const inst = {
      ...newTask(createdId, "day", targetDayKey, source.name),
    };
    month.tasks[createdId] = inst;

    // Wire source relationship
    if (source.sourceWeekTaskId) {
      // Week-sourced: keep sourceWeekTaskId, add to weektdayTaskIds
      inst.sourceWeekTaskId = source.sourceWeekTaskId;
      pushUnique(tag(month, source.sourceWeekTaskId).weektdayTaskIds, createdId);
    } else {
      // Day-sourced: set sourceDayTaskId
      const root = source.sourceDayTaskId ? tag(month, source.sourceDayTaskId) : source;
      inst.sourceDayTaskId = root.id;
      root.daytdayTaskIds ??= [];
      pushUnique(root.daytdayTaskIds, createdId);
    }

    // Children
    if (source.childIds.length > 0) {
      continueChildren(month, source, inst, targetDayKey, data, createdIds);
    }

    // Parent linkage
    if (parentIdForInstance) {
      inst.parentId = parentIdForInstance;
      linkChildToParent(month, inst);
    }

    // Order array
    pushToDayOrder(month, inst, targetDayKey);
  });

  // Write document: insert new continuation tasks
  if (createdIds.length > 0) {
    const month = (await store.getMonth(file))!;
    const batch = createdIds.map((did) => {
      const task = month.tasks[did];
      const parentTask = task.parentId ? month.tasks[task.parentId] : undefined;
      return { task, parentTask };
    });
    const latest = await vault.read(file);
    const newContent = insertTaskLinesBatch(latest, batch);
    await vault.modify(file, newContent);
  }

  await recalcGlobalStatus(store, vault, file);
  return createdId;
}

export async function taskHasContinuedInstance(
  store: TaskFlowV2Store,
  file: TFile,
  sourceDayTaskId: string,
  targetDayKey: string,
): Promise<boolean> {
  const month = await store.getMonth(file);
  if (!month) return false;
  const source = month.tasks[sourceDayTaskId];
  if (!source) return false;
  return !!findByIdentity(month, identity(source), targetDayKey);
}

function fillMissingChildren(
  month: MonthTaskData,
  source: TaskRecord,
  existing: TaskRecord,
  targetDayKey: string,
  data: TaskFlowV2Data,
  createdIds: string[],
): void {
  for (const childId of source.childIds) {
    const child = tag(month, childId);
    const childIdent = identity(child);
    const existChild = findByIdentity(month, childIdent, targetDayKey);
    if (existChild) {
      // Ensure parent link
      if (existChild.parentId !== existing.id) {
        existChild.parentId = existing.id;
      }
      if (!existing.childIds.includes(existChild.id)) {
        existing.childIds.push(existChild.id);
      }
      continue;
    }

    // Create continuation child
    const newCid = createTaskId(data, "day");
    createdIds.push(newCid);
    const nc: TaskRecord = {
      ...newTask(newCid, "day", targetDayKey, child.name),
      parentId: existing.id,
    };
    month.tasks[newCid] = nc;

    if (child.sourceWeekTaskId) {
      nc.sourceWeekTaskId = child.sourceWeekTaskId;
      pushUnique(tag(month, child.sourceWeekTaskId).weektdayTaskIds, newCid);
    } else {
      const root = child.sourceDayTaskId ? tag(month, child.sourceDayTaskId) : child;
      nc.sourceDayTaskId = root.id;
      root.daytdayTaskIds ??= [];
      pushUnique(root.daytdayTaskIds, newCid);
    }

    existing.childIds.push(newCid);
  }
}

function continueChildren(
  month: MonthTaskData,
  source: TaskRecord,
  target: TaskRecord,
  targetDayKey: string,
  data: TaskFlowV2Data,
  createdIds: string[],
): void {
  for (const childId of source.childIds) {
    const child = tag(month, childId);
    const childIdent = identity(child);

    // Skip if already exists on target day (cross-date dedup)
    const existChild = findByIdentity(month, childIdent, targetDayKey);
    if (existChild) {
      existChild.parentId = target.id;
      if (!target.childIds.includes(existChild.id)) {
        target.childIds.push(existChild.id);
      }
      continue;
    }

    const newCid = createTaskId(data, "day");
    createdIds.push(newCid);
    const nc: TaskRecord = {
      ...newTask(newCid, "day", targetDayKey, child.name),
      parentId: target.id,
    };
    month.tasks[newCid] = nc;

    if (child.sourceWeekTaskId) {
      nc.sourceWeekTaskId = child.sourceWeekTaskId;
      pushUnique(tag(month, child.sourceWeekTaskId).weektdayTaskIds, newCid);
    } else {
      const root = child.sourceDayTaskId ? tag(month, child.sourceDayTaskId) : child;
      nc.sourceDayTaskId = root.id;
      root.daytdayTaskIds ??= [];
      pushUnique(root.daytdayTaskIds, newCid);
    }

    target.childIds.push(newCid);
  }
}

function resolveTargetParent(month: MonthTaskData, sourceParentId: string, targetDayKey: string, data: TaskFlowV2Data, createdIds: string[]): string {
  const sp = tag(month, sourceParentId);
  const ident = identity(sp);
  const exist = findByIdentity(month, ident, targetDayKey);
  if (exist) return exist.id;

  // Auto-continue parent to target day
  const pid = createTaskId(data, "day");
  createdIds.push(pid);
  const pInst: TaskRecord = {
    ...newTask(pid, "day", targetDayKey, sp.name),
  };
  month.tasks[pid] = pInst;

  // Copy source relationships
  if (sp.sourceWeekTaskId) {
    pInst.sourceWeekTaskId = sp.sourceWeekTaskId;
    pushUnique(tag(month, sp.sourceWeekTaskId).weektdayTaskIds, pid);
  } else if (sp.sourceDayTaskId) {
    pInst.sourceDayTaskId = sp.sourceDayTaskId;
    const root = tag(month, sp.sourceDayTaskId);
    root.daytdayTaskIds ??= [];
    pushUnique(root.daytdayTaskIds, pid);
  } else {
    // First continuation from original day task
    sp.daytdayTaskIds ??= [];
    pushUnique(sp.daytdayTaskIds, pid);
    pInst.sourceDayTaskId = sp.id;
  }

  pushToDayOrder(month, pInst, targetDayKey);
  return pid;
}

function linkChildToParent(month: MonthTaskData, child: TaskRecord): void {
  const parent = tag(month, child.parentId!);
  if (parent.areaKey === child.areaKey) {
    pushUnique(parent.childIds, child.id);
    addChildToOrderArray(areaIds(month, child.area, child.areaKey), parent.id, child.id);
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
