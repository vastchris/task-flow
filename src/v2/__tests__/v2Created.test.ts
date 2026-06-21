import * as assert from "node:assert/strict";
import type { Vault } from "obsidian";
import {
  addDayTaskToWeek,
  addDayTasksToWeek,
  addWeekTaskToDay,
  addWeekTasksToDay,
  continueDayTask,
  createChildTask,
  createTopLevelTask,
  taskHasContinuedInstance,
} from "../structure/v2Created";
import { findOrderItem, flattenOrderArray, getDayTaskIds, getWeekTaskIds, MonthTaskData, TaskFlowV2Data } from "../store/v2Schema";
import { TaskFlowV2Store } from "../store/v2Store";

void run();

async function run(): Promise<void> {
  let diskData: unknown = null;
  const fakePlugin = {
    async loadData(): Promise<unknown> {
      return structuredClone(diskData);
    },
    async saveData(data: TaskFlowV2Data): Promise<void> {
      diskData = structuredClone(data);
    }
  };
  const store = new TaskFlowV2Store(fakePlugin as never);
  const filePath = "notes/2026.6.md";
  const file = { path: filePath } as never;
  const weekKey = "2026.6.1-6.7";

  // Mock vault with all needed blocks (including cross-week test dates)
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
%% day end %%
%% day:2026.6.9 %%
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

  await store.load();
  await store.ensureMonth(file);

  // ── 2.1 Week top-level create ──
  const weekParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week parent");
  let month = getMonth(diskData, filePath);
  assert.equal(month.tasks[weekParentId].area, "week");
  assert.equal(month.tasks[weekParentId].areaKey, weekKey);
  assert.equal(month.tasks[weekParentId].name, "Week parent");
  assert.equal(month.tasks[weekParentId].parentId, null);
  assert.deepEqual(month.tasks[weekParentId].childIds, []);
  assert.ok(flattenOrderArray(getWeekTaskIds(month, weekKey)).includes(weekParentId));

  // ── 3.1 Week parent → child ──
  const weekChildId = await createChildTask(store, vault, file, weekParentId, "Child A");
  month = getMonth(diskData, filePath);
  // Verify document content: child indented below parent
  const docAfterChild = vaultContent;
  const parentLineIdx = docAfterChild.indexOf(`^${weekParentId}`);
  const childLineIdx = docAfterChild.indexOf(`^${weekChildId}`);
  assert.ok(parentLineIdx >= 0, "parent line should exist in document");
  assert.ok(childLineIdx >= 0, "child line should exist in document");
  assert.ok(childLineIdx > parentLineIdx, "child must appear after parent in document");
  const childLineStart = docAfterChild.lastIndexOf("\n", childLineIdx);
  assert.ok(docAfterChild.slice(childLineStart, childLineIdx).startsWith("\n\t-"), "child line must be indented");
  assert.deepEqual(month.tasks[weekParentId].childIds, [weekChildId]);
  assert.equal(month.tasks[weekChildId].parentId, weekParentId);
  assert.equal(month.tasks[weekChildId].area, "week");
  assert.equal(month.tasks[weekChildId].areaKey, weekKey);
  const parentNode = findOrderItem(getWeekTaskIds(month, weekKey), weekParentId);
  assert.ok(parentNode && typeof parentNode.item === "object");
  assert.deepEqual((parentNode.item as { id: string; childIds: string[] }).childIds, [weekChildId]);

  // Same-name child under same parent → distinct IDs
  const sameNameChildId = await createChildTask(store, vault, file, weekParentId, "Child A");
  assert.notEqual(sameNameChildId, weekChildId);
  // Verify document ordering: child2 must appear after child1 (not reverse)
  {
    const doc2 = vaultContent;
    const c1 = doc2.indexOf(`^${weekChildId}`);
    const c2 = doc2.indexOf(`^${sameNameChildId}`);
    assert.ok(c1 < c2, "second child must appear after first child in document");
  }

  // ── 3.1 Week child → reject 3-level ──
  await assert.rejects(
    () => createChildTask(store, vault, file, weekChildId, "Third level"),
    /one child level/i
  );

  // ── 4.1 Week parent arrange to Day ──
  const dayParentId = await addWeekTaskToDay(store, vault, file, weekParentId, "2026.6.2");
  month = getMonth(diskData, filePath);
  const dayParent = month.tasks[dayParentId];
  assert.equal(dayParent.sourceWeekTaskId, weekParentId);
  assert.equal(dayParent.area, "day");
  assert.equal(dayParent.areaKey, "2026.6.2");
  assert.equal(dayParent.childIds.length, 2); // both children auto-arranged
  const dayChild1Id = dayParent.childIds[0];
  const dayChild2Id = dayParent.childIds[1];
  const dayChild1 = month.tasks[dayChild1Id];
  const dayChild2 = month.tasks[dayChild2Id];
  assert.equal(dayChild1.sourceWeekTaskId, weekChildId);
  assert.equal(dayChild2.sourceWeekTaskId, sameNameChildId);
  assert.equal(dayChild1.parentId, dayParentId);
  assert.equal(dayChild2.parentId, dayParentId);
  // Week source weektdayTaskIds updated
  assert.ok(month.tasks[weekParentId].weektdayTaskIds.includes(dayParentId));
  assert.ok(month.tasks[weekChildId].weektdayTaskIds.includes(dayChild1Id));
  assert.ok(month.tasks[sameNameChildId].weektdayTaskIds.includes(dayChild2Id));
  // Day order
  const day2Order = flattenOrderArray(getDayTaskIds(month, "2026.6.2"));
  assert.ok(day2Order.includes(dayParentId));
  assert.ok(day2Order.includes(dayChild1Id));
  assert.ok(day2Order.includes(dayChild2Id));

  // ── 4.4 Same parent to same day again → reuse parent instance ──
  const newWeekChildId = await createChildTask(store, vault, file, weekParentId, "Child C");
  await addWeekTaskToDay(store, vault, file, newWeekChildId, "2026.6.2");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[dayParentId].childIds.length, 3); // child added, parent reused

  // ── 4.5 Same task to different days → independent instances ──
  const dayParent2Id = await addWeekTaskToDay(store, vault, file, weekParentId, "2026.6.3");
  month = getMonth(diskData, filePath);
  assert.ok(month.tasks[dayParent2Id]);
  assert.notEqual(dayParent2Id, dayParentId);
  assert.equal(month.tasks[weekParentId].weektdayTaskIds.length, 2);

  // ── 4.2 Week child alone → parent auto-follows ──
  const pendingWeekChildId = await createChildTask(store, vault, file, weekParentId, "Child D");
  const partialDayParentId = await addWeekTaskToDay(store, vault, file, pendingWeekChildId, "2026.6.4");
  month = getMonth(diskData, filePath);
  const partialDayParent = month.tasks[partialDayParentId];
  assert.equal(partialDayParent.sourceWeekTaskId, weekParentId);
  // Only the arranged child appears; unarranged siblings do not.
  assert.equal(partialDayParent.childIds.length, 1);
  const pendingDayChildId = partialDayParent.childIds[0];
  assert.equal(month.tasks[pendingDayChildId].sourceWeekTaskId, pendingWeekChildId);
  assert.equal(month.tasks[pendingDayChildId].parentId, partialDayParentId);

  // ── 4.3 Week independent arrange ──
  const weekIndependentId = await createTopLevelTask(store, vault, file, "week", weekKey, "Independent Week");
  const dayIndepId = await addWeekTaskToDay(store, vault, file, weekIndependentId, "2026.6.4");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[dayIndepId].sourceWeekTaskId, weekIndependentId);
  assert.equal(month.tasks[dayIndepId].parentId, null);
  assert.deepEqual(month.tasks[dayIndepId].childIds, []);
  assert.ok(month.tasks[weekIndependentId].weektdayTaskIds.includes(dayIndepId));

  // ── 4.7 Batch arrange ──
  const batchWeekId1 = await createTopLevelTask(store, vault, file, "week", weekKey, "Batch 1");
  const batchWeekId2 = await createTopLevelTask(store, vault, file, "week", weekKey, "Batch 2");
  const batchResults = await addWeekTasksToDay(store, vault, file, [batchWeekId1, batchWeekId2], "2026.6.5");
  assert.equal(batchResults.length, 2);

  // ── 4.8 Cross-week rejection ──
  await assert.rejects(
    () => addWeekTaskToDay(store, vault, file, batchWeekId1, "2026.6.9"),
    /same week/
  );

  // ── 4.6 Duplicate skip ──
  await assert.rejects(
    () => addWeekTaskToDay(store, vault, file, weekIndependentId, "2026.6.4"),
    /已全部存在/
  );

  // ── 2.2 Day top-level create ──
  const dayRootId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "Day root");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[dayRootId].area, "day");
  assert.equal(month.tasks[dayRootId].areaKey, "2026.6.1");
  assert.ok(flattenOrderArray(getDayTaskIds(month, "2026.6.1")).includes(dayRootId));

  // ── 3.2 Day parent → child ──
  const dayChildId = await createChildTask(store, vault, file, dayRootId, "Day child");
  month = getMonth(diskData, filePath);
  // Verify day child document position
  const dayDoc = vaultContent;
  const dayParentIdx = dayDoc.indexOf(`^${dayRootId}`);
  const dayChildIdx = dayDoc.indexOf(`^${dayChildId}`);
  assert.ok(dayParentIdx >= 0, "day parent line should exist in document");
  assert.ok(dayChildIdx >= 0, "day child line should exist in document");
  assert.ok(dayChildIdx > dayParentIdx, "day child must appear after parent");
  assert.ok(dayDoc.slice(dayDoc.lastIndexOf("\n", dayChildIdx), dayChildIdx).startsWith("\n\t-"), "day child must be indented");
  assert.deepEqual(month.tasks[dayRootId].childIds, [dayChildId]);
  assert.equal(month.tasks[dayChildId].parentId, dayRootId);
  assert.equal(month.tasks[dayChildId].area, "day");
  assert.equal(month.tasks[dayChildId].areaKey, "2026.6.1");

  // ── 6.1 Day parent continue ──
  const continuedRootId = await continueDoingTask(dayRootId, "2026.6.4");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[continuedRootId].sourceDayTaskId, dayRootId);
  assert.equal(month.tasks[continuedRootId].areaKey, "2026.6.4");
  assert.equal(month.tasks[continuedRootId].childIds.length, 1);
  assert.deepEqual(month.tasks[dayRootId].daytdayTaskIds, [continuedRootId]);
  const continuedChildViaParent = month.tasks[month.tasks[continuedRootId].childIds[0]];
  assert.equal(continuedChildViaParent.sourceDayTaskId, dayChildId);
  assert.equal(continuedChildViaParent.parentId, continuedRootId);

  // ── 6.2 Day child alone continue → parent auto-follows ──
  const dayRoot2Id = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "Day root 2");
  const dayChild2OfRoot2Id = await createChildTask(store, vault, file, dayRoot2Id, "Child of root2");
  const continuedChildOnlyId = await continueDoingTask(dayChild2OfRoot2Id, "2026.6.4");
  month = getMonth(diskData, filePath);
  // parent auto-followed
  const autoParentId = month.tasks[continuedChildOnlyId].parentId;
  assert.ok(autoParentId);
  assert.equal(month.tasks[autoParentId].sourceDayTaskId, dayRoot2Id);
  assert.equal(month.tasks[autoParentId].childIds.length, 1);
  assert.ok(month.tasks[autoParentId].childIds.includes(continuedChildOnlyId));
  // Verify document content: both parent and child lines exist in the day block
  {
    const doc = vaultContent;
    const parentPos = doc.indexOf(`^${autoParentId}`);
    const childPos = doc.indexOf(`^${continuedChildOnlyId}`);
    assert.ok(parentPos >= 0, `auto-parent ${autoParentId} should appear in document`);
    assert.ok(childPos >= 0, `child ${continuedChildOnlyId} should appear in document`);
    assert.ok(childPos > parentPos, "child line must appear after parent line");
  }

  // ── 6.3 Day independent continue ──
  const dayIndep2Id = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "Independent Day");
  const continuedIndepId = await continueDoingTask(dayIndep2Id, "2026.6.5");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[continuedIndepId].sourceDayTaskId, dayIndep2Id);
  assert.equal(month.tasks[continuedIndepId].areaKey, "2026.6.5");
  assert.deepEqual(month.tasks[dayIndep2Id].daytdayTaskIds, [continuedIndepId]);

  // ── 6.5 Continue from continuation instance → same root ──
  const continuedAgainId = await continueDoingTask(continuedIndepId, "2026.6.6");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[continuedAgainId].sourceDayTaskId, dayIndep2Id); // points to same root
  assert.equal(month.tasks[continuedAgainId].areaKey, "2026.6.6");
  assert.deepEqual(month.tasks[dayIndep2Id].daytdayTaskIds, [continuedIndepId, continuedAgainId]);

  // ── 6.7 Cross-week rejection ──
  await assert.rejects(
    () => continueDoingTask(dayIndep2Id, "2026.6.9"),
    /同周/
  );

  // ── 6.4 Week-sourced Day task continue ──
  const wsDayParentId = await addWeekTaskToDay(store, vault, file, weekParentId, "2026.6.5");
  const wsDayContinuedId = await continueDoingTask(wsDayParentId, "2026.6.6");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[wsDayContinuedId].sourceWeekTaskId, weekParentId);
  assert.equal(month.tasks[wsDayContinuedId].sourceDayTaskId, null); // no Day source chain
  assert.ok(month.tasks[weekParentId].weektdayTaskIds.includes(wsDayContinuedId));

  // ── 6.6 taskHasContinuedInstance ──
  const hasContinued = await taskHasContinuedInstance(store, file, dayIndep2Id, "2026.6.6");
  assert.ok(hasContinued);
  const noContinued = await taskHasContinuedInstance(store, file, dayIndep2Id, "2026.6.7");
  assert.equal(noContinued, false);

  // ── 5.1 Day independent → Week ──
  const dayOnlyId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "Day only");
  const newWeekFromDayId = await addDayTaskToWeek(store, vault, file, dayOnlyId);
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[newWeekFromDayId].area, "week");
  assert.equal(month.tasks[newWeekFromDayId].areaKey, weekKey);
  assert.deepEqual(month.tasks[newWeekFromDayId].weektdayTaskIds, [dayOnlyId]);
  assert.equal(month.tasks[dayOnlyId].sourceWeekTaskId, newWeekFromDayId);

  // ── 5.2 Day parent → Week (children follow) ──
  const dayParentLocalId = await createTopLevelTask(store, vault, file, "day", "2026.6.2", "Local parent");
  const dayParentLocalChildId = await createChildTask(store, vault, file, dayParentLocalId, "Local child");
  const newWeekParentId = await addDayTaskToWeek(store, vault, file, dayParentLocalId);
  month = getMonth(diskData, filePath);
  assert.deepEqual(month.tasks[newWeekParentId].childIds, [month.tasks[dayParentLocalChildId].sourceWeekTaskId]);
  assert.equal(month.tasks[dayParentLocalId].sourceWeekTaskId, newWeekParentId);
  assert.ok(month.tasks[dayParentLocalChildId].sourceWeekTaskId);

  // ── 5.5 Batch Day→Week ──
  const dayBatch1Id = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "Batch D1");
  const dayBatch2Id = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "Batch D2");
  const batchWeekResults = await addDayTasksToWeek(store, vault, file, [dayBatch1Id, dayBatch2Id]);
  assert.equal(batchWeekResults.length, 2);
  month = getMonth(diskData, filePath);
  assert.ok(month.tasks[dayBatch1Id].sourceWeekTaskId);
  assert.ok(month.tasks[dayBatch2Id].sourceWeekTaskId);

  // ── 5.4 Reject: already has Week source ──
  await assert.rejects(
    () => addDayTaskToWeek(store, vault, file, dayOnlyId),
    /已有周来源/
  );

  // ── 5.4 Reject: child task ──
  await assert.rejects(
    () => addDayTaskToWeek(store, vault, file, dayChildId),
    /不能添加到周任务/
  );

  // ── 3.1 Week independent → parent with Day instances ──
  // Week independent already arranged → check rejection when non-todo
  // First: weektdayTaskIds non-empty but all todo → allowed
  month = getMonth(diskData, filePath);
  const childForIndepId = await createChildTask(store, vault, file, weekIndependentId, "Child of indep");
  month = getMonth(diskData, filePath);
  assert.deepEqual(month.tasks[weekIndependentId].childIds, [childForIndepId]);
  // Verify order upgraded
  const weekOrderAfter = getWeekTaskIds(month, weekKey);
  const indepNode = findOrderItem(weekOrderAfter, weekIndependentId);
  assert.ok(indepNode && typeof indepNode.item === "object");
  assert.deepEqual((indepNode.item as { id: string; childIds: string[] }).childIds, [childForIndepId]);

  // Now set a Day instance to non-todo → subsequent Week independent→parent should be rejected
  await store.mutate((data) => {
    const m = data.files[filePath];
    m.tasks[dayIndepId].status = "done";
  });

  // ── 3.2 Day independent non-todo → reject creating child ──
  const dayDoneId = await createTopLevelTask(store, vault, file, "day", "2026.6.7", "Done day task");
  await store.mutate((data) => {
    const m = data.files[filePath];
    m.tasks[dayDoneId].status = "done";
  });
  await assert.rejects(
    () => createChildTask(store, vault, file, dayDoneId, "Should fail"),
    /不能变为父任务/
  );

  // ── 3.2 Day continuation independent → child allowed when todo ──
  const contIndepId = await continueDoingTask(dayIndep2Id, "2026.6.7");
  month = getMonth(diskData, filePath);
  assert.equal(month.tasks[contIndepId].sourceDayTaskId, dayIndep2Id);
  const contChildId = await createChildTask(store, vault, file, contIndepId, "Child of cont instance");
  month = getMonth(diskData, filePath);
  assert.deepEqual(month.tasks[contIndepId].childIds, [contChildId]);
  assert.equal(month.tasks[contChildId].parentId, contIndepId);
  assert.equal(month.tasks[contChildId].areaKey, "2026.6.7");

  // ── 3.3 Week-sourced Day parent → child (routed to Week) ──
  const wsParentForChildId = await addWeekTaskToDay(store, vault, file, weekParentId, "2026.6.7");
  month = getMonth(diskData, filePath);
  assert.ok(wsParentForChildId);
  const wsParentChildId = await createChildTask(store, vault, file, wsParentForChildId, "WS child via Day");
  month = getMonth(diskData, filePath);
  // Should be created under Week parent and auto-arranged
  const wsParentChild = month.tasks[wsParentChildId];
  assert.equal(wsParentChild.parentId, weekParentId);
  assert.equal(wsParentChild.sourceWeekTaskId, null);
  assert.ok(wsParentChild.weektdayTaskIds.length >= 1); // arranged to at least today

  // ── 7.1 Empty name rejection ──
  await assert.rejects(
    () => createTopLevelTask(store, vault, file, "day", "2026.6.1", "   "),
    /任务名称不能为空/
  );
  await assert.rejects(
    () => createChildTask(store, vault, file, weekParentId, "  "),
    /任务名称不能为空/
  );

  // ── 7.1.1 Tagged task input saves tags after task name ──
  {
    const taggedId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "#项目A #阶段1 写测试用例");
    month = getMonth(diskData, filePath);
    assert.equal(month.tasks[taggedId].name, "写测试用例 #项目A #阶段1");
    assert.deepEqual(month.tasks[taggedId].tags, { primary: "#项目A", secondary: "#阶段1" });
    assert.match(vaultContent, new RegExp(`- \\[ \\] 写测试用例 #项目A #阶段1 \\^${taggedId}`));
  }

  // ── 7.1.2 Third leading tag is task name content ──
  {
    const thirdTagNameId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "#项目A #阶段1 #你好");
    month = getMonth(diskData, filePath);
    assert.equal(month.tasks[thirdTagNameId].name, "#你好 #项目A #阶段1");
    assert.deepEqual(month.tasks[thirdTagNameId].tags, { primary: "#项目A", secondary: "#阶段1" });
    assert.match(vaultContent, new RegExp(`- \\[ \\] #你好 #项目A #阶段1 \\^${thirdTagNameId}`));
  }

  // ── 7.1.3 Tags without a task name are rejected ──
  await assert.rejects(
    () => createTopLevelTask(store, vault, file, "day", "2026.6.1", "#项目A #阶段1"),
    /任务名称不能为空/
  );

  // ── 7.2 Missing block rejection must not leave task data behind ──
  {
    const contentWithBlocks = vaultContent;
    const taskCountBefore = Object.keys(getMonth(diskData, filePath).tasks).length;
    vaultContent = vaultContent.replace("%% week:2026.6.1-6.7 %%", "");
    await assert.rejects(
      () => createChildTask(store, vault, file, weekParentId, "Missing block child"),
      /对应的周区域/
    );
    assert.equal(
      Object.keys(getMonth(diskData, filePath).tasks).length,
      taskCountBefore,
      "missing document block must reject before mutating task data"
    );
    vaultContent = contentWithBlocks;
  }

  // ── 8. Invariant: parent-child chain integrity ──
  month = getMonth(diskData, filePath);
  for (const taskId of Object.keys(month.tasks)) {
    const task = month.tasks[taskId];
    // Every parentId points to a real task
    if (task.parentId) assert.ok(month.tasks[task.parentId], `parentId dangling: ${taskId}`);
    // Every childId points to a real task
    for (const cid of task.childIds) assert.ok(month.tasks[cid], `childId dangling: ${cid}`);
    // Every sourceWeekTaskId points to a real task
    if (task.sourceWeekTaskId) assert.ok(month.tasks[task.sourceWeekTaskId], `sourceWeek dangling: ${taskId}`);
    // Every sourceDayTaskId points to a real task
    if (task.sourceDayTaskId) assert.ok(month.tasks[task.sourceDayTaskId], `sourceDay dangling: ${taskId}`);
    // Every weektdayTaskId points to a real task
    for (const did of task.weektdayTaskIds) assert.ok(month.tasks[did], `weektday dangling: ${did}`);
    // Every daytdayTaskId points to a real task
    if (task.daytdayTaskIds) {
      for (const did of task.daytdayTaskIds) assert.ok(month.tasks[did], `daytday dangling: ${did}`);
    }
    // No 3-level nesting
    if (task.parentId) {
      const parentTask = month.tasks[task.parentId];
      assert.equal(parentTask.parentId, null, `3-level nesting at ${taskId}`);
    }
    // Weektday bidirectional
    for (const did of task.weektdayTaskIds) {
      assert.equal(month.tasks[did].sourceWeekTaskId, task.id, `weektday bidir broken: ${did}`);
    }
    // Daytday bidirectional
    if (task.daytdayTaskIds) {
      for (const did of task.daytdayTaskIds) {
        assert.equal(month.tasks[did].sourceDayTaskId, task.id, `daytday bidir broken: ${did}`);
      }
    }
  }

  // ── 5.3 Continuation chain to Week ──
  const contChainRootId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "Chain root");
  const contChainChildId = await createChildTask(store, vault, file, contChainRootId, "Chain child");
  const contChainInst1Id = await continueDoingTask(contChainRootId, "2026.6.5");
  month = getMonth(diskData, filePath);
  const contChainWeekId = await addDayTaskToWeek(store, vault, file, contChainInst1Id);
  month = getMonth(diskData, filePath);
  // Root gets Week source
  assert.equal(month.tasks[contChainRootId].sourceWeekTaskId, contChainWeekId);
  // Continuation instance also gets Week source
  assert.equal(month.tasks[contChainInst1Id].sourceWeekTaskId, contChainWeekId);
  // Child gets Week source
  assert.ok(month.tasks[contChainChildId].sourceWeekTaskId);
  // Week task has all instances in weektdayTaskIds
  assert.ok(month.tasks[contChainWeekId].weektdayTaskIds.includes(contChainRootId));
  assert.ok(month.tasks[contChainWeekId].weektdayTaskIds.includes(contChainInst1Id));

  console.log("v2 created tests passed");
}

function getMonth(data: unknown, filePath: string): MonthTaskData {
  return (data as TaskFlowV2Data).files[filePath];
}
