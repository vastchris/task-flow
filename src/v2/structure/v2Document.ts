import { TaskOrderItem, TaskRecord, TaskStatus } from "../store/v2Schema";

// ── Block detection ──

export function hasWeekBlock(content: string, weekKey: string): boolean {
  return weekBlockRe(weekKey).test(content);
}

export function hasDayBlock(content: string, dayKey: string): boolean {
  return dayBlockRe(dayKey).test(content);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function weekBlockRe(weekKey: string): RegExp {
  return new RegExp(`%%\\s*week:\\s*${escapeRe(weekKey)}\\s*%%`);
}

function dayBlockRe(dayKey: string): RegExp {
  return new RegExp(`%%\\s*day:\\s*${escapeRe(dayKey)}\\s*%%`);
}

// ── Task line building ──

function taskLine(task: TaskRecord): string {
  const statusMark = task.status === "done" ? "[x]" : task.status === "doing" ? "[/]" : "[ ]";
  return `- ${statusMark} ${task.name} ^${task.id}`;
}

function indentLine(line: string): string {
  return `\t${line}`;
}

function taskDocumentBlock(task: TaskRecord): string {
  return taskLine(task);
}

function indentBlock(block: string): string {
  return block.split("\n").map(indentLine).join("\n");
}

// ── Insertion ──

/** Insert a single task line into the appropriate block.
 *  For child tasks, `parentTask` provides the parent's TaskRecord for name/ID lookup. */
export function insertTaskLine(
  content: string,
  task: TaskRecord,
  parentTask?: TaskRecord,
): string {
  if (task.area === "week") {
    return insertInWeekBlock(content, task, parentTask);
  }
  return insertInDayBlock(content, task, parentTask);
}

function insertInWeekBlock(content: string, task: TaskRecord, parentTask?: TaskRecord): string {
  const endRe = /%%\s*week\s+end\s*%%/;
  const blockRe = weekBlockRe(task.areaKey);

  if (parentTask) {
    return insertChildLine(content, parentTask, task);
  }
  return insertBeforeMarker(content, blockRe, endRe, taskDocumentBlock(task));
}

function insertInDayBlock(content: string, task: TaskRecord, parentTask?: TaskRecord): string {
  const endRe = /%%\s*day\s+end\s*%%/;
  const blockRe = dayBlockRe(task.areaKey);

  if (parentTask) {
    return insertChildLine(content, parentTask, task);
  }
  return insertBeforeMarker(content, blockRe, endRe, taskDocumentBlock(task));
}

/** Insert a child line after the last existing sibling (or after the parent). */
function insertChildLine(content: string, parent: TaskRecord, child: TaskRecord): string {
  // Collect IDs to find: parent + existing siblings (exclude the new child itself)
  const siblingIds = parent.childIds.filter((id) => id !== child.id);
  const allIds = [parent.id, ...siblingIds];

  let lastMatchIdx = -1;
  let lastMatchLen = 0;

  for (const id of allIds) {
    const pattern = new RegExp(`\\^${escapeRe(id)}\\b`, "gm");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match.index > lastMatchIdx) {
        lastMatchIdx = match.index;
        lastMatchLen = match[0].length;
      }
    }
  }

  if (lastMatchIdx < 0) return content;

  const afterMatchIdx = lastMatchIdx + lastMatchLen;
  let endOfLine = content.indexOf("\n", afterMatchIdx);
  if (endOfLine === -1) endOfLine = content.length;

  return `${content.slice(0, endOfLine + 1)}${indentBlock(taskDocumentBlock(child))}\n${content.slice(endOfLine + 1)}`;
}

/** Insert `line` before the first match of `endRe` that appears after a match of `blockRe`. */
function insertBeforeMarker(
  content: string,
  blockRe: RegExp,
  endRe: RegExp,
  block: string,
): string {
  const blockMatch = blockRe.exec(content);
  if (!blockMatch) return content;

  endRe.lastIndex = 0;
  const endMatch = endRe.exec(content.slice(blockMatch.index));
  if (!endMatch) return content;

  const endIdx = blockMatch.index + endMatch.index;
  const lineStart = content.lastIndexOf("\n", endIdx);
  const before = lineStart >= 0 ? content.slice(0, lineStart) : "";
  const after = content.slice(lineStart);

  return `${before}\n${block}${after}`;
}

