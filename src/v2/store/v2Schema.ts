import { computeWeekKey } from "../calendar";

export type TaskStatus = "todo" | "doing" | "done";
export type TaskArea = "week" | "day";

export interface TaskTags {
  primary: string | null;
  secondary: string | null;
}

export interface TaskRecord {
  id: string;
  area: TaskArea;
  areaKey: string;
  name: string;
  tags?: TaskTags;
  status: TaskStatus;
  parentId: string | null;
  childIds: string[];
  sourceWeekTaskId: string | null;
  sourceDayTaskId: string | null;
  weektdayTaskIds: string[];
  daytdayTaskIds: string[] | null;
}

export interface TaskIdNode {
  id: string;
  childIds: string[];
}

/** 列表项：叶子任务是纯 ID 字符串，有子任务的是 TaskIdNode 对象 */
export type TaskOrderItem = string | TaskIdNode;

export interface WeekData {
  weekTaskIds: TaskOrderItem[];
  days: Record<string, DayData>;
}

export interface DayData {
  dayTaskIds: TaskOrderItem[];
}

export interface MonthTaskData {
  tasks: Record<string, TaskRecord>;
  weeks: Record<string, WeekData>;
  confirmedTaskLogs: {
    taskIds: string[];
  };
}

export interface TaskFlowV2Data {
  version: 2;
  updatedAt: string;
  files: Record<string, MonthTaskData>;
}

// ── Accessor helpers ──

export function ensureWeek(month: MonthTaskData, weekKey: string): WeekData {
  if (!month.weeks[weekKey]) {
    month.weeks[weekKey] = { weekTaskIds: [], days: {} };
  }
  return month.weeks[weekKey];
}

export function getWeekTaskIds(month: MonthTaskData, weekKey: string): TaskOrderItem[] {
  return ensureWeek(month, weekKey).weekTaskIds;
}

export function ensureDay(month: MonthTaskData, dayKey: string): DayData {
  const weekKey = computeWeekKey(dayKey);
  const week = ensureWeek(month, weekKey);
  if (!week.days[dayKey]) {
    week.days[dayKey] = { dayTaskIds: [] };
  }
  return week.days[dayKey];
}

export function getDayTaskIds(month: MonthTaskData, dayKey: string): TaskOrderItem[] {
  return ensureDay(month, dayKey).dayTaskIds;
}

/** 将 TaskOrderItem[] 展平为纯 ID 列表（遍历用） */
export function flattenOrderArray(items: TaskOrderItem[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      result.push(item);
    } else {
      result.push(item.id);
      result.push(...item.childIds);
    }
  }
  return result;
}

/** 在 TaskOrderItem[] 中按 ID 查找，返回 { item, index } 或 null */
export function findOrderItem(
  items: TaskOrderItem[],
  id: string
): { item: TaskOrderItem; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === "string") {
      if (item === id) return { item, index: i };
    } else {
      if (item.id === id) return { item, index: i };
    }
  }
  return null;
}

/** 在 TaskOrderItem[] 中按 ID 移除（从字符串匹配或从 TaskIdNode.childIds 中移除）。
 *  如果 TaskIdNode 的 childIds 变空，降级为纯字符串。 */
export function removeFromOrderArray(items: TaskOrderItem[], id: string): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === "string") {
      if (item === id) {
        items.splice(i, 1);
        return true;
      }
    } else {
      const childIdx = item.childIds.indexOf(id);
      if (childIdx >= 0) {
        item.childIds.splice(childIdx, 1);
        return true;
      }
      if (item.id === id) {
        items.splice(i, 1);
        return true;
      }
    }
  }
  return false;
}

/** 将子任务 ID 添加到父任务在顺序数组中的条目。
 *  如果父任务当前是字符串则升级为 TaskIdNode。 */
export function addChildToOrderArray(items: TaskOrderItem[], parentId: string, childId: string): void {
  const found = findOrderItem(items, parentId);
  if (!found) {
    items.push({ id: parentId, childIds: [childId] });
    return;
  }
  if (typeof found.item === "string") {
    items[found.index] = { id: parentId, childIds: [childId] };
  } else if (!found.item.childIds.includes(childId)) {
    found.item.childIds.push(childId);
  }
}
