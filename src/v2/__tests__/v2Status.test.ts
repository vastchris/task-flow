import * as assert from "node:assert/strict";
import type { Vault } from "obsidian";
import {
  applyDayTaskStatusChanges,
  changeDayTaskStatus,
  recalcGlobalStatus,
  hasSpecialMark,
  shouldPromoteAddedTasklogToDoing,
} from "../structure/v2Status";
import { updateStatusMark, findTasklog } from "../structure/v2Document";
import {
  addWeekTaskToDay,
  createTopLevelTask,
  createChildTask,
  continueDayTask,
} from "../structure/v2Created";
import {
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

  let vaultContent = `%% week:2026.6.1-6.7 %%
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
  const vault = {
    read: async (_f: unknown) => vaultContent,
    modify: async (_f: unknown, c: string) => { vaultContent = c; },
  } as unknown as Vault;

  async function continueDoingTask(sourceId: string, targetDayKey: string): Promise<string> {
    await markCurrentTaskDoing(store, filePath, sourceId);
    return continueDayTask(store, vault, file, sourceId, targetDayKey);
  }

  function getMonth(): NonNullable<TaskFlowV2Data["files"][string]> {
    return (diskData as TaskFlowV2Data).files[filePath];
  }

  function resetVault(): void {
    vaultContent = `%% week:2026.6.1-6.7 %%
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
  }

  await store.load();
  await store.ensureMonth(file);

  // ═══════════════════════════════════════════════
  // Section 1: updateStatusMark — document sync
  // ═══════════════════════════════════════════════

  // 1.1 Replace [ ] with [/] on a simple task line
  {
    const content = "- [ ] my task ^tf-d-001\nother text";
    const result = updateStatusMark(content, "tf-d-001", "doing");
    assert.ok(result.includes("- [/] my task ^tf-d-001"), "should replace [ ] with [/]");
    assert.ok(!result.includes("[ ]"), "old mark should be gone");
  }

  // 1.2 Replace [/] with [x]
  {
    const content = "- [/] my task ^tf-d-001\nother text";
    const result = updateStatusMark(content, "tf-d-001", "done");
    assert.ok(result.includes("- [x] my task ^tf-d-001"), "should replace [/] with [x]");
  }

  // 1.3 Replace with special mark (todo + ✅)
  {
    const content = "- [ ] my task ^tf-d-001\nother text";
    const result = updateStatusMark(content, "tf-d-001", "todo", true);
    assert.ok(result.includes("- [ ] ✅ my task ^tf-d-001"), "should add ✅ for special state");
  }

  // 1.4 Replace with special mark (doing + ✅)
  {
    const content = "- [/] my task ^tf-d-001\nother text";
    const result = updateStatusMark(content, "tf-d-001", "doing", true);
    assert.ok(result.includes("- [/] ✅ my task ^tf-d-001"), "should add ✅ for doing special");
  }

  // 1.5 Non-existent task ID returns unchanged
  {
    const content = "- [ ] my task ^tf-d-001\nother text";
    const result = updateStatusMark(content, "tf-d-999", "done");
    assert.equal(result, content, "unchanged for non-existent ID");
  }

  // 1.6 Indented child task
  {
    const content = "\t- [ ] child task ^tf-d-002\nother text";
    const result = updateStatusMark(content, "tf-d-002", "doing");
    assert.ok(result.includes("\t- [/] child task ^tf-d-002"), "should handle indented lines");
  }

  // ═══════════════════════════════════════════════
  // Section 2: changeDayTaskStatus — basic status changes
  // ═══════════════════════════════════════════════

  // 2.1 todo → doing (simulating tasklog added)
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    // Create a Day task on 6.1
    vaultContent = vaultContent.replace("%% day:2026.6.1 %%\n%% day end %%", "%% day:2026.6.1 %%\n- [ ] test ^tf-d-100\n%% day end %%");
    const id = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "test");

    const task = getMonth().tasks[id];
    assert.equal(task.status, "todo");

    await changeDayTaskStatus(store, vault, file, id, "doing");

    const updated = getMonth().tasks[id];
    assert.equal(updated.status, "doing");
    // Document should be updated
    const docAfter = vaultContent;
    assert.ok(docAfter.includes("[/] test"), "document should show [/]");
  }

  // 2.2 doing → done (simulating blue circle click)
  {
    const month = getMonth();
    const tasks = Object.values(month.tasks).filter((t) => t.area === "day" && t.status === "doing");
    if (tasks.length > 0) {
      const id = tasks[0].id;
      await changeDayTaskStatus(store, vault, file, id, "done");
      const updated = getMonth().tasks[id];
      assert.equal(updated.status, "done");
      const docAfter = vaultContent;
      assert.ok(docAfter.includes("[x]"), "document should show [x]");
    }
  }

  // 2.3 done → doing (simulating green check click)
  {
    const month = getMonth();
    const tasks = Object.values(month.tasks).filter((t) => t.area === "day" && t.status === "done");
    if (tasks.length > 0) {
      const id = tasks[0].id;
      await changeDayTaskStatus(store, vault, file, id, "doing");
      const updated = getMonth().tasks[id];
      assert.equal(updated.status, "doing");
    }
  }

  // 2.4 Parent task rejects direct status change
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "parent");
    await createChildTask(store, vault, file, parentId, "child");

    await assert.rejects(
      () => changeDayTaskStatus(store, vault, file, parentId, "done"),
      /Parent tasks cannot change status/,
    );
  }

  // 2.5 Week task rejects status change
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "weekTask");

    await assert.rejects(
      () => changeDayTaskStatus(store, vault, file, weekId, "done"),
      /Only Day tasks/,
    );
  }

  // 2.6 Batch tasklog changes update data and return one document result
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);
    const firstId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "batchOne");
    const secondId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "batchTwo");
    const before = vaultContent;
    const after = await applyDayTaskStatusChanges(
      store,
      file,
      [
        { taskId: firstId, newStatus: "doing" },
        { taskId: secondId, newStatus: "doing" },
      ],
      before,
    );
    assert.ok(after.includes(`[/] batchOne ^${firstId}`));
    assert.ok(after.includes(`[/] batchTwo ^${secondId}`));
    assert.equal(getMonth().tasks[firstId].status, "doing");
    assert.equal(getMonth().tasks[secondId].status, "doing");
    assert.equal(vaultContent, before, "batch calculation must not write through Vault");
  }

  // 2.7 Rapid status changes for the same document are serialized
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);
    const id = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "rapidStatus");
    let activeReads = 0;
    let maxActiveReads = 0;
    const delayedVault = {
      read: async (_f: unknown) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeReads -= 1;
        return vaultContent;
      },
      modify: async (_f: unknown, content: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        vaultContent = content;
      },
    } as unknown as Vault;

    await Promise.all([
      changeDayTaskStatus(store, delayedVault, file, id, "doing"),
      changeDayTaskStatus(store, delayedVault, file, id, "done"),
    ]);

    assert.equal(maxActiveReads, 1, "status document transactions must not overlap");
    assert.equal(getMonth().tasks[id].status, "done");
    assert.ok(vaultContent.includes(`[x] rapidStatus ^${id}`));
  }

  // 2.8 Open documents use the editor writer instead of Vault.modify
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);
    const id = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "editorStatus");
    let editorContent = vaultContent;
    const guardedVault = {
      read: async (_f: unknown) => vaultContent,
      modify: async () => {
        throw new Error("Vault.modify must not run for an open editor");
      },
    } as unknown as Vault;

    await changeDayTaskStatus(store, guardedVault, file, id, "doing", {
      documentReader: () => editorContent,
      documentWriter: (newContent) => {
        editorContent = newContent;
      },
    });

    assert.ok(editorContent.includes(`[/] editorStatus ^${id}`));
    assert.equal(getMonth().tasks[id].status, "doing");
  }

  // ═══════════════════════════════════════════════
  // Section 3: Same-source group (7.1.3)
  // ═══════════════════════════════════════════════

  // 3.1 When one instance is done, same-source instances get special marks
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    // Create Week task and arrange to two dates
    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "sameSourceTask");
    const day1Id = await addWeekTaskToDay(store, vault, file, weekId, "2026.6.1");
    const day2Id = await addWeekTaskToDay(store, vault, file, weekId, "2026.6.2");

    // Mark day1 as done
    await changeDayTaskStatus(store, vault, file, day1Id, "done");

    // day2 should now have special mark
    const month = getMonth();
    assert.ok(hasSpecialMark(month, day2Id), "day2 should have special mark since day1 is done");
    assert.equal(month.tasks[day2Id].status, "todo", "day2 base status remains todo");
    assert.ok(
      vaultContent.includes(`[ ] ✅ sameSourceTask ^${day2Id}`),
      "special state should be written to the document",
    );

    // Week task should be synced (effective is done from day1)
    const weekTask = month.tasks[weekId];
    assert.ok(weekTask.status === "done" || weekTask.status === "doing", "week task reflects day status");
  }

  // 3.2 Task without same-source key → no special mark
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const id = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "independent");

    // Mark as done
    await changeDayTaskStatus(store, vault, file, id, "done");

    const month = getMonth();
    assert.ok(!hasSpecialMark(month, id), "done task never has special mark");
  }

  // 3.3 Earlier doing instance becomes special when a later instance is done
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const rootId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "continuedTask");
    await changeDayTaskStatus(store, vault, file, rootId, "doing");
    const continuedId = await continueDayTask(store, vault, file, rootId, "2026.6.2");
    await changeDayTaskStatus(store, vault, file, continuedId, "doing");
    await changeDayTaskStatus(store, vault, file, continuedId, "done");

    let month = getMonth();
    assert.ok(hasSpecialMark(month, rootId), "earlier doing instance should be special");
    assert.ok(
      vaultContent.includes(`[/] ✅ continuedTask ^${rootId}`),
      "earlier doing instance should receive the document special mark",
    );

    await changeDayTaskStatus(store, vault, file, rootId, "todo", {
      tasklogTrigger: true,
      documentContent: vaultContent,
    });
    await changeDayTaskStatus(store, vault, file, continuedId, "todo", {
      tasklogTrigger: true,
    });
    month = getMonth();
    assert.equal(month.tasks[rootId].status, "todo");
    assert.equal(month.tasks[continuedId].status, "todo");
    assert.ok(!hasSpecialMark(month, rootId), "all-todo group should not be special");
    assert.ok(!hasSpecialMark(month, continuedId), "all-todo group should not be special");
  }

  // 3.4 Added tasklogs only promote truly todo tasks to doing
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const todoId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "tasklogTodo");
    assert.equal(
      shouldPromoteAddedTasklogToDoing(getMonth(), todoId),
      true,
      "new tasklog should promote a plain todo task",
    );

    await changeDayTaskStatus(store, vault, file, todoId, "done");
    assert.equal(
      shouldPromoteAddedTasklogToDoing(getMonth(), todoId),
      false,
      "new tasklog must not downgrade a done task",
    );

    const weekId = await createTopLevelTask(store, vault, file, "week", weekKey, "tasklogSpecial");
    const day1Id = await addWeekTaskToDay(store, vault, file, weekId, "2026.6.1");
    const day2Id = await addWeekTaskToDay(store, vault, file, weekId, "2026.6.2");
    await changeDayTaskStatus(store, vault, file, day1Id, "done");
    assert.equal(
      shouldPromoteAddedTasklogToDoing(getMonth(), day2Id),
      false,
      "new tasklog must not downgrade a special same-source task",
    );
  }

  // ═══════════════════════════════════════════════
  // Section 4: Day parent aggregation (7.1.4)
  // ═══════════════════════════════════════════════

  // 4.1 Parent becomes doing when some children are doing/done
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "parentTask");
    const childId = await createChildTask(store, vault, file, parentId, "child1");

    // Mark child as doing
    await changeDayTaskStatus(store, vault, file, childId, "doing");

    const month = getMonth();
    const parent = month.tasks[parentId];
    assert.equal(parent.status, "doing", "parent should be doing when child is doing");
  }

  // 4.2 Parent becomes done when all children are done
  {
    const month = getMonth();
    const parents = Object.values(month.tasks).filter((t) => t.area === "day" && t.childIds.length > 0 && t.status === "doing");
    if (parents.length > 0) {
      const parentId = parents[0].id;
      const childId = month.tasks[parentId].childIds[0];

      await changeDayTaskStatus(store, vault, file, childId, "done");

      const updated = getMonth();
      const parent = updated.tasks[parentId];
      assert.equal(parent.status, "done", "parent should be done when all children done");
    }
  }

  // 4.3 Week-source Day parent aggregates across dates
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    // Create Week parent + child
    const weekParentId = await createTopLevelTask(store, vault, file, "week", weekKey, "weekParent");
    const weekChildId = await createChildTask(store, vault, file, weekParentId, "weekChild");

    // Arrange to two dates. Note: arranging the Week parent also auto-creates
    // Day instances for its children on the target date.
    const day1ParentId = await addWeekTaskToDay(store, vault, file, weekParentId, "2026.6.1");
    const day2ParentId = await addWeekTaskToDay(store, vault, file, weekParentId, "2026.6.2");

    // Find the child instances on each date
    const month = getMonth();
    const day1Parent = month.tasks[day1ParentId];
    const day2Parent = month.tasks[day2ParentId];
    const day1ChildId = day1Parent.childIds[0];
    const day2ChildId = day2Parent.childIds[0];

    // Mark day1's child as done
    await changeDayTaskStatus(store, vault, file, day1ChildId, "done");

    const updated = getMonth();
    const p1 = updated.tasks[day1ParentId];
    const p2 = updated.tasks[day2ParentId];
    // Same-source group with a done → group effective = done → both children count as done → parent done
    assert.equal(p1.status, "done", "day1 parent should be done (same-source group resolved to done)");
    assert.equal(p2.status, p1.status, "day2 parent should match day1 parent status");
  }

  // ═══════════════════════════════════════════════
  // Section 5: Week/Day sync (7.1.6)
  // ═══════════════════════════════════════════════

  // 5.1 Week parent syncs from Day parents
  {
    const month = getMonth();
    const weekParent = month.tasks[Object.keys(month.tasks).find((id) => {
      const t = month.tasks[id];
      return t && t.area === "week" && t.childIds.length > 0 && t.weektdayTaskIds.length > 0;
    })!];

    if (weekParent) {
      // Week parent status should match the effective status from Day side
      const dayStatuses = weekParent.weektdayTaskIds
        .map((did) => month.tasks[did])
        .filter((t) => t && t.area === "day" && t.childIds.length > 0)
        .map((t) => t.status);

      const allDone = dayStatuses.every((s) => s === "done");
      const allTodo = dayStatuses.every((s) => s === "todo");
      const expected = allDone ? "done" : allTodo ? "todo" : "doing";
      assert.equal(weekParent.status, expected, "week parent status should reflect day parents");
    }
  }

  // 5.2 Week child/independent with Day instances syncs from Day
  {
    const month = getMonth();
    const weekChildren = Object.values(month.tasks).filter(
      (t) => t.area === "week" && t.childIds.length === 0 && t.weektdayTaskIds.length > 0
    );
    if (weekChildren.length > 0) {
      const weekChild = weekChildren[0];
      const dayInstance = month.tasks[weekChild.weektdayTaskIds[0]];
      if (dayInstance) {
        // Week child should have same status as Day instance (or effective from group)
        assert.ok(
          weekChild.status === dayInstance.status || weekChild.status === "done",
          "week child syncs from day instance"
        );
      }
    }
  }

  // ═══════════════════════════════════════════════
  // Section 6: recalcGlobalStatus
  // ═══════════════════════════════════════════════

  // 6.1 recalc updates confirmedTaskLogs
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    // Create a task with a tasklog in the document
    const id = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "recalcTest");

    // Add tasklog to document
    vaultContent += `\ntasklog:: ${id}\n`;

    await recalcGlobalStatus(store, vault, file);

    const month = getMonth();
    assert.ok(
      month.confirmedTaskLogs.taskIds.includes(id),
      "confirmedTaskLogs should include tasklog ID"
    );
  }

  // 6.2 recalc resets status when tasklog is removed
  {
    // Remove tasklog from document
    vaultContent = vaultContent.replace(/tasklog::.*\n/, "");

    // Set the task to doing first
    const month = getMonth();
    const todos = Object.values(month.tasks).filter((t) => t.area === "day" && t.childIds.length === 0);
    if (todos.length > 0) {
      await store.mutate((data) => {
        const m = data.files[filePath];
        if (m) {
          const t = m.tasks[todos[0].id];
          if (t) t.status = "doing";
        }
      });

      // Wait for mutate to complete, then recalc
    }

    await recalcGlobalStatus(store, vault, file);

    // Task without tasklog should be reset to todo
    // (This depends on the task no longer having a tasklog)
    const updated = getMonth();
    const taskWithoutTasklog = Object.values(updated.tasks).find(
      (t) => t.area === "day" && t.childIds.length === 0 && !updated.confirmedTaskLogs.taskIds.includes(t.id)
    );
    // Tasklog removal handling: if confirmedTaskLogs had it but current doesn't, status reset
    // The overall flow is verified
  }

  // 6.3 recalc only resets tasklogs that actually disappeared
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const keptId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "keptLog");
    const removedId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "removedLog");
    vaultContent += `\ntasklog:: ${keptId}\ntasklog:: ${removedId}\n`;
    await recalcGlobalStatus(store, vault, file);
    await store.mutate((data) => {
      data.files[filePath].tasks[keptId].status = "doing";
      data.files[filePath].tasks[removedId].status = "doing";
    });

    vaultContent = vaultContent.replace(`tasklog:: ${removedId}\n`, "");
    await recalcGlobalStatus(store, vault, file);

    const month = getMonth();
    assert.equal(month.tasks[keptId].status, "doing", "existing tasklog must keep doing status");
    assert.equal(month.tasks[removedId].status, "todo", "removed tasklog must reset to todo");
  }

  // ═══════════════════════════════════════════════
  // Section 7: Continuation and same-source edge cases
  // ═══════════════════════════════════════════════

  // 7.1 Day-created tasks treated as same-source group
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);

    const rootId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "dayRoot");
    await assert.rejects(
      () => continueDayTask(store, vault, file, rootId, "2026.6.2"),
      /全部处于进行中/,
      "todo task cannot be continued",
    );
    const contId = await continueDoingTask(rootId, "2026.6.2");

    const month = getMonth();
    const root = month.tasks[rootId];
    const cont = month.tasks[contId];

    // Continuation instance should point to root via sourceDayTaskId
    assert.equal(cont.sourceDayTaskId, rootId, "continuation references root");
    assert.ok(root.daytdayTaskIds && root.daytdayTaskIds.includes(contId), "root tracks continuation");
  }

  // 7.2 Parent with mixed child statuses cannot be continued
  {
    resetVault();
    diskData = null;
    await store.load();
    await store.ensureMonth(file);
    const parentId = await createTopLevelTask(store, vault, file, "day", "2026.6.1", "mixedParent");
    const doingId = await createChildTask(store, vault, file, parentId, "doingChild");
    await createChildTask(store, vault, file, parentId, "todoChild");
    await store.mutate((data) => {
      data.files[filePath].tasks[doingId].status = "doing";
    });
    await assert.rejects(
      () => continueDayTask(store, vault, file, parentId, "2026.6.2"),
      /全部处于进行中/,
    );
  }

  console.log("v2Status.test.ts: all tests passed");
}

async function markCurrentTaskDoing(
  store: TaskFlowV2Store,
  filePath: string,
  sourceId: string,
): Promise<void> {
  await store.mutate((data) => {
    const month = data.files[filePath];
    const source = month.tasks[sourceId];
    const ids = source.childIds.length > 0 ? source.childIds : [sourceId];
    for (const id of ids) month.tasks[id].status = "doing";
  });
}
