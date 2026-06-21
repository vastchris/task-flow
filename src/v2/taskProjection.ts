import { CalendarWeek } from "./calendar";
import { flattenOrderArray, getDayTaskIds, MonthTaskData, TaskOrderItem, TaskRecord, TaskStatus, TaskTags } from "./store/v2Schema";
import { formatTaskInputForEdit, getTaskDisplayName, parseStoredTaskName } from "./taskTags";
import { hasSpecialMark } from "./structure/v2Status";
import { buildParentTaskSummary } from "./structure/v2TaskGroups";
import { parseDateKey } from "./structure/v2Helpers";

export interface DisplayTask {
  id: string;
  actionTaskId?: string;
  name: string;
  editName?: string;
  tags?: TaskTags;
  status: TaskStatus;
  special?: boolean;
  children?: DisplayTask[];
  isNewDayTask?: boolean;
  sourceHint?: string;
  sourceContextId?: string;
  isSourceGroup?: boolean;
  isDateGroup?: boolean;
  hasWeekSource?: boolean;
  isParentContext?: boolean;
  isWeekParent?: boolean;
  arrangementLabel?: string;
  legacyDateLabel?: string;
  progress?: TaskProgress;
  sourceLabel?: string;
}

export interface TaskProgress {
  completed: number;
  total: number;
  items: TaskProgressItem[];
}

export interface TaskProgressItem {
  id: string;
  name: string;
  status: TaskStatus;
  latestDayKey?: string;
  otherDayKeys: string[];
}

export type WeekTaskViewMode = "pending" | "all";

export interface PriorUnfinishedSection {
  id: "doing" | "todo";
  title: string;
  tasks: DisplayTask[];
}

export function buildWeekTaskTree(
  month: MonthTaskData,
  orderItems: TaskOrderItem[],
  mode: WeekTaskViewMode
): DisplayTask[] {
  const visibleIds = new Set(flattenOrderArray(orderItems));

  return orderItems
    .map((item) => {
      const id = typeof item === "string" ? item : item.id;
      const task = month.tasks[id];
      if (!task) return null;
      return toWeekDisplayTask(month, task, visibleIds, mode);
    })
    .filter((task): task is DisplayTask => Boolean(task));
}

export function buildTaskTree(month: MonthTaskData, orderItems: TaskOrderItem[]): DisplayTask[] {
  const visibleIds = new Set(flattenOrderArray(orderItems));

  return orderItems
    .map((item) => {
      if (typeof item === "string") {
        const task = month.tasks[item];
        if (!task) return null;
        return toDisplayTask(month, task, visibleIds);
      }
      // TaskIdNode — parent with children
      const task = month.tasks[item.id];
      if (!task) return null;
      return {
        ...toDisplayTask(month, task, visibleIds),
        children: item.childIds
          .map((cid) => month.tasks[cid])
          .filter((child): child is TaskRecord => Boolean(child) && visibleIds.has(child.id))
          .map((child) => toDisplayTask(month, child, visibleIds))
      };
    })
    .filter((task): task is DisplayTask => Boolean(task));
}

export function groupSourceContexts(tasks: DisplayTask[]): DisplayTask[] {
  const emitted = new Set<string>();
  return tasks.flatMap((task) => {
    const contextId = task.sourceContextId;
    if (!contextId) {
      return [task];
    }
    if (emitted.has(contextId)) {
      return [];
    }

    emitted.add(contextId);
    const groupedTasks = tasks
      .filter((candidate) => candidate.sourceContextId === contextId)
      .map((candidate) => ({
        ...candidate,
        sourceHint: undefined,
        sourceContextId: undefined
      }));

    return [{
      id: `source-group:${contextId}`,
      actionTaskId: groupedTasks[0]?.id,
      name: task.sourceHint ?? "",
      status: "todo" as TaskStatus,
      isParentContext: true,
      hasWeekSource: true,
      isWeekParent: true,
      children: groupedTasks
    }];
  });
}

