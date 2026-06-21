import { computeWeekKey } from "../calendar";
import { parseStoredTaskName } from "../taskTags";
import { createEmptyMonthTaskData, createEmptyTaskFlowV2Data } from "./v2Defaults";
import { createTaskId } from "./v2Id";
import { findOrderItem, getDayTaskIds, MonthTaskData, TaskArea, TaskFlowV2Data, TaskIdNode, TaskOrderItem, TaskRecord, TaskStatus, WeekData } from "./v2Schema";

export function normalizeTaskFlowV2Data(raw: unknown): TaskFlowV2Data {
  if (!isRecord(raw) || raw.version !== 2) {
    return createEmptyTaskFlowV2Data();
  }

  const files: Record<string, MonthTaskData> = {};
  if (isRecord(raw.files)) {
    for (const [path, value] of Object.entries(raw.files)) {
      files[path] = normalizeMonthTaskData(value);
    }
  }

  const normalized: TaskFlowV2Data = {
    version: 2,
    updatedAt: asIsoDate(raw.updatedAt),
    files
  };
  repairMissingWeekParentDayTasks(normalized);
  return normalized;
}

function repairMissingWeekParentDayTasks(data: TaskFlowV2Data): void {
  for (const month of Object.values(data.files)) {
    const groups = new Map<string, {
      areaKey: string;
      sourceParent: TaskRecord;
      children: TaskRecord[];
    }>();

    for (const task of Object.values(month.tasks)) {
      if (task.area !== "day" || !task.sourceWeekTaskId) {
        continue;
      }
      const source = month.tasks[task.sourceWeekTaskId];
      const sourceParent = source?.parentId ? month.tasks[source.parentId] : null;
      if (!sourceParent || sourceParent.area !== "week") {
        continue;
      }
      const key = `${task.areaKey}\u0000${sourceParent.id}`;
      const group = groups.get(key) ?? {
        areaKey: task.areaKey,
        sourceParent,
        children: []
      };
      group.children.push(task);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      let dayParent = Object.values(month.tasks).find(
        (task) => task.area === "day"
          && task.areaKey === group.areaKey
          && task.sourceWeekTaskId === group.sourceParent.id
      );
      if (!dayParent) {
        const id = createTaskId(data, "day");
        dayParent = {
          id,
          area: "day",
          areaKey: group.areaKey,
          name: group.sourceParent.name,
          tags: parseStoredTaskName(group.sourceParent.name).tags,
          status: "todo",
          parentId: null,
          childIds: [],
          sourceWeekTaskId: group.sourceParent.id,
          sourceDayTaskId: null,
          weektdayTaskIds: [],
          daytdayTaskIds: null
        };
        month.tasks[id] = dayParent;
        addUniqueTaskId(group.sourceParent.weektdayTaskIds, id);

        const dayIds = getDayTaskIds(month, group.areaKey);
        const childIndexes = group.children
          .map((child) => findOrderItem(dayIds, child.id))
          .filter((found): found is { item: TaskOrderItem; index: number } => found !== null)
          .map((found) => found.index);
        const insertIndex = childIndexes.length > 0 ? Math.min(...childIndexes) : dayIds.length;
        dayIds.splice(insertIndex, 0, id);
      }

      const childrenBySource = new Map(
        group.children.map((child) => [child.sourceWeekTaskId, child])
      );
      dayParent.childIds = group.sourceParent.childIds
        .map((sourceId) => childrenBySource.get(sourceId))
        .filter((task): task is TaskRecord => Boolean(task))
        .map((task) => task.id);
      for (const child of group.children) {
        child.parentId = dayParent.id;
      }
    }
  }
}

export function normalizeMonthTaskData(raw: unknown): MonthTaskData {
  if (!isRecord(raw)) {
    return createEmptyMonthTaskData();
  }

  const tasks: Record<string, TaskRecord> = {};
  if (isRecord(raw.tasks)) {
    for (const [id, value] of Object.entries(raw.tasks)) {
      const task = normalizeTaskRecord(id, value);
      if (task) {
        tasks[id] = task;
      }
    }
    migrateLegacySourceGroups(raw.tasks, tasks);
    reconcileSourceRelations(tasks);
  }

  return {
    tasks,
    weeks: normalizeWeeks(raw, tasks),
    confirmedTaskLogs: normalizeConfirmedTaskLogs(raw.confirmedTaskLogs)
  };
}

