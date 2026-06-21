import { flattenOrderArray, getDayTaskIds, MonthTaskData, TaskFlowV2Data, TaskRecord } from "../store/v2Schema";

export function tag(month: MonthTaskData, id: string): TaskRecord {
  const task = month.tasks[id];
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

export function tagMonth(data: TaskFlowV2Data, filePath: string): MonthTaskData {
  const month = data.files[filePath];
  if (!month) throw new Error("Month data not found");
  return month;
}

export function pushUnique(list: string[], id: string) {
  if (!list.includes(id)) list.push(id);
}

export function identity(task: TaskRecord): string {
  return task.sourceWeekTaskId ?? task.sourceDayTaskId ?? task.id;
}

export function parseDateKey(k: string): number | null {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(k);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getTime();
}

function monday(ts: number): number {
  const d = new Date(ts);
  const wd = d.getDay();
  d.setDate(d.getDate() + (wd === 0 ? -6 : 1 - wd));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function sameWeek(a: string, b: string): boolean {
  const da = parseDateKey(a);
  const db = parseDateKey(b);
  if (da === null || db === null) return false;
  return monday(da) === monday(db);
}

export function findDayInstance(month: MonthTaskData, sourceWeekTaskId: string, dayKey: string): TaskRecord | undefined {
  return Object.values(month.tasks).find(
    (t) => t.area === "day" && t.areaKey === dayKey && t.sourceWeekTaskId === sourceWeekTaskId,
  );
}

export function findByIdentity(month: MonthTaskData, ident: string, dayKey: string, excludeId?: string): TaskRecord | undefined {
  for (const id of flattenOrderArray(getDayTaskIds(month, dayKey))) {
    const t = month.tasks[id];
    if (t && identity(t) === ident && id !== excludeId) return t;
  }
  return undefined;
}