export function buildUnfinishedTasks(
  month: MonthTaskData,
  selectedWeek: CalendarWeek,
  selectedDayKey: string
): DisplayTask[] {
  const selectedIndex = selectedWeek.days.findIndex((day) => day.key === selectedDayKey);
  if (selectedIndex <= 0) {
    return [];
  }

  return selectedWeek.days.slice(0, selectedIndex).flatMap((day) => {
    const tasks = groupSourceContexts(
      buildTaskTree(month, getDayTaskIds(month, day.key))
        .filter((task) => task.status !== "done")
        .map((task) => ({
          ...task,
          isNewDayTask: false
        }))
    );
    if (tasks.length === 0) {
      return [];
    }

    return [{
      id: `date-group:${day.key}`,
      name: `${day.date.getMonth() + 1}.${day.date.getDate()}`,
      status: "todo" as TaskStatus,
      isDateGroup: true,
      children: tasks
    }];
  });
}

export function buildPriorUnfinishedSections(
  month: MonthTaskData,
  selectedWeek: CalendarWeek,
  selectedDayKey: string
): PriorUnfinishedSection[] {
  const selectedIndex = selectedWeek.days.findIndex((day) => day.key === selectedDayKey);
  if (selectedIndex <= 0) {
    return [];
  }

  const currentIdentities = new Set(
    flattenOrderArray(getDayTaskIds(month, selectedDayKey))
      .map((id) => month.tasks[id])
      .filter((task): task is TaskRecord => Boolean(task))
      .map((task) => taskIdentity(task))
  );
  const priorDayKeys = new Set(selectedWeek.days.slice(0, selectedIndex).map((day) => day.key));
  const rootEntries = selectedWeek.days.slice(0, selectedIndex).flatMap((day) =>
    flattenOrderArray(getDayTaskIds(month, day.key))
      .map((id) => month.tasks[id])
      .filter((task): task is TaskRecord => Boolean(task)
        && task.area === "day"
        && task.areaKey === day.key
        && task.parentId === null)
      .map((task) => buildPriorRootEntry(month, task, priorDayKeys, currentIdentities))
      .filter((entry): entry is PriorRootEntry => Boolean(entry))
  );

  const doingTasks = rootEntries
    .flatMap((entry) => entry.doingTask ? [entry.doingTask] : [])
    .sort(comparePriorDisplayTasks);
  const todoTasks = rootEntries
    .flatMap((entry) => entry.todoTask ? [entry.todoTask] : [])
    .sort(comparePriorDisplayTasks);
  const sections: PriorUnfinishedSection[] = [];
  if (doingTasks.length > 0) {
    sections.push({ id: "doing", title: "进行中", tasks: doingTasks });
  }
  if (todoTasks.length > 0) {
    sections.push({ id: "todo", title: "未开始", tasks: todoTasks });
  }
  return sections;
}

function toDisplayTask(
  month: MonthTaskData,
  task: TaskRecord,
  visibleIds: Set<string>
): DisplayTask {
  const sourceContext = task.parentId === null ? getSourceContext(month, task) : undefined;
  const progress = task.parentId === null && task.childIds.length > 0
    ? buildParentProgress(month, task)
    : undefined;
  return {
    id: task.id,
    actionTaskId: task.id,
    name: getTaskDisplayName(task.name),
    editName: formatTaskInputForEdit(task.name),
    tags: task.tags ?? parseStoredTaskName(task.name).tags,
    status: task.status,
    special: task.area === "day" && task.childIds.length === 0 ? hasSpecialMark(month, task.id) : undefined,
    isNewDayTask: task.area === "day" && task.sourceWeekTaskId === null,
    sourceHint: sourceContext?.name,
    sourceContextId: sourceContext?.id,
    hasWeekSource: task.sourceWeekTaskId !== null,
    isWeekParent: task.area === "day"
      && task.sourceWeekTaskId !== null
      && task.childIds.some((id) => visibleIds.has(id)),
    progress,
    children: task.childIds
      .map((id) => month.tasks[id])
      .filter((child): child is TaskRecord => Boolean(child) && visibleIds.has(child.id))
      .map((child) => toDisplayTask(month, child, visibleIds))
  };
}

interface PriorRootEntry {
  doingTask?: DisplayTask;
  todoTask?: DisplayTask;
}