function reconcileSourceRelations(tasks: Record<string, TaskRecord>): void {
  for (const task of Object.values(tasks)) {
    task.weektdayTaskIds = task.weektdayTaskIds.filter((id) => Boolean(tasks[id]));
    task.daytdayTaskIds = task.daytdayTaskIds?.filter((id) => Boolean(tasks[id])) ?? null;
  }

  for (const task of Object.values(tasks)) {
    if (task.area !== "day") {
      continue;
    }
    if (task.sourceWeekTaskId) {
      const sourceWeek = tasks[task.sourceWeekTaskId];
      if (sourceWeek?.area === "week") {
        addUniqueTaskId(sourceWeek.weektdayTaskIds, task.id);
        task.sourceDayTaskId = null;
      } else {
        task.sourceWeekTaskId = null;
      }
      continue;
    }

    if (!task.sourceDayTaskId) {
      continue;
    }
    const root = findRootDayTask(tasks, task);
    if (!root) {
      task.sourceDayTaskId = null;
      continue;
    }
    task.sourceDayTaskId = root.id;
    root.daytdayTaskIds ??= [];
    addUniqueTaskId(root.daytdayTaskIds, task.id);
  }
}

function findRootDayTask(
  tasks: Record<string, TaskRecord>,
  task: TaskRecord
): TaskRecord | null {
  const visited = new Set<string>([task.id]);
  let sourceId = task.sourceDayTaskId;
  let source: TaskRecord | undefined;
  while (sourceId) {
    if (visited.has(sourceId)) {
      return null;
    }
    visited.add(sourceId);
    source = tasks[sourceId];
    if (!source || source.area !== "day" || source.sourceWeekTaskId) {
      return null;
    }
    sourceId = source.sourceDayTaskId;
  }
  return source ?? null;
}

function addUniqueTaskId(taskIds: string[], taskId: string): void {
  if (!taskIds.includes(taskId)) {
    taskIds.push(taskId);
  }
}

function migrateLegacySourceGroups(
  rawTasks: Record<string, unknown>,
  tasks: Record<string, TaskRecord>
): void {
  const groups = new Map<string, TaskRecord[]>();
  for (const [id, rawTask] of Object.entries(rawTasks)) {
    if (!isRecord(rawTask) || typeof rawTask.sourceGroupId !== "string") {
      continue;
    }
    const task = tasks[id];
    if (!task || task.area !== "day" || task.sourceDayTaskId) {
      continue;
    }
    const group = groups.get(rawTask.sourceGroupId) ?? [];
    group.push(task);
    groups.set(rawTask.sourceGroupId, group);
  }

  for (const group of groups.values()) {
    group.sort((left, right) =>
      left.areaKey.localeCompare(right.areaKey) || left.id.localeCompare(right.id)
    );
    const root = group[0];
    root.sourceDayTaskId = null;
    root.daytdayTaskIds = group.slice(1).map((task) => task.id);
    for (let index = 1; index < group.length; index += 1) {
      group[index].sourceDayTaskId = root.id;
      group[index].daytdayTaskIds = null;
    }
  }
}

function normalizeTaskRecord(id: string, raw: unknown): TaskRecord | null {
  if (!isRecord(raw) || typeof raw.name !== "string") {
    return null;
  }

  const area = isTaskArea(raw.area) ? raw.area : null;
  if (!area || typeof raw.areaKey !== "string") {
    return null;
  }

  return {
    id,
    area,
    areaKey: raw.areaKey,
    name: raw.name,
    tags: parseStoredTaskName(raw.name).tags,
    status: isTaskStatus(raw.status) ? raw.status : "todo",
    parentId: typeof raw.parentId === "string" ? raw.parentId : null,
    childIds: stringArray(raw.childIds),
    sourceWeekTaskId: typeof raw.sourceWeekTaskId === "string" ? raw.sourceWeekTaskId : null,
    sourceDayTaskId: typeof raw.sourceDayTaskId === "string" ? raw.sourceDayTaskId : null,
    weektdayTaskIds: stringArray(raw.weektdayTaskIds ?? raw.weekToDayTaskIds),
    daytdayTaskIds: normalizeOptionalTaskIds(raw.daytdayTaskIds ?? raw.dayToDayTaskIds)
  };
}

