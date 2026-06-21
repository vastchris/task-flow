export interface MonthlyFile {
  year: number;
  month: number;
}

export function parseMonthlyFileName(fileName: string): MonthlyFile | null {
  const match = /^(\d{4})\.(\d{1,2})\.md$/.exec(fileName);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return null;
  }

  return { year, month };
}