function buildPriorRootEntry(
  month: MonthTaskData,
  root: TaskRecord,
  priorDayKeys: Set<string>,
  currentIdentities: Set<string>
): PriorRootEntry | null {
  const visibleChildren = root.childIds
    .map((id) => month.tasks[id])
    .filter((child): child is TaskRecord => Boolean(child)
      && child.area === "day"
      && priorDayKeys.has(child.areaKey)
      && child.status !== "done"
      && !currentIdentities.has(taskIdentity(child)));

  if (root.childIds.length > 0) {
    const doingChildren = visibleChildren.filter((child) => child.status === "doing");
    const todoChildren = visibleChildren.filter((child) => child.status === "todo");
    return {
      doingTask: doingChildren.length > 0
        ? toPriorParentTask(month, root, doingChildren, false)
        : undefined,
      todoTask: todoChildren.length > 0
        ? toPriorParentTask(month, root, todoChildren, true)
        : undefined
    };
  }

  if (root.status === "done" || currentIdentities.has(taskIdentity(root))) {
    return null;
  }
  const displayTask = toPriorLeafTask(month, root, root.status === "todo");
  return root.status === "doing"
    ? { doingTask: displayTask }
    : { todoTask: displayTask };
}

function toPriorParentTask(
  month: MonthTaskData,
  root: TaskRecord,
  children: TaskRecord[],
  showLegacyDate: boolean
): DisplayTask {
  const childDisplays = children
    .map((child) => toPriorLeafTask(month, child, showLegacyDate))
    .sort(comparePriorDisplayTasks);
  return {
    id: `prior-parent:${root.id}:${showLegacyDate ? "todo" : "doing"}`,
    actionTaskId: root.id,
    name: getTaskDisplayName(root.name),
    editName: formatTaskInputForEdit(root.name),
    tags: root.tags ?? parseStoredTaskName(root.name).tags,
    status: root.status,
    isNewDayTask: !root.sourceWeekTaskId,
    hasWeekSource: root.sourceWeekTaskId !== null,
    sourceLabel: root.sourceWeekTaskId ? "来自周任务" : "来自日任务",
    legacyDateLabel: closestLegacyDate(childDisplays),
    children: childDisplays
  };
}

function toPriorLeafTask(
  month: MonthTaskData,
  task: TaskRecord,
  showLegacyDate: boolean
): DisplayTask {
  const sourceContext = task.parentId === null ? getSourceContext(month, task) : undefined;
  return {
    id: task.id,
    actionTaskId: task.id,
    name: getTaskDisplayName(task.name),
    editName: formatTaskInputForEdit(task.name),
    tags: task.tags ?? parseStoredTaskName(task.name).tags,
    status: task.status,
    isNewDayTask: !task.sourceWeekTaskId,
    sourceHint: sourceContext?.name,
    sourceContextId: sourceContext?.id,
    hasWeekSource: task.sourceWeekTaskId !== null,
    sourceLabel: task.parentId === null
      ? task.sourceWeekTaskId ? "来自周任务" : "来自日任务"
      : undefined,
    legacyDateLabel: showLegacyDate ? `${formatLegacyDate(task.areaKey)}遗留` : undefined
  };
}

function comparePriorDisplayTasks(left: DisplayTask, right: DisplayTask): number {
  const leftHasChildren = (left.children?.length ?? 0) > 0;
  const rightHasChildren = (right.children?.length ?? 0) > 0;
  if (leftHasChildren !== rightHasChildren) {
    return leftHasChildren ? -1 : 1;
  }
  const dateDiff = parseDateLabel(right.legacyDateLabel) - parseDateLabel(left.legacyDateLabel);
  if (dateDiff !== 0) {
    return dateDiff;
  }
  return left.name.localeCompare(right.name);
}

function closestLegacyDate(tasks: DisplayTask[]): string | undefined {
  const labels = tasks
    .map((task) => task.legacyDateLabel)
    .filter((label): label is string => Boolean(label));
  if (labels.length === 0) {
    return undefined;
  }
  return labels.sort((left, right) => parseDateLabel(right) - parseDateLabel(left))[0];
}

