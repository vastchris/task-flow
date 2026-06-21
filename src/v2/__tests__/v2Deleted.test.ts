import * as assert from "node:assert/strict";
import type { Vault } from "obsidian";
import {
  deleteTask,
  deleteTasks,
  deleteProjectionDescendants,
  getDeletionPreview,
  getBatchDeletionPreview,
  getDeletionTasklogIds,
} from "../structure/v2Deleted";
import {
  addWeekTaskToDay,
  addWeekTasksToDay,
  continueDayTask,
  createChildTask,
  createTopLevelTask,
} from "../structure/v2Created";
import {
  flattenOrderArray,
  getDayTaskIds,
  getWeekTaskIds,
  TaskFlowV2Data,
} from "../store/v2Schema";
import { TaskFlowV2Store } from "../store/v2Store";
import { changeDayTaskStatus } from "../structure/v2Status";

void run();

async function run(): Promise<void> {
  let diskData: unknown = null;
  const fakePlugin = {
    async loadData(): Promise<unknown> {
      return structuredClone(diskData);
    },
    async saveData(data: TaskFlowV2Data): Promise<void> {
      diskData = structuredClone(data);
    },
  };
  const store = new TaskFlowV2Store(fakePlugin as never);
  const filePath = "notes/2026.6.md";
  const file = { path: filePath } as never;
  const weekKey = "2026.6.1-6.7";

  const initialVaultContent = `%% week:2026.6.1-6.7 %%
%% week end %%
%% day:2026.6.1 %%
%% day end %%
%% day:2026.6.2 %%
%% day end %%
%% day:2026.6.3 %%
%% day end %%
%% day:2026.6.4 %%
%% day end %%
%% day:2026.6.5 %%
%% day end %%
%% day:2026.6.6 %%
%% day end %%
%% day:2026.6.7 %%
%% day end %%`;
  let vaultContent = initialVaultContent;
  const vault = {
    read: async (_f: unknown) => vaultContent,
    modify: async (_f: unknown, c: string) => { vaultContent = c; },
  } as unknown as Vault;

  async function continueDoingTask(sourceId: string, targetDayKey: string): Promise<string> {
    await store.mutate((data) => {
      const month = data.files[filePath];
      const source = month.tasks[sourceId];
      const ids = source.childIds.length > 0 ? source.childIds : [sourceId];
      for (const id of ids) month.tasks[id].status = "doing";
    });
    return continueDayTask(store, vault, file, sourceId, targetDayKey);
  }

  function getMonth(): NonNullable<TaskFlowV2Data["files"][string]> {
    return (diskData as TaskFlowV2Data).files[filePath];
  }

  function resetVault(): void {
    vaultContent = initialVaultContent;
  }

  await store.load();
  await store.ensureMonth(file);

  // ── Section 1: tasklog conflict detection ──
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "有记录任务");
    vaultContent += `\ntasklog:: ${taskId}\n`;
    const conflicts = getDeletionTasklogIds(getMonth(), [taskId], vaultContent);
    assert.deepEqual(conflicts, [taskId]);
  }

  // ── Section 2.1: Week 父任务删除 ──
  {
    resetVault();
    // Create a Week parent with child, arrange to Day
    const parentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    const childId = await createChildTask(store, vault, file, parentId, "Week子");
    await addWeekTaskToDay(store, vault, file, parentId, "2026.6.3");

    let month = getMonth();
    const preview = getDeletionPreview(month, parentId);
    assert.equal(preview.level, "cross_area");
    assert.ok(preview.dayInstances.length > 0);
    assert.ok(preview.childNames.length > 0);
    assert.ok(preview.totalCount > 1);

    await deleteTask(store, vault, file, parentId);
    month = getMonth();
    // Parent, child, and Day instances all gone
    assert.equal(month.tasks[parentId], undefined);
    assert.equal(month.tasks[childId], undefined);
    // No orphan references
    for (const task of Object.values(month.tasks)) {
      assert.ok(!task.childIds.includes(parentId));
      assert.ok(!task.childIds.includes(childId));
      assert.ok(!task.weektdayTaskIds.includes(parentId));
      assert.ok(!task.weektdayTaskIds.includes(childId));
    }
    // Document sync: lines removed
    assert.equal(vaultContent.includes(`^${parentId}`), false);
    assert.equal(vaultContent.includes(`^${childId}`), false);
  }

  // ── Section 2.2: Week 子任务删除 ──
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    const childId = await createChildTask(store, vault, file, parentId, "Week子");
    const child2Id = await createChildTask(store, vault, file, parentId, "Week子2");

    await deleteTask(store, vault, file, childId);
    const month = getMonth();
    assert.equal(month.tasks[childId], undefined);
    // Parent survives
    assert.ok(month.tasks[parentId]);
    assert.deepEqual(month.tasks[parentId].childIds, [child2Id]);
    // Sibling survives
    assert.ok(month.tasks[child2Id]);
  }

  // ── Section 2.3: Week 独立任务删除 ──
  {
    resetVault();
    const indId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week独立");

    await deleteTask(store, vault, file, indId);
    const month = getMonth();
    assert.equal(month.tasks[indId], undefined);
    const weekIds = flattenOrderArray(getWeekTaskIds(month, weekKey));
    assert.ok(!weekIds.includes(indId));
  }

  // ── Section 3.1: Week来源 Day父实例删除 ──
  {
    resetVault();
    const wkParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    const wkChildId = await createChildTask(store, vault, file, wkParentId, "Week子");
    const dayParentId = await addWeekTaskToDay(store, vault, file, wkParentId, "2026.6.3");

    let month = getMonth();
    // Find Day child instance ID
    const dayChildId = month.tasks[dayParentId].childIds[0];
    assert.ok(dayChildId);
    await changeDayTaskStatus(store, vault, file, dayChildId, "doing");
    month = getMonth();
    assert.equal(month.tasks[wkChildId].status, "doing");
    assert.equal(month.tasks[wkParentId].status, "doing");

    await deleteTask(store, vault, file, dayParentId);
    month = getMonth();
    // Day parent + child instances deleted
    assert.equal(month.tasks[dayParentId], undefined);
    assert.equal(month.tasks[dayChildId], undefined);
    // Week source survives
    assert.ok(month.tasks[wkParentId]);
    assert.ok(month.tasks[wkChildId]);
    assert.equal(month.tasks[wkChildId].status, "todo");
    assert.equal(month.tasks[wkParentId].status, "todo");
    // Week source's weektdayTaskIds cleaned
    assert.ok(!month.tasks[wkParentId].weektdayTaskIds.includes(dayParentId));
    assert.ok(!month.tasks[wkParentId].weektdayTaskIds.includes(dayChildId));
  }

  // ── Section 3.2: Week来源 Day子实例删除 ──
  {
    resetVault();
    const wkParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    await createChildTask(store, vault, file, wkParentId, "Week子");
    const dayParentId = await addWeekTaskToDay(store, vault, file, wkParentId, "2026.6.3");
    let month = getMonth();
    const dayChildId = month.tasks[dayParentId].childIds[0];

    await deleteTask(store, vault, file, dayChildId);
    month = getMonth();
    // Day child deleted, Day parent empty → auto-deleted (Section 5 row 2)
    assert.equal(month.tasks[dayChildId], undefined);
    assert.equal(month.tasks[dayParentId], undefined);
    // Week source survives
    assert.ok(month.tasks[wkParentId]);
  }

  // ── Section 3.3: Week来源 Day独立实例删除 ──
  {
    resetVault();
    const wkIndId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week独立");
    const dayInstId = await addWeekTaskToDay(store, vault, file, wkIndId, "2026.6.3");

    let month = getMonth();
    assert.ok(month.tasks[dayInstId]);
    await changeDayTaskStatus(store, vault, file, dayInstId, "doing");
    assert.equal(getMonth().tasks[wkIndId].status, "doing");

    await deleteTask(store, vault, file, dayInstId);
    month = getMonth();
    assert.equal(month.tasks[dayInstId], undefined);
    // Week source survives
    assert.ok(month.tasks[wkIndId]);
    assert.equal(month.tasks[wkIndId].status, "todo");
    assert.ok(!month.tasks[wkIndId].weektdayTaskIds.includes(dayInstId));
    assert.match(vaultContent, new RegExp(`- \\[ \\].*\\^${wkIndId}`));
  }

  // ── Section 3.4: Day直接创建父任务删除 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "Day父");
    const dayChildId = await createChildTask(store, vault, file, dayParentId, "Day子");

    const preview = getDeletionPreview(getMonth(), dayParentId);
    assert.equal(preview.level, "parent_cascade");
    assert.equal(preview.childNames.length, 1);

    await deleteTask(store, vault, file, dayParentId);
    const month = getMonth();
    assert.equal(month.tasks[dayParentId], undefined);
    assert.equal(month.tasks[dayChildId], undefined);
    // Order array cleaned
    const dayIds = flattenOrderArray(getDayTaskIds(month, "2026.6.4"));
    assert.ok(!dayIds.includes(dayParentId));
  }

  // ── Section 3.5: Day直接创建子任务删除 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "Day父");
    const dayChildId = await createChildTask(store, vault, file, dayParentId, "Day子");

    await deleteTask(store, vault, file, dayChildId);
    const month = getMonth();
    assert.equal(month.tasks[dayChildId], undefined);
    // Parent survives, becomes independent (Section 5 row 3)
    assert.ok(month.tasks[dayParentId]);
    assert.deepEqual(month.tasks[dayParentId].childIds, []);
  }

  // ── Section 3.6: Day直接创建独立任务删除 ──
  {
    resetVault();
    const dayIndId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "Day独立");

    await deleteTask(store, vault, file, dayIndId);
    const month = getMonth();
    assert.equal(month.tasks[dayIndId], undefined);
  }

  // ── Section 3.7.1: 延续根父任务删除 ──
  {
    resetVault();
    // Simple continuation root: parent has continuations, NO children
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "延续根父");

    // Continue parent to later dates
    const cont1Id = await continueDoingTask(dayParentId, "2026.6.4");
    const cont2Id = await continueDoingTask(dayParentId, "2026.6.6");

    let month = getMonth();
    const rootTask = month.tasks[dayParentId];
    assert.ok(rootTask.daytdayTaskIds);
    assert.equal(rootTask.daytdayTaskIds!.length, 2);
    assert.equal(rootTask.sourceDayTaskId, null);

    const preview = getDeletionPreview(month, dayParentId);
    assert.equal(preview.level, "root_continuation");
    assert.ok(preview.continuationInfo);

    await deleteTask(store, vault, file, dayParentId);
    month = getMonth();
    // Root deleted
    assert.equal(month.tasks[dayParentId], undefined);
    // cont1 (earliest) promoted to new root
    assert.ok(month.tasks[cont1Id]);
    assert.equal(month.tasks[cont1Id].sourceDayTaskId, null);
    assert.deepEqual(month.tasks[cont1Id].daytdayTaskIds, [cont2Id]);
    // cont2 still references cont1
    assert.equal(month.tasks[cont2Id].sourceDayTaskId, cont1Id);
  }

  // ── Section 3.7.1b: 延续根父任务含子删除 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "延续根父");
    const childId = await createChildTask(store, vault, file, dayParentId, "子");
    // Continue parent twice
    const cont1Id = await continueDoingTask(dayParentId, "2026.6.4");
    const cont2Id = await continueDoingTask(dayParentId, "2026.6.6");

    let month = getMonth();
    assert.ok(month.tasks[childId].daytdayTaskIds); // child was auto-continued

    await deleteTask(store, vault, file, dayParentId);
    month = getMonth();
    // Root and child deleted
    assert.equal(month.tasks[dayParentId], undefined);
    assert.equal(month.tasks[childId], undefined);
    // cont1 promoted to root
    assert.ok(month.tasks[cont1Id]);
    assert.equal(month.tasks[cont1Id].sourceDayTaskId, null);
    // cont1's childIds should contain the promoted child
    assert.ok(month.tasks[cont1Id].childIds.length > 0, "promoted parent should have promoted children");
  }

  // ── Section 3.7.2: 延续根子任务删除 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "延续根父");
    const childId = await createChildTask(store, vault, file, dayParentId, "子");

    // Continue child to a later date
    const childContId = await continueDoingTask(childId, "2026.6.4");

    let month = getMonth();
    const rootChild = month.tasks[childId];
    assert.ok(rootChild.daytdayTaskIds);
    assert.equal(rootChild.daytdayTaskIds!.length, 1);

    const preview = getDeletionPreview(month, childId);
    assert.equal(preview.level, "root_continuation");

    await deleteTask(store, vault, file, childId);
    month = getMonth();
    // Root child deleted
    assert.equal(month.tasks[childId], undefined);
    // Continuation promoted to new root
    assert.ok(month.tasks[childContId]);
    assert.equal(month.tasks[childContId].sourceDayTaskId, null);
    assert.equal(month.tasks[childContId].parentId, dayParentId);
    // Parent's childIds updated
    assert.ok(month.tasks[dayParentId].childIds.includes(childContId));
    assert.ok(!month.tasks[dayParentId].childIds.includes(childId));
  }

  // ── Section 3.8.1: 延续父实例删除 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "根父");
    await createChildTask(store, vault, file, dayParentId, "子");
    const cont1Id = await continueDoingTask(dayParentId, "2026.6.4");

    let month = getMonth();
    const cont1ChildId = month.tasks[cont1Id].childIds[0];

    // Delete the continuation instance
    await deleteTask(store, vault, file, cont1Id);
    month = getMonth();
    assert.equal(month.tasks[cont1Id], undefined);
    if (cont1ChildId) {
      assert.equal(month.tasks[cont1ChildId], undefined);
    }
    // Root survives
    assert.ok(month.tasks[dayParentId]);
    // Root's daytdayTaskIds cleaned
    assert.ok(!(month.tasks[dayParentId].daytdayTaskIds ?? []).includes(cont1Id));
  }

  // ── Section 3.8.2: 延续子实例删除 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "根父");
    const childId = await createChildTask(store, vault, file, dayParentId, "子");
    const childContId = await continueDoingTask(childId, "2026.6.4");

    let month = getMonth();
    const contParent = month.tasks[childContId];
    assert.ok(!contParent.sourceWeekTaskId); // Day created, no week source

    await deleteTask(store, vault, file, childContId);
    month = getMonth();
    assert.equal(month.tasks[childContId], undefined);
    // Root child survives
    assert.ok(month.tasks[childId]);
    // Root's daytdayTaskIds cleaned
    assert.ok(!(month.tasks[childId].daytdayTaskIds ?? []).includes(childContId));
  }

  // ── Empty parent: Week来源 Day父实例变空 → 自动删除 ──
  {
    resetVault();
    const wkParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    const wkChildId = await createChildTask(store, vault, file, wkParentId, "Week子");
    const dayParentId = await addWeekTaskToDay(store, vault, file, wkParentId, "2026.6.3");
    let month = getMonth();
    const dayChildId = month.tasks[dayParentId].childIds[0];

    // Delete Day child → Day parent should be auto-deleted
    await deleteTask(store, vault, file, dayChildId);
    month = getMonth();
    assert.equal(month.tasks[dayChildId], undefined);
    assert.equal(month.tasks[dayParentId], undefined);
    // Week source survives
    assert.ok(month.tasks[wkParentId]);
    assert.ok(month.tasks[wkChildId]);
  }

  // ── Empty parent: Day创建父任务变空 → 保留为独立任务 ──
  {
    resetVault();
    const dayParentId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "Day父");
    const dayChildId = await createChildTask(store, vault, file, dayParentId, "Day子");

    await deleteTask(store, vault, file, dayChildId);
    const month = getMonth();
    assert.ok(month.tasks[dayParentId]);
    assert.deepEqual(month.tasks[dayParentId].childIds, []);
    // Still in dayTaskIds (as string, not TaskIdNode)
    const dayIds = getDayTaskIds(month, "2026.6.4");
    const found = dayIds.find((item) =>
      (typeof item === "string" && item === dayParentId) ||
      (typeof item !== "string" && item.id === dayParentId && item.childIds.length === 0)
    );
    assert.ok(found);
  }

  // ── Batch delete ──
  {
    resetVault();
    const id1 = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "任务A");
    const id2 = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "任务B");
    const id3 = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "任务C");

    const month = getMonth();
    const preview = getBatchDeletionPreview(month, [id1, id2, id3]);
    assert.equal(preview.level, "simple");
    assert.equal(preview.totalCount, 3);

    await deleteTasks(store, vault, file, [id1, id2, id3]);
    const month2 = getMonth();
    assert.equal(month2.tasks[id1], undefined);
    assert.equal(month2.tasks[id2], undefined);
    assert.equal(month2.tasks[id3], undefined);
  }

  // ── deleteProjectionDescendants ──
  {
    resetVault();
    const wkParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    await createChildTask(store, vault, file, wkParentId, "Week子");

    // Arrange to Day (this creates Day instances)
    await addWeekTaskToDay(store, vault, file, wkParentId, "2026.6.3");

    // The Day instances have the Week parent as sourceWeekTaskId
    let month = getMonth();
    const dayParentId = month.tasks[wkParentId].weektdayTaskIds.find(
      (did) => month.tasks[did] && month.tasks[did].childIds.length > 0
    );
    assert.ok(dayParentId, "should have a Day parent instance");

    // Delete projection descendants — delete Day children but not the Day parent
    await deleteProjectionDescendants(store, vault, file, dayParentId!, "2026.6.3");
    month = getMonth();
    // Day parent's children should be gone
    const updatedDayParent = month.tasks[dayParentId!];
    if (updatedDayParent) {
      assert.equal(updatedDayParent.childIds.length, 0);
    }
  }

  // ── Invariants check ──
  {
    resetVault();
    const wkParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week父");
    const wkChildId = await createChildTask(store, vault, file, wkParentId, "Week子");
    await addWeekTaskToDay(store, vault, file, wkParentId, "2026.6.3");
    await addWeekTaskToDay(store, vault, file, wkParentId, "2026.6.5");

    await deleteTask(store, vault, file, wkParentId);
    const month = getMonth();

    // All invariants: nothing references deleted IDs
    for (const task of Object.values(month.tasks)) {
      assert.ok(task.id !== wkParentId);
      assert.ok(task.id !== wkChildId);
      assert.ok(!task.childIds.includes(wkParentId));
      assert.ok(!task.childIds.includes(wkChildId));
      assert.ok(!task.weektdayTaskIds.includes(wkParentId));
      assert.ok(!task.weektdayTaskIds.includes(wkChildId));
      assert.ok(task.sourceWeekTaskId !== wkParentId);
      assert.ok(task.sourceWeekTaskId !== wkChildId);
      assert.ok(task.sourceDayTaskId !== wkParentId);
      assert.ok(task.sourceDayTaskId !== wkChildId);
      assert.ok(task.parentId !== wkParentId);
      assert.ok(task.parentId !== wkChildId);
    }

    // Order arrays clean
    for (const week of Object.values(month.weeks)) {
      const allWeekIds = flattenOrderArray(week.weekTaskIds);
      assert.ok(!allWeekIds.includes(wkParentId));
      assert.ok(!allWeekIds.includes(wkChildId));
      for (const day of Object.values(week.days)) {
        const allDayIds = flattenOrderArray(day.dayTaskIds);
        assert.ok(!allDayIds.includes(wkParentId));
        assert.ok(!allDayIds.includes(wkChildId));
      }
    }
  }

  // ── Missing task throws ──
  {
    await assert.rejects(
      () => deleteTask(store, vault, file, "tf-w-99999"),
      /不存在/
    );
  }

  console.log("v2Deleted.test.ts: all tests passed");
}
