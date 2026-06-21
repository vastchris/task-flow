import { MonthlyFile } from "./monthlyFile";

export interface CalendarDay {
  key: string;
  shortLabel: string;
  date: Date;
}

export interface CalendarWeek {
  key: string;
  label: string;
  days: CalendarDay[];
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export function buildMonthWeeks(month: MonthlyFile): CalendarWeek[] {
  const firstDay = new Date(month.year, month.month - 1, 1);
  const lastDay = new Date(month.year, month.month, 0);
  const weeks: CalendarWeek[] = [];

  let cursor = startOfMondayWeek(firstDay);
  while (cursor <= lastDay) {
    const start = cloneDate(cursor);
    const end = addDays(start, 6);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = addDays(start, index);
      return {
        key: formatDateKey(date),
        shortLabel: `${date.getMonth() + 1}.${date.getDate()} ${WEEKDAY_LABELS[date.getDay()]}`,
        date
      };
    });

    weeks.push({
      key: `${formatDateKey(start)}-${formatShortDate(end)}`,
      label: `${formatShortDate(start)}-${formatShortDate(end)}`,
      days
    });
    cursor = addDays(cursor, 7);
  }

  return weeks;
}

function startOfMondayWeek(date: Date): Date {
  const weekday = date.getDay();
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

function addDays(date: Date, amount: number): Date {
  const result = cloneDate(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function cloneDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatDateKey(date: Date): string {
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
}

export function computeWeekKey(dayKey: string): string {
  const [year, month, day] = dayKey.split(".").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = date.getDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(year, month - 1, day + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return `${formatDateKey(monday)}-${formatShortDate(sunday)}`;
}

function formatShortDate(date: Date): string {
  return `${date.getMonth() + 1}.${date.getDate()}`;
}