function taskIdentity(task: TaskRecord): string {
  return task.sourceWeekTaskId ?? task.sourceDayTaskId ?? task.id;
}

function formatLegacyDate(dayKey: string): string {
  const match = /^\d{4}\.(\d{1,2})\.(\d{1,2})$/.exec(dayKey);
  return match ? `${match[1]}.${match[2]}` : dayKey;
}

function parseDateLabel(label: string | undefined): number {
  if (!label) {
    return Number.NEGATIVE_INFINITY;
  }
  const match = /(\d{1,2})\.(\d{1,2})/.exec(label);
  if (!match) {
    return Number.NEGATIVE_INFINITY;
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

function toWeekDisplayTask(
  month: MonthTaskData,
  task: TaskRecord,
  visibleIds: Set<string>,
  mode: WeekTaskViewMode
): DisplayTask | null {
  const visibleChildren = task.childIds
    .map((id) => month.tasks[id])
    .filter((child): child is TaskRecord => Boolean(child) && visibleIds.has(child.id));
  const children = visibleChildren
    .map((child) => toWeekDisplayTask(month, child, visibleIds, mode))
    .filter((child): child is DisplayTask => Boolean(child));
  const hasChildren = visibleChildren.length > 0;

  if (mode === "pending") {
    if (hasChildren) {
      if (children.length === 0) {
        return null;
      }
      return {
        id: task.id,
        actionTaskId: task.id,
        name: getTaskDisplayName(task.name),
        editName: formatTaskInputForEdit(task.name),
        tags: task.tags ?? parseStoredTaskName(task.name).tags,
        status: task.status,
        progress: buildParentProgress(month, task),
        children
      };
    }
    if (task.weektdayTaskIds.length > 0) {
      return null;
    }
  }

  return {
    id: task.id,
    actionTaskId: task.id,
    name: getTaskDisplayName(task.name),
    editName: formatTaskInputForEdit(task.name),
    tags: task.tags ?? parseStoredTaskName(task.name).tags,
    status: task.status,
    arrangementLabel: mode === "all" ? buildArrangementLabel(month, task) : undefined,
    progress: hasChildren ? buildParentProgress(month, task) : undefined,
    children: visibleChildren.map((child) => toWeekDisplayTask(month, child, visibleIds, "all")!)
  };
}

function buildArrangementLabel(month: MonthTaskData, task: TaskRecord): string {
  const dayKeys = task.weektdayTaskIds
    .map((id) => month.tasks[id]?.areaKey)
    .filter((key): key is string => Boolean(key));
  if (dayKeys.length === 0) {
    return "未安排";
  }
  return [...new Set(dayKeys)].join("、");
}

function buildParentProgress(month: MonthTaskData, parent: TaskRecord): TaskProgress | undefined {
  const summary = buildParentTaskSummary(month, parent);
  if (!summary) return undefined;

  return {
    completed: summary.completed,
    total: summary.total,
    items: summary.groups.map((group) => {
      const dayKeys = [...new Set(
        group.instances
          .filter((instance) => instance.area === "day")
          .map((instance) => instance.areaKey),
      )].sort((left, right) => (
        (parseDateKey(left) ?? 0) - (parseDateKey(right) ?? 0)
      ));
      const latestDayKey = group.latestInstance.area === "day"
        ? group.latestInstance.areaKey
        : undefined;
      return {
        id: group.key,
        name: group.name,
        status: group.status,
        latestDayKey,
        otherDayKeys: latestDayKey
          ? dayKeys.filter((dayKey) => dayKey !== latestDayKey)
          : [],
      };
    }),
  };
}

function getSourceContext(
  month: MonthTaskData,
  task: TaskRecord
): { id: string; name: string } | undefined {
  if (!task.sourceWeekTaskId) {
    return undefined;
  }

  const source = month.tasks[task.sourceWeekTaskId];
  if (!source || source.id === task.id) {
    return undefined;
  }
  const parent = source.parentId ? month.tasks[source.parentId] : null;
  return parent ? { id: parent.id, name: parent.name } : undefined;
}