/** Insert `line` after the line that matches `idPattern`. */
function insertAfterLine(content: string, idPattern: string, line: string): string {
  const pattern = new RegExp(`\\^${escapeRe(idPattern)}\\b`, "m");
  const match = pattern.exec(content);
  if (!match) return content;

  const afterMatchIdx = match.index + match[0].length;
  let endOfLine = content.indexOf("\n", afterMatchIdx);
  if (endOfLine === -1) endOfLine = content.length;

  return `${content.slice(0, endOfLine + 1)}${line}\n${content.slice(endOfLine + 1)}`;
}

// ── Batch insert ──

/** Insert multiple tasks (with optional parent relationships) into the same block. */
export function insertTaskLinesBatch(
  content: string,
  tasks: Array<{ task: TaskRecord; parentTask?: TaskRecord }>,
): string {
  let result = content;
  for (const { task, parentTask } of tasks) {
    result = insertTaskLine(result, task, parentTask);
  }
  return result;
}

// ── Tasklog scanning ──

const TASKLOG_RE = /tasklog::\s*(tf-d-\d+)/g;

export function findTasklog(content: string): Set<string> {
  const ids = new Set<string>();
  for (const m of content.matchAll(TASKLOG_RE)) {
    ids.add(m[1]);
  }
  return ids;
}

/** Check if a specific Day task has a tasklog binding in the document. */
export function taskHasTasklog(content: string, taskId: string): boolean {
  return findTasklog(content).has(taskId);
}

// ── Task line removal ──

/** Remove a single task line (and any indented child lines) from the document by task ID. */
export function removeTaskLine(content: string, taskId: string): string {
  const pattern = new RegExp(`\\^${escapeRe(taskId)}\\b`, "gm");
  const match = pattern.exec(content);
  if (!match) return content;

  // Find start of line
  const lineStart = content.lastIndexOf("\n", match.index);
  const beforeLine = lineStart >= 0 ? content.slice(0, lineStart) : "";

  // Find end of line
  let lineEnd = content.indexOf("\n", match.index);
  if (lineEnd === -1) lineEnd = content.length;

  // Remove indented children too
  let endOfBlock = lineEnd;
  const lines = content.slice(lineEnd + 1).split("\n");
  for (const line of lines) {
    if (line.startsWith("  ") || line.startsWith("\t")) {
      endOfBlock = endOfBlock + 1 + line.length;
    } else {
      break;
    }
  }

  const afterBlock = content.slice(endOfBlock + 1);
  // Preserve the newline separator: if both sides exist, keep one newline between them
  if (beforeLine.length > 0 && afterBlock.length > 0) {
    return `${beforeLine}\n${afterBlock}`;
  }
  return beforeLine || afterBlock;
}

/** Remove all task lines for the given scope from the document. */
export function removeTaskLinesBatch(content: string, scope: Set<string>): string {
  let result = content;
  // Sort IDs by position in document (last first) to preserve positions
  const positioned: Array<{ id: string; pos: number }> = [];
  for (const id of scope) {
    const pattern = new RegExp(`\\^${escapeRe(id)}\\b`, "gm");
    const match = pattern.exec(result);
    if (match) {
      positioned.push({ id, pos: match.index });
    }
  }
  // Remove last first to preserve earlier positions
  positioned.sort((a, b) => b.pos - a.pos);

  for (const { id } of positioned) {
    result = removeTaskLine(result, id);
  }
  return result;
}

/** Convert tasklog binding to removed state. */
export function orphanTasklog(content: string, taskId: string): string {
  const pattern = new RegExp(`tasklog::\\s*${escapeRe(taskId)}`, "g");
  return content.replace(pattern, `tasklog-removed:: ${taskId}`);
}

// ── Rename ──

