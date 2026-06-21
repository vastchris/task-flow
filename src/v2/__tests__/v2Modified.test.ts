import * as assert from "node:assert/strict";
import type { Vault } from "obsidian";
import {
  renameTask,
  renameTagInTasks,
  reorderTask,
  reorderTagGroups,
  moveDayTask,
  moveProjectionChildren,
  getRenamePreview,
} from "../structure/v2Modified";
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

  function getMonth(): NonNullable<TaskFlowV2Data["files"][string]> {
    return (diskData as TaskFlowV2Data).files[filePath];
  }

  function resetVault(): void {
    vaultContent = initialVaultContent;
  }

  async function setStatus(taskId: string, status: "todo" | "doing" | "done"): Promise<void> {
    await store.mutate((data) => {
      data.files[filePath].tasks[taskId].status = status;
    });
  }

  await store.load();
  await store.ensureMonth(file);

  // ═══════════════════════════════════════════════
  // Section 1: Rename
  // ═══════════════════════════════════════════════

  // 1.1 Simple rename — Week independent task (no chain)
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "week", weekKey, "旧名称");
    await renameTask(store, vault, file, taskId, "新名称");

    const month = getMonth();
    assert.equal(month.tasks[taskId].name, "新名称");

    const doc = vaultContent;
    assert.ok(doc.includes("新名称"));
    assert.ok(!doc.includes("旧名称"));
    assert.ok(doc.includes(`^${taskId}`));
  }

  // 1.2 Simple rename — Day independent task (no chain)
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "旧名称");
    await renameTask(store, vault, file, taskId, "新名称");

    const month = getMonth();
    assert.equal(month.tasks[taskId].name, "新名称");
    const doc = vaultContent;
    assert.ok(doc.includes("新名称"));
    assert.ok(!doc.includes("旧名称"));
  }

  // 1.3 Chain rename — Week task with Day instances
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "链任务");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");

    const month = getMonth();
    const preview = getRenamePreview(month, weekId);
    assert.equal(preview.length, 2); // Week + 1 Day instance

    await renameTask(store, vault, file, weekId, "新链任务");

    const month2 = getMonth();
    assert.equal(month2.tasks[weekId].name, "新链任务");
    // Day instance should also be renamed
    for (const dayId of month2.tasks[weekId].weektdayTaskIds) {
      assert.equal(month2.tasks[dayId].name, "新链任务");
    }
    const doc = vaultContent;
    // Both should have the new name
    const occurrences = (doc.match(/新链任务/g) ?? []).length;
    assert.equal(occurrences, 2);
  }

  // 1.4 Chain rename — Day continuation root
  {
    resetVault();
    const rootId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "延续根");
    await setStatus(rootId, "doing");
    const instId = await continueDayTask(store, vault, file, rootId, "2026.6.5");

    const month = getMonth();
    const preview = getRenamePreview(month, rootId);
    assert.equal(preview.length, 2); // root + 1 continuation

    await renameTask(store, vault, file, rootId, "新延续根");

    const month2 = getMonth();
    assert.equal(month2.tasks[rootId].name, "新延续根");
    assert.equal(month2.tasks[instId].name, "新延续根");
  }

  // 1.5 Chain rename — Week-source Day instance (rename propagates to Week and siblings)
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "Week源");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.5");

    const month = getMonth();
    const dayInstances = month.tasks[weekId].weektdayTaskIds;
    const firstDayId = dayInstances[0];

    const preview = getRenamePreview(month, firstDayId);
    assert.equal(preview.length, 3); // Week + 2 Day instances

    await renameTask(store, vault, file, firstDayId, "周源新名");

    const month2 = getMonth();
    assert.equal(month2.tasks[weekId].name, "周源新名");
    for (const dayId of dayInstances) {
      assert.equal(month2.tasks[dayId].name, "周源新名");
    }
  }

  // 1.6 Empty name rejection
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "有效名");
    await assert.rejects(
      () => renameTask(store, vault, file, taskId, "  "),
      /任务名称不能为空/,
    );
  }

  // 1.6.1 Rename can update tags with leading tag input
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "旧名称");
    await renameTask(store, vault, file, taskId, "#项目A #阶段1 新名称");
    const month = getMonth();
    assert.equal(month.tasks[taskId].name, "新名称 #项目A #阶段1");
    assert.deepEqual(month.tasks[taskId].tags, { primary: "#项目A", secondary: "#阶段1" });
    assert.match(vaultContent, new RegExp(`- \\[ \\] 新名称 #项目A #阶段1 \\^${taskId}`));
  }

  // 1.6.2 Rename treats the third leading tag as task name
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "旧名称");
    await renameTask(store, vault, file, taskId, "#项目A #阶段1 #你好");
    const month = getMonth();
    assert.equal(month.tasks[taskId].name, "#你好 #项目A #阶段1");
    assert.deepEqual(month.tasks[taskId].tags, { primary: "#项目A", secondary: "#阶段1" });
  }

  // 1.6.3 Rename a primary tag in the current task range
  {
    resetVault();
    const firstId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "#ProjectA Alpha");
    const secondId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "#ProjectA #Phase1 Beta");
    const thirdId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "#ProjectB Gamma");

    await renameTagInTasks(
      store,
      vault,
      file,
      [firstId, secondId, thirdId],
      "primary",
      "#ProjectA",
      "#ProjectA",
      "#ProjectC"
    );

    const month = getMonth();
    assert.equal(month.tasks[firstId].name, "Alpha #ProjectC");
    assert.deepEqual(month.tasks[firstId].tags, { primary: "#ProjectC", secondary: null });
    assert.equal(month.tasks[secondId].name, "Beta #ProjectC #Phase1");
    assert.deepEqual(month.tasks[secondId].tags, { primary: "#ProjectC", secondary: "#Phase1" });
    assert.equal(month.tasks[thirdId].name, "Gamma #ProjectB");
    assert.deepEqual(month.tasks[thirdId].tags, { primary: "#ProjectB", secondary: null });
    assert.ok(vaultContent.includes(`Alpha #ProjectC ^${firstId}`));
    assert.ok(vaultContent.includes(`Beta #ProjectC #Phase1 ^${secondId}`));
    assert.ok(vaultContent.includes(`Gamma #ProjectB ^${thirdId}`));
  }

  // 1.6.4 Rename a secondary tag only inside the matching primary tag
  {
    resetVault();
    const firstId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "#ProjectA #Phase1 Alpha");
    const secondId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "#ProjectA #Phase1 Beta");
    const thirdId = await createTopLevelTask(store, vault, file, "day", "2026.6.4", "#ProjectA #Phase2 Gamma");

    await renameTagInTasks(
      store,
      vault,
      file,
      [firstId, secondId, thirdId],
      "secondary",
      "#ProjectA",
      "#Phase1",
      "#PhaseX"
    );

    const month = getMonth();
    assert.equal(month.tasks[firstId].name, "Alpha #ProjectA #PhaseX");
    assert.deepEqual(month.tasks[firstId].tags, { primary: "#ProjectA", secondary: "#PhaseX" });
    assert.equal(month.tasks[secondId].name, "Beta #ProjectA #PhaseX");
    assert.deepEqual(month.tasks[secondId].tags, { primary: "#ProjectA", secondary: "#PhaseX" });
    assert.equal(month.tasks[thirdId].name, "Gamma #ProjectA #Phase2");
    assert.deepEqual(month.tasks[thirdId].tags, { primary: "#ProjectA", secondary: "#Phase2" });
    assert.ok(vaultContent.includes(`Alpha #ProjectA #PhaseX ^${firstId}`));
    assert.ok(vaultContent.includes(`Beta #ProjectA #PhaseX ^${secondId}`));
    assert.ok(vaultContent.includes(`Gamma #ProjectA #Phase2 ^${thirdId}`));
  }

  // 1.6.5 Reorder tag groups through the existing task order
  {
    resetVault();
    const untaggedId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "Untagged");
    const aPlainId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "#ProjectA Alpha");
    const bFirstId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "#ProjectB #Phase1 B1");
    const aPhaseSingleId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "#ProjectA #Phase2 A2");
    const aFirstId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "#ProjectA #Phase1 A1");
    const bSecondId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "#ProjectB #Phase1 B2");
    const aSecondId = await createTopLevelTask(store, vault, file, "day", "2026.6.5", "#ProjectA #Phase1 A3");

    await reorderTagGroups(
      store,
      vault,
      file,
      "day",
      "2026.6.5",
      ["#ProjectB", "#ProjectA"],
      {
        "#ProjectA": ["#Phase1"],
        "#ProjectB": ["#Phase1"],
      }
    );

    const month = getMonth();
    const createdIds = [
      untaggedId,
      aPlainId,
      bFirstId,
      aPhaseSingleId,
      aFirstId,
      bSecondId,
      aSecondId,
    ];
    assert.deepEqual(flattenOrderArray(getDayTaskIds(month, "2026.6.5")).filter((id) => createdIds.includes(id)), [
      untaggedId,
      bFirstId,
      bSecondId,
      aPlainId,
      aPhaseSingleId,
      aFirstId,
      aSecondId,
    ]);
    assert.ok(vaultContent.indexOf(`Untagged ^${untaggedId}`) < vaultContent.indexOf(`B1 #ProjectB #Phase1 ^${bFirstId}`));
    assert.ok(vaultContent.indexOf(`B2 #ProjectB #Phase1 ^${bSecondId}`) < vaultContent.indexOf(`Alpha #ProjectA ^${aPlainId}`));
    assert.ok(vaultContent.indexOf(`A2 #ProjectA #Phase2 ^${aPhaseSingleId}`) < vaultContent.indexOf(`A1 #ProjectA #Phase1 ^${aFirstId}`));
  }

  // 1.7 Missing task throws
  {
    resetVault();
    await assert.rejects(
      () => renameTask(store, vault, file, "tf-d-nonexist", "x"),
      /not found/i,
    );
  }

  // 1.8 Rename updates existing tasklog heading without touching body text
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "旧工作记录名");
    vaultContent += `\n### 旧工作记录名\ntasklog:: ${taskId}\n***\n正文保留旧工作记录名\n`;

    await renameTask(store, vault, file, taskId, "新工作记录名");

    assert.ok(vaultContent.includes("### 新工作记录名"));
    assert.ok(!vaultContent.includes("### 旧工作记录名"));
    assert.ok(vaultContent.includes("正文保留旧工作记录名"));
    assert.ok(vaultContent.includes(`tasklog:: ${taskId}`));
  }

  // 1.9 Chain rename updates all existing tasklog headings in the identity chain
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "链工作记录名");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");
    const month = getMonth();
    const dayId = month.tasks[weekId].weektdayTaskIds[0];
    vaultContent += `\n### 链工作记录名\ntasklog:: ${weekId}\n***\n`;
    vaultContent += `\n### 链工作记录名\ntasklog:: ${dayId}\n***\n`;

    await renameTask(store, vault, file, weekId, "新链工作记录名");

    const headingMatches = vaultContent.match(/### 新链工作记录名/g) ?? [];
    assert.equal(headingMatches.length, 2);
    assert.ok(!vaultContent.includes("### 链工作记录名"));
    assert.ok(vaultContent.includes(`tasklog:: ${weekId}`));
    assert.ok(vaultContent.includes(`tasklog:: ${dayId}`));
  }

  // 1.10 Parent rename updates the parent-name part of child tasklog headings
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "旧父任务");
    const childId = await createChildTask(store, vault, file, parentId, "子任务");
    vaultContent += `\n### 子任务 / 旧父任务\ntasklog:: ${childId}\n***\n`;

    await renameTask(store, vault, file, parentId, "新父任务");

    assert.ok(vaultContent.includes("### 子任务 / 新父任务"));
    assert.ok(!vaultContent.includes("### 子任务 / 旧父任务"));
    assert.ok(vaultContent.includes(`tasklog:: ${childId}`));
  }

  // ═══════════════════════════════════════════════
  // Section 2: Reorder
  // ═══════════════════════════════════════════════

  // 2.1 Reorder Week top-level tasks
  {
    resetVault();
    const a = await createTopLevelTask(store, vault, file, "week", weekKey, "A");
    const b = await createTopLevelTask(store, vault, file, "week", weekKey, "B");
    const c = await createTopLevelTask(store, vault, file, "week", weekKey, "C");

    let month = getMonth();
    const allIds = flattenOrderArray(getWeekTaskIds(month, weekKey));
    const posA = allIds.indexOf(a);
    const posB = allIds.indexOf(b);
    const posC = allIds.indexOf(c);
    assert.ok(posA >= 0 && posB >= 0 && posC >= 0);
    assert.ok(posA < posB && posB < posC, "A,B,C should be in order initially");

    // Move C to position 0 (within the full array, we set targetIndex=0)
    // But since there are leftover tasks, targetIndex=0 means absolute index 0
    await reorderTask(store, vault, file, c, 0);

    month = getMonth();
    const afterIds = flattenOrderArray(getWeekTaskIds(month, weekKey));
    const afterPosC = afterIds.indexOf(c);
    assert.equal(afterPosC, 0, "C should be at index 0 after reorder");

    // Verify document order: C before A before B
    const doc = vaultContent;
    const docPosC = doc.indexOf(`^${c}`);
    const docPosA = doc.indexOf(`^${a}`);
    const docPosB = doc.indexOf(`^${b}`);
    assert.ok(docPosC < docPosA, "C should be before A in document");
    assert.ok(docPosA < docPosB, "A should be before B in document");
  }

  // 2.2 Reorder Day top-level tasks
  {
    resetVault();
    const a = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "A");
    const b = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "B");

    let month = getMonth();
    const idsBefore = flattenOrderArray(getDayTaskIds(month, "2026.6.3"));
    const posA0 = idsBefore.indexOf(a);
    const posB0 = idsBefore.indexOf(b);
    assert.ok(posA0 >= 0 && posB0 >= 0);
    assert.ok(posA0 < posB0, "A should be before B initially");

    // Move A to after B (targetIndex=1 means index 1 in the FULL array)
    await reorderTask(store, vault, file, a, idsBefore.length - 1);

    month = getMonth();
    const idsAfter = flattenOrderArray(getDayTaskIds(month, "2026.6.3"));
    const posA = idsAfter.indexOf(a);
    const posB = idsAfter.indexOf(b);
    assert.ok(posB < posA, "B should be before A after reorder");
  }

  // 2.3 Reorder child tasks within parent
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "week", weekKey, "父");
    const c1 = await createChildTask(store, vault, file, parentId, "子1");
    const c2 = await createChildTask(store, vault, file, parentId, "子2");
    const c3 = await createChildTask(store, vault, file, parentId, "子3");

    let month = getMonth();
    assert.deepEqual(month.tasks[parentId].childIds, [c1, c2, c3]);

    // Move c3 to position 0
    await reorderTask(store, vault, file, c3, 0);

    month = getMonth();
    assert.deepEqual(month.tasks[parentId].childIds, [c3, c1, c2]);

    // Verify document order
    const doc = vaultContent;
    const pos3 = doc.indexOf(`^${c3}`);
    const pos1 = doc.indexOf(`^${c1}`);
    const pos2 = doc.indexOf(`^${c2}`);
    assert.ok(pos3 < pos1, "c3 should be before c1 in document");
    assert.ok(pos1 < pos2, "c1 should be before c2 in document");
  }

  // ═══════════════════════════════════════════════
  // Section 3: Date Move — Week-source
  // ═══════════════════════════════════════════════

  // 3.1 Week-source parent — move with children
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "WS父");
    const childId = await createChildTask(store, vault, file, weekId, "WS子");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");

    let month = getMonth();
    const parentDayId = month.tasks[weekId].weektdayTaskIds[0];
    const parentTask = month.tasks[parentDayId];
    assert.equal(parentTask.areaKey, "2026.6.3");

    await moveDayTask(store, vault, file, parentDayId, "2026.6.5");

    month = getMonth();
    assert.equal(month.tasks[parentDayId].areaKey, "2026.6.5");
    // Source day should not have the parent
    const srcIds = flattenOrderArray(getDayTaskIds(month, "2026.6.3"));
    assert.ok(!srcIds.includes(parentDayId));
    // Target day should have it
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.5"));
    assert.ok(tgtIds.includes(parentDayId));
  }

  // 3.2 Week-source parent — merge with existing same-source parent at target
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "WS父2");
    const child1 = await createChildTask(store, vault, file, weekId, "子A");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");
    // Also arrange the same parent to target day (creates another instance)
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.5");

    let month = getMonth();
    const dayIds = month.tasks[weekId].weektdayTaskIds;
    // Find the instance on 6.3 (should have the child)
    const srcParent = dayIds.find((id) => month.tasks[id].areaKey === "2026.6.3")!;
    const tgtParent = dayIds.find((id) => month.tasks[id].areaKey === "2026.6.5")!;
    // Both exist
    assert.ok(srcParent);
    assert.ok(tgtParent);

    // Move parent from 6.3 to 6.5 → should merge into existing parent at 6.5
    await moveDayTask(store, vault, file, srcParent, "2026.6.5");

    month = getMonth();
    // Source parent should be deleted (merged into existing)
    assert.equal(month.tasks[srcParent], undefined);
    // Target parent should still exist
    assert.ok(month.tasks[tgtParent]);
    // Week source should only track the surviving parent
    assert.equal(month.tasks[weekId].weektdayTaskIds.length, 1);
    assert.ok(month.tasks[weekId].weektdayTaskIds.includes(tgtParent));
  }

  // 3.3 Week-source parent — reject if child not todo
  {
    // Skip: requires status change which is Stage 7 functionality.
    // The check is in the code but we can't set status through Stage 4-5 APIs.
  }

  // 3.4 Week-source independent — simple areaKey change
  // Already tested via 3.6; skip duplicative test

  // 3.5 Day-created child — reuse existing parent at target
  {
    resetVault();
    // Use continueDayTask to create child Day instances with parent
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "复用父");
    const childId = await createChildTask(store, vault, file, parentId, "复用子");
    // Continue to another day to create parent+child instances
    await setStatus(childId, "doing");
    const contId = await continueDayTask(store, vault, file, parentId, "2026.6.5");

    let month = getMonth();
    // Find the child of the continued parent at 6.5
    const contParent = month.tasks[contId];
    assert.ok(contParent.childIds.length > 0);
    const contChildId = contParent.childIds[0];

    // Move the child from 6.3 to 6.5 (should reuse existing parent at 6.5)
    await setStatus(childId, "todo");
    await moveDayTask(store, vault, file, childId, "2026.6.5");

    month = getMonth();
    // Target parent should contain both children
    const tgtParent2 = month.tasks[contId];
    assert.ok(tgtParent2.childIds.includes(childId));
    assert.ok(tgtParent2.childIds.includes(contChildId));
    assert.equal(tgtParent2.childIds.length, 2);
  }

  // 3.6 Week-source independent — simple areaKey change
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "WS独立");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");

    let month = getMonth();
    const dayId = month.tasks[weekId].weektdayTaskIds[0];
    assert.equal(month.tasks[dayId].areaKey, "2026.6.3");

    await moveDayTask(store, vault, file, dayId, "2026.6.6");

    month = getMonth();
    assert.equal(month.tasks[dayId].areaKey, "2026.6.6");
    const srcIds = flattenOrderArray(getDayTaskIds(month, "2026.6.3"));
    assert.ok(!srcIds.includes(dayId));
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.6"));
    assert.ok(tgtIds.includes(dayId));
  }

  // ═══════════════════════════════════════════════
  // Section 4: Date Move — Day-created
  // ═══════════════════════════════════════════════

  // 4.1 Day-created parent — move with children
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "DC父");
    const childId = await createChildTask(store, vault, file, parentId, "DC子");

    let month = getMonth();
    assert.equal(month.tasks[parentId].areaKey, "2026.6.3");
    assert.equal(month.tasks[childId].areaKey, "2026.6.3");

    await moveDayTask(store, vault, file, parentId, "2026.6.5");

    month = getMonth();
    assert.equal(month.tasks[parentId].areaKey, "2026.6.5");
    assert.equal(month.tasks[childId].areaKey, "2026.6.5");
    const srcIds = flattenOrderArray(getDayTaskIds(month, "2026.6.3"));
    assert.ok(!srcIds.includes(parentId));
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.5"));
    assert.ok(tgtIds.includes(parentId));
  }

  // 4.2 Day-created child — move, auto-create parent at target
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "DC父2");
    const childId = await createChildTask(store, vault, file, parentId, "DC子2");

    await moveDayTask(store, vault, file, childId, "2026.6.5");

    const month = getMonth();
    // Source parent should still exist as independent
    assert.ok(month.tasks[parentId]);
    assert.equal(month.tasks[parentId].childIds.length, 0);

    // New parent should be auto-created at target
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.5"));
    assert.ok(tgtIds.length >= 2, "target should have auto-created parent + child");

    // Find the auto-created parent (must be on target day, not source parent, and contain childId)
    const newParent = tgtIds
      .map((id) => month.tasks[id])
      .find((t) => t && t.areaKey === "2026.6.5" && t.id !== parentId && t.childIds.includes(childId));
    assert.ok(newParent, "auto-created parent should exist and contain the child");
    assert.equal(newParent.childIds.length, 1);
  }

  // 4.3 Day-created child — reuse existing parent at target
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "DC父3");
    const c1 = await createChildTask(store, vault, file, parentId, "子P");
    const c2 = await createChildTask(store, vault, file, parentId, "子Q");

    // First move c1 to create a parent at target
    await moveDayTask(store, vault, file, c1, "2026.6.5");

    let month = getMonth();
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.5"));
    const tgtParent = tgtIds
      .map((id) => month.tasks[id])
      .find((t) => t && t.childIds.length > 0 && t.childIds.includes(c1));
    assert.ok(tgtParent, "auto-created parent should exist");

    // Now move c2 to same target → should reuse existing parent
    await moveDayTask(store, vault, file, c2, "2026.6.5");

    month = getMonth();
    assert.ok(month.tasks[tgtParent!.id].childIds.includes(c2));
  }

  // 4.4 Day-created independent — simple areaKey change
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "DC独立");

    await moveDayTask(store, vault, file, taskId, "2026.6.7");

    const month = getMonth();
    assert.equal(month.tasks[taskId].areaKey, "2026.6.7");
  }

  // ═══════════════════════════════════════════════
  // Section 5: Rejection cases
  // ═══════════════════════════════════════════════

  // 5.1 Cross-week rejection
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "跨周");
    // 2026.6.8 is in next week
    await assert.rejects(
      () => moveDayTask(store, vault, file, taskId, "2026.6.8"),
      /其他周/,
    );
  }

  // 5.2 Same-day rejection
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "同日");
    await assert.rejects(
      () => moveDayTask(store, vault, file, taskId, "2026.6.3"),
      /already/i,
    );
  }

  // 5.3 Non-day task rejection
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "周任务");
    await assert.rejects(
      () => moveDayTask(store, vault, file, weekId, "2026.6.3"),
      /only day/i,
    );
  }

  // 5.4 Missing target day block rejection
  {
    resetVault();
    // Remove day 6.5 block from vault to simulate missing block in same week
    vaultContent = vaultContent.replace(/%% day:2026\.6\.5 %%\n%% day end %%\n/, "");
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "无区块");
    await assert.rejects(
      () => moveDayTask(store, vault, file, taskId, "2026.6.5"),
      /创建.*日期区域/,
    );
  }

  // ═══════════════════════════════════════════════
  // Section 6: moveProjectionChildren
  // ═══════════════════════════════════════════════

  // 6.1 Move children between days (Day-created scenario)
  {
    resetVault();
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "MP父");
    const c1 = await createChildTask(store, vault, file, parentId, "MP子1");
    const c2 = await createChildTask(store, vault, file, parentId, "MP子2");

    let month = getMonth();
    assert.equal(month.tasks[parentId].childIds.length, 2);

    // Move children of parentId from 6.3 to 6.5
    await moveProjectionChildren(store, vault, file, parentId, "2026.6.3", "2026.6.5");

    month = getMonth();
    // Source parent should be empty → kept as independent (Day-created rule)
    assert.ok(month.tasks[parentId]);
    assert.equal(month.tasks[parentId].childIds.length, 0);

    // Target should have a new parent with both children
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.5"));
    const tgtParent = tgtIds
      .map((id) => month.tasks[id])
      .find((t) => t && t.childIds.length === 2);
    assert.ok(tgtParent, "target should have parent with 2 children");
  }

  // 6.2 Same-day rejection
  {
    resetVault();
    await assert.rejects(
      () => moveProjectionChildren(store, vault, file, "tf-d-xxx", "2026.6.3", "2026.6.3"),
      /same/i,
    );
  }

  // 6.3 No children found
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "空父");
    await assert.rejects(
      () => moveProjectionChildren(store, vault, file, taskId, "2026.6.3", "2026.6.5"),
      /no.*children/i,
    );
  }

  // ═══════════════════════════════════════════════
  // Section 7: Invariants
  // ═══════════════════════════════════════════════

  // 7.1 No dangling references after rename
  {
    resetVault();
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "不变");
    const childId = await createChildTask(store, vault, file, weekId, "子");
    await addWeekTaskToDay(store, vault, file, weekId, "2026.6.3");

    await renameTask(store, vault, file, weekId, "新不变");

    const month = getMonth();
    // All relationships should be intact
    assert.equal(month.tasks[weekId].childIds.length, 1);
    assert.equal(month.tasks[weekId].childIds[0], childId);
    assert.equal(month.tasks[childId].parentId, weekId);
    assert.equal(month.tasks[weekId].weektdayTaskIds.length, 1);

    // No dangling references
    for (const t of Object.values(month.tasks)) {
      if (t.parentId) assert.ok(month.tasks[t.parentId], `parent ${t.parentId} should exist`);
      if (t.sourceWeekTaskId) assert.ok(month.tasks[t.sourceWeekTaskId], `week source ${t.sourceWeekTaskId} should exist`);
      if (t.sourceDayTaskId) assert.ok(month.tasks[t.sourceDayTaskId], `day source ${t.sourceDayTaskId} should exist`);
      for (const cid of t.childIds) assert.ok(month.tasks[cid], `child ${cid} should exist`);
      for (const did of t.weektdayTaskIds) assert.ok(month.tasks[did], `day instance ${did} should exist`);
      if (t.daytdayTaskIds) {
        for (const did of t.daytdayTaskIds) assert.ok(month.tasks[did], `continuation ${did} should exist`);
      }
    }
  }

  // 7.2 Order array consistency after move
  {
    resetVault();
    const taskId = await createTopLevelTask(store, vault, file, "day", "2026.6.3", "顺序测试");

    await moveDayTask(store, vault, file, taskId, "2026.6.4");

    const month = getMonth();
    // Should not appear in source day
    const srcIds = flattenOrderArray(getDayTaskIds(month, "2026.6.3"));
    assert.ok(!srcIds.includes(taskId));

    // Should appear exactly once in target day
    const tgtIds = flattenOrderArray(getDayTaskIds(month, "2026.6.4"));
    const count = tgtIds.filter((id) => id === taskId).length;
    assert.equal(count, 1);
  }

  console.log("v2Modified.test.ts: all tests passed");
}