function normalizeConfirmedTaskLogs(raw: unknown): { taskIds: string[] } {
  return {
    taskIds: isRecord(raw) ? stringArray(raw.taskIds) : []
  };
}

function normalizeOptionalTaskIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  return stringArray(raw);
}

function normalizeWeeks(
  raw: Record<string, unknown>,
  tasks: Record<string, TaskRecord>
): Record<string, WeekData> {
  const weeks: Record<string, WeekData> = {};

  function ensureWeekEntry(wk: string): WeekData {
    if (!weeks[wk]) {
      weeks[wk] = { weekTaskIds: [], days: {} };
    }
    return weeks[wk];
  }

  function ensureDayEntry(wk: string, dk: string): void {
    const week = ensureWeekEntry(wk);
    if (!week.days[dk]) {
      week.days[dk] = { dayTaskIds: [] };
    }
  }

  // 1. Read new-format raw.weeks — the authoritative source for ordering
  if (isRecord(raw.weeks)) {
    readNewFormatWeeks(raw.weeks, tasks, weeks, ensureWeekEntry, ensureDayEntry);
  }

  // 2. Migrate old format: raw.weekTaskIds (flat { [weekKey]: string[] })
  if (isRecord(raw.weekTaskIds)) {
    migrateOldWeekTaskIds(raw.weekTaskIds, tasks, weeks, ensureWeekEntry);
  }

  // 3. Migrate old format: raw.dayTaskIds (flat { [dayKey]: string[] })
  if (isRecord(raw.dayTaskIds)) {
    migrateOldDayTaskIds(raw.dayTaskIds, tasks, weeks, ensureDayEntry);
  }

  // 4. Backfill roots that appear in tasks but not in any order array
  backfillMissingRoots(tasks, weeks, ensureWeekEntry, ensureDayEntry);

  return weeks;
}

function readNewFormatWeeks(
  rawWeeks: Record<string, unknown>,
  tasks: Record<string, TaskRecord>,
  weeks: Record<string, WeekData>,
  ensureWeekEntry: (wk: string) => WeekData,
  ensureDayEntry: (wk: string, dk: string) => void
): void {
  for (const [weekKey, weekValue] of Object.entries(rawWeeks)) {
    if (!isRecord(weekValue)) continue;
    const week = ensureWeekEntry(weekKey);

    if (Array.isArray(weekValue.weekTaskIds)) {
      for (const item of weekValue.weekTaskIds) {
        const converted = convertOrderItem(item, tasks);
        if (converted) week.weekTaskIds.push(converted);
      }
    }

    if (isRecord(weekValue.days)) {
      for (const [dayKey, dayValue] of Object.entries(weekValue.days)) {
        if (!isRecord(dayValue) || !Array.isArray(dayValue.dayTaskIds)) continue;
        ensureDayEntry(weekKey, dayKey);
        for (const item of dayValue.dayTaskIds) {
          const converted = convertOrderItem(item, tasks);
          if (converted) weeks[weekKey].days[dayKey].dayTaskIds.push(converted);
        }
      }
    }
  }
}

function convertOrderItem(item: unknown, tasks: Record<string, TaskRecord>): TaskOrderItem | null {
  if (typeof item === "string" && tasks[item]) {
    return item;
  }
  if (isRecord(item) && typeof item.id === "string" && tasks[item.id]) {
    const childIds = Array.isArray(item.childIds)
      ? item.childIds.filter((cid: unknown) => typeof cid === "string" && Boolean(tasks[cid]))
      : [];
    return childIds.length > 0 ? { id: item.id, childIds } : item.id;
  }
  return null;
}