/** Replace the name portion of a task line identified by ^taskId. */
export function renameTaskLine(content: string, taskId: string, newName: string): string {
  const idPattern = new RegExp(`\\^${escapeRe(taskId)}\\b`, "gm");
  const match = idPattern.exec(content);
  if (!match) return content;

  const lineStart = content.lastIndexOf("\n", match.index - 1) + 1;
  const lineEndIdx = content.indexOf("\n", match.index);
  const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
  const line = content.slice(lineStart, lineEnd);

  const statusMatch = /^(\s*-\s*\[[ x\/]\]\s+)(.*?)(\s*\^\S+)\s*$/.exec(line);
  if (!statusMatch) return content;

  const before = content.slice(0, lineStart + statusMatch[1].length);
  const after = content.slice(lineStart + statusMatch[1].length + statusMatch[2].length);
  return `${before}${newName}${after}`;
}

/** Replace the standard Markdown heading immediately above a tasklog binding. */
export function renameTasklogHeading(content: string, taskId: string, newTitle: string): string {
  const tasklogRe = new RegExp(`^\\s*tasklog::\\s*${escapeRe(taskId)}\\b.*$`);
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    if (!tasklogRe.test(lines[i])) {
      continue;
    }
    const headingMatch = /^(\s*#{1,6}\s+).*$/.exec(lines[i - 1]);
    if (!headingMatch) {
      continue;
    }
    lines[i - 1] = `${headingMatch[1]}${newTitle}`;
  }
  return lines.join("\n");
}

// ── Reorder ──

/** Rebuild an entire week/day block's task lines from the order array. */
export function reorderTaskLines(
  content: string,
  areaKey: string,
  area: "week" | "day",
  orderItems: TaskOrderItem[],
  tasks: Record<string, TaskRecord>,
): string {
  const blockRe = area === "week" ? weekBlockRe(areaKey) : dayBlockRe(areaKey);
  const endRe = area === "week" ? /%%\s*week\s+end\s*%%/ : /%%\s*day\s+end\s*%%/;

  const blockMatch = blockRe.exec(content);
  if (!blockMatch) return content;

  const headerLineEnd = content.indexOf("\n", blockMatch.index) + 1;

  endRe.lastIndex = 0;
  const endMatch = endRe.exec(content.slice(blockMatch.index));
  if (!endMatch) return content;

  const blockEnd = blockMatch.index + endMatch.index;
  const before = content.slice(0, headerLineEnd);
  const after = content.slice(blockEnd);

  const lines: string[] = [];
  for (const item of orderItems) {
    if (typeof item === "string") {
      const task = tasks[item];
      if (task) lines.push(taskDocumentBlock(task));
    } else {
      const task = tasks[item.id];
      if (task) {
        lines.push(taskDocumentBlock(task));
        for (const childId of item.childIds) {
          const child = tasks[childId];
          if (child) lines.push(indentBlock(taskDocumentBlock(child)));
        }
      }
    }
  }

  return `${before}${lines.join("\n")}\n${after}`;
}

// ── Tasklog-aware removal ──

/** Remove a task line plus its tasklog binding (if any). */
export function removeTaskWithTasklog(content: string, taskId: string): string {
  let result = removeTaskLine(content, taskId);
  const tasklogPattern = new RegExp(`^.*tasklog::\\s*${escapeRe(taskId)}\\s*$\\n?`, "gm");
  result = result.replace(tasklogPattern, "");
  return result;
}

// ── Status mark update ──

const STATUS_MARK: Record<TaskStatus, string> = {
  todo: "[ ]",
  doing: "[/]",
  done: "[x]",
};

/** Replace the status mark on a task line identified by ^taskId. */
export function updateStatusMark(content: string, taskId: string, newStatus: TaskStatus, special?: boolean): string {
  const idPattern = new RegExp(`\\^${escapeRe(taskId)}\\b`, "gm");
  const match = idPattern.exec(content);
  if (!match) return content;

  const lineStart = content.lastIndexOf("\n", match.index - 1) + 1;
  const lineEndIdx = content.indexOf("\n", match.index);
  const lineEnd = lineEndIdx === -1 ? content.length : lineEndIdx;
  const line = content.slice(lineStart, lineEnd);

  const mark = STATUS_MARK[newStatus] + (special ? " ✅" : "");
  const newLine = line.replace(/^(\s*-\s*)\[([ x\/])\]( ✅)?/, `$1${mark}`);
  if (newLine === line) return content;

  return `${content.slice(0, lineStart)}${newLine}${content.slice(lineEnd)}`;
}