function migrateOldWeekTaskIds(
  rawWeekTaskIds: Record<string, unknown>,
  tasks: Record<string, TaskRecord>,
  weeks: Record<string, WeekData>,
  ensureWeekEntry: (wk: string) => WeekData
): void {
  for (const [weekKey, value] of Object.entries(rawWeekTaskIds)) {
    const ids = stringArray(value).filter((id) => tasks[id]?.area === "week");
    const week = ensureWeekEntry(weekKey);
    migrateFlatIdsToStructured(ids, tasks, week.weekTaskIds);
  }
}

function migrateOldDayTaskIds(
  rawDayTaskIds: Record<string, unknown>,
  tasks: Record<string, TaskRecord>,
  weeks: Record<string, WeekData>,
  ensureDayEntry: (wk: string, dk: string) => void
): void {
  for (const [dayKey, value] of Object.entries(rawDayTaskIds)) {
    const ids = stringArray(value).filter((id) => tasks[id]?.area === "day");
    const weekKey = computeWeekKey(dayKey);
    ensureDayEntry(weekKey, dayKey);
    migrateFlatIdsToStructured(ids, tasks, weeks[weekKey].days[dayKey].dayTaskIds);
  }
}

function migrateFlatIdsToStructured(
  ids: string[],
  tasks: Record<string, TaskRecord>,
  target: TaskOrderItem[]
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const task = tasks[id];
    if (!task || task.parentId) continue;
    seen.add(id);
    if (task.childIds.length > 0) {
      const validChildren = task.childIds.filter((cid) => tasks[cid]);
      for (const cid of validChildren) seen.add(cid);
      if (!target.some((item) => typeof item !== "string" && item.id === id)) {
        target.push({ id, childIds: validChildren });
      }
    } else {
      if (!target.includes(id)) target.push(id);
    }
  }
}

function backfillMissingRoots(
  tasks: Record<string, TaskRecord>,
  weeks: Record<string, WeekData>,
  ensureWeekEntry: (wk: string) => WeekData,
  ensureDayEntry: (wk: string, dk: string) => void
): void {
  // Collect already-covered IDs
  const coveredWeekIds = new Set<string>();
  const coveredDayIds = new Map<string, Set<string>>();
  for (const week of Object.values(weeks)) {
    for (const item of week.weekTaskIds) {
      if (typeof item === "string") coveredWeekIds.add(item);
      else { coveredWeekIds.add(item.id); for (const cid of item.childIds) coveredWeekIds.add(cid); }
    }
    for (const [dayKey, day] of Object.entries(week.days)) {
      const set = coveredDayIds.get(dayKey) ?? new Set<string>();
      for (const item of day.dayTaskIds) {
        if (typeof item === "string") set.add(item);
        else { set.add(item.id); for (const cid of item.childIds) set.add(cid); }
      }
      coveredDayIds.set(dayKey, set);
    }
  }

  for (const task of Object.values(tasks)) {
    if (task.area === "week" && !coveredWeekIds.has(task.id) && task.parentId === null) {
      const week = ensureWeekEntry(task.areaKey);
      week.weekTaskIds.push(
        task.childIds.length > 0 ? { id: task.id, childIds: [...task.childIds] } : task.id
      );
    } else if (task.area === "day" && task.parentId === null) {
      const dayCovered = coveredDayIds.get(task.areaKey);
      if (!dayCovered?.has(task.id)) {
        const weekKey = computeWeekKey(task.areaKey);
        ensureDayEntry(weekKey, task.areaKey);
        weeks[weekKey].days[task.areaKey].dayTaskIds.push(
          task.childIds.length > 0 ? { id: task.id, childIds: [...task.childIds] } : task.id
        );
      }
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asIsoDate(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return new Date(0).toISOString();
  }
  return value;
}

function isTaskArea(value: unknown): value is TaskArea {
  return value === "week" || value === "day";
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "todo" || value === "doing" || value === "done";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
