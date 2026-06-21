import * as assert from "node:assert/strict";
import { buildMonthWeeks } from "../calendar";
import {
  buildPriorUnfinishedSections,
  buildTaskTree,
  buildUnfinishedTasks,
  buildWeekTaskTree
} from "../taskProjection";
import { createTaskId } from "../store/v2Id";
import { normalizeTaskFlowV2Data } from "../store/v2Normalize";
import { getDayTaskIds, getWeekTaskIds, MonthTaskData, TaskFlowV2Data } from "../store/v2Schema";
import { TaskFlowV2Store } from "../store/v2Store";

const normalizedLegacy = normalizeTaskFlowV2Data({
  version: 1,
  files: {
    "old.md": {}
  }
});
assert.equal(normalizedLegacy.version, 2);
assert.deepEqual(normalizedLegacy.files, {});
assert.equal("legacyV1" in normalizedLegacy, false);

const normalizedOldV2 = normalizeTaskFlowV2Data({
  version: 2,
  updatedAt: "2026-06-06T00:00:00.000Z",
  files: {
    "notes/2026.6.md": {
      updatedAt: "2026-06-06T00:00:00.000Z",
      tasks: {
        "old-parent": {
          area: "week",
          areaKey: "2026.6.1-6.7",
          name: "parent",
          parentId: null,
          childIds: ["old-child"],
          sourceGroupId: null
        },
        "old-child": {
          area: "week",
          areaKey: "2026.6.1-6.7",
          name: "child",
          parentId: "old-parent",
          childIds: [],
          sourceGroupId: null
        },
        "old-day-1": {
          area: "day",
          areaKey: "2026.6.1",
          name: "continued",
          parentId: null,
          childIds: [],
          sourceGroupId: "old-group"
        },
        "old-day-2": {
          area: "day",
          areaKey: "2026.6.2",
          name: "continued",
          parentId: null,
          childIds: [],
          sourceGroupId: "old-group"
        }
      },
      weekTaskIds: {
        "2026.6.1-6.7": ["old-parent"]
      },
      dayTaskIds: {
        "2026.6.1": ["old-day-1"],
        "2026.6.2": ["old-day-2"]
      },
      confirmedTaskLogs: {
        taskIds: ["old-day-1"]
      }
    }
  }
});
const normalizedOldMonth = normalizedOldV2.files["notes/2026.6.md"];
// weekTaskIds is root-only; children are tracked via parent.childIds
assert.deepEqual(
  getWeekTaskIds(normalizedOldMonth, "2026.6.1-6.7"),
  [{ id: "old-parent", childIds: ["old-child"] }]
);
assert.equal(normalizedOldMonth.tasks["old-day-2"].sourceDayTaskId, "old-day-1");
assert.deepEqual(normalizedOldMonth.tasks["old-day-1"].daytdayTaskIds, ["old-day-2"]);
assert.equal("sourceGroupId" in normalizedOldMonth.tasks["old-day-1"], false);
assert.equal("updatedAt" in normalizedOldMonth.tasks["old-day-1"], false);
assert.deepEqual(normalizedOldMonth.confirmedTaskLogs.taskIds, ["old-day-1"]);

const repairedWeekParent = normalizeTaskFlowV2Data({
  version: 2,
  updatedAt: "2026-06-07T00:00:00.000Z",
  files: {
    "notes/2026.6.md": {
      tasks: {
        "tf-w-0001": {
          area: "week",
          areaKey: "2026.6.1-6.7",
          name: "111",
          parentId: null,
          childIds: ["tf-w-0002"],
          weektdayTaskIds: []
        },
        "tf-w-0002": {
          area: "week",
          areaKey: "2026.6.1-6.7",
          name: "222",
          parentId: "tf-w-0001",
          childIds: [],
          weektdayTaskIds: ["tf-d-0001"]
        },
        "tf-d-0001": {
          area: "day",
          areaKey: "2026.6.1",
          name: "222",
          parentId: null,
          childIds: [],
          sourceWeekTaskId: "tf-w-0002"
        }
      },
      weekTaskIds: {
        "2026.6.1-6.7": ["tf-w-0001", "tf-w-0002"]
      },
      dayTaskIds: {
        "2026.6.1": ["tf-d-0001"]
      },
      confirmedTaskLogs: { taskIds: [] }
    }
  }
});
const repairedMonth = repairedWeekParent.files["notes/2026.6.md"];
const repairedParent = Object.values(repairedMonth.tasks).find(
  (task) => task.area === "day" && task.sourceWeekTaskId === "tf-w-0001"
);
assert.ok(repairedParent);
assert.deepEqual(repairedParent.childIds, ["tf-d-0001"]);
assert.equal(repairedMonth.tasks["tf-d-0001"].parentId, repairedParent.id);
const firstDayItem = getDayTaskIds(repairedMonth, "2026.6.1")[0];
assert.equal(typeof firstDayItem === "string" ? firstDayItem : firstDayItem.id, repairedParent.id);
assert.deepEqual(
  repairedMonth.tasks["tf-w-0001"].weektdayTaskIds,
  [repairedParent.id]
);

const idData: TaskFlowV2Data = {
  version: 2,
  updatedAt: "2026-06-06T00:00:00.000Z",
  files: {}
};
assert.equal(createTaskId(idData, "day"), "tf-d-0001");
idData.files.test = {
  tasks: {
    "tf-d-0001": {
      id: "tf-d-0001",
      area: "day",
      areaKey: "2026.6.1",
      name: "test",
      status: "todo",
      parentId: null,
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    }
  },
  weeks: {
    "2026.6.1-6.7": {
      weekTaskIds: [],
      days: { "2026.6.1": { dayTaskIds: ["tf-d-0001"] } }
    }
  },
  confirmedTaskLogs: { taskIds: [] }
};
assert.equal(createTaskId(idData, "day"), "tf-d-0002");

const monthData: MonthTaskData = {
  tasks: {
    "tf-w-parent": {
      id: "tf-w-parent",
      area: "week",
      areaKey: "2026.6.1-6.7",
      name: "父任务",
      status: "doing",
      parentId: null,
      childIds: ["tf-w-child"],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-w-child": {
      id: "tf-w-child",
      area: "week",
      areaKey: "2026.6.1-6.7",
      name: "子任务",
      status: "todo",
      parentId: "tf-w-parent",
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-w-task-a": {
      id: "tf-w-task-a",
      area: "week",
      areaKey: "2026.6.1-6.7",
      name: "taskA",
      status: "todo",
      parentId: null,
      childIds: ["tf-w-task-a-1", "tf-w-task-a-2", "tf-w-task-a-3"],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: ["tf-d-task-a"],
      daytdayTaskIds: null
    },
    "tf-w-task-a-1": {
      id: "tf-w-task-a-1",
      area: "week",
      areaKey: "2026.6.1-6.7",
      name: "taskA.1",
      status: "todo",
      parentId: "tf-w-task-a",
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: ["tf-d-task-a-1"],
      daytdayTaskIds: null
    },
    "tf-w-task-a-2": {
      id: "tf-w-task-a-2",
      area: "week",
      areaKey: "2026.6.1-6.7",
      name: "taskA.2",
      status: "todo",
      parentId: "tf-w-task-a",
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: ["tf-d-task-a-2"],
      daytdayTaskIds: null
    },
    "tf-w-task-a-3": {
      id: "tf-w-task-a-3",
      area: "week",
      areaKey: "2026.6.1-6.7",
      name: "taskA.3",
      status: "todo",
      parentId: "tf-w-task-a",
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-task-a": {
      id: "tf-d-task-a",
      area: "day",
      areaKey: "2026.6.2",
      name: "taskA",
      status: "doing",
      parentId: null,
      childIds: ["tf-d-task-a-1", "tf-d-task-a-2"],
      sourceWeekTaskId: "tf-w-task-a",
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-task-a-1": {
      id: "tf-d-task-a-1",
      area: "day",
      areaKey: "2026.6.2",
      name: "taskA.1",
      status: "doing",
      parentId: "tf-d-task-a",
      childIds: [],
      sourceWeekTaskId: "tf-w-task-a-1",
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-task-a-2": {
      id: "tf-d-task-a-2",
      area: "day",
      areaKey: "2026.6.2",
      name: "taskA.2",
      status: "done",
      parentId: "tf-d-task-a",
      childIds: [],
      sourceWeekTaskId: "tf-w-task-a-2",
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-one": {
      id: "tf-d-one",
      area: "day",
      areaKey: "2026.6.1",
      name: "6.1 未完成",
      status: "todo",
      parentId: null,
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-two": {
      id: "tf-d-two",
      area: "day",
      areaKey: "2026.6.2",
      name: "6.2 已完成",
      status: "done",
      parentId: null,
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-task-d": {
      id: "tf-d-task-d",
      area: "day",
      areaKey: "2026.6.2",
      name: "taskD",
      status: "todo",
      parentId: null,
      childIds: ["tf-d-task-d-1", "tf-d-task-d-2"],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-task-d-1": {
      id: "tf-d-task-d-1",
      area: "day",
      areaKey: "2026.6.2",
      name: "taskD.1",
      status: "todo",
      parentId: "tf-d-task-d",
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-task-d-2": {
      id: "tf-d-task-d-2",
      area: "day",
      areaKey: "2026.6.2",
      name: "taskD.2",
      status: "todo",
      parentId: "tf-d-task-d",
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    },
    "tf-d-current": {
      id: "tf-d-current",
      area: "day",
      areaKey: "2026.6.3",
      name: "今日任务",
      status: "todo",
      parentId: null,
      childIds: [],
      sourceWeekTaskId: null,
      sourceDayTaskId: null,
      weektdayTaskIds: [],
      daytdayTaskIds: null
    }
  },
  weeks: {
    "2026.6.1-6.7": {
      weekTaskIds: [
        { id: "tf-w-parent", childIds: ["tf-w-child"] },
        { id: "tf-w-task-a", childIds: ["tf-w-task-a-1", "tf-w-task-a-2", "tf-w-task-a-3"] }
      ],
      days: {
        "2026.6.1": { dayTaskIds: ["tf-d-one"] },
        "2026.6.2": {
          dayTaskIds: [
            "tf-d-two",
            { id: "tf-d-task-a", childIds: ["tf-d-task-a-1", "tf-d-task-a-2"] },
            { id: "tf-d-task-d", childIds: ["tf-d-task-d-1", "tf-d-task-d-2"] }
          ]
        },
        "2026.6.3": { dayTaskIds: ["tf-d-current"] }
      }
    }
  },
  confirmedTaskLogs: { taskIds: [] }
};

const weekTree = buildTaskTree(monthData, getWeekTaskIds(monthData, "2026.6.1-6.7"));
const parentTask = weekTree.find((task) => task.name === "父任务");
assert.ok(parentTask);
assert.equal(parentTask.children?.[0].name, "子任务");

const pendingWeekTree = buildWeekTaskTree(
  monthData,
  getWeekTaskIds(monthData, "2026.6.1-6.7"),
  "pending"
);
const pendingTaskA = pendingWeekTree.find((task) => task.name === "taskA");
assert.deepEqual(
  pendingTaskA?.children?.map((task) => task.name),
  ["taskA.3"]
);

const allWeekTree = buildWeekTaskTree(
  monthData,
  getWeekTaskIds(monthData, "2026.6.1-6.7"),
  "all"
);
const allTaskA = allWeekTree.find((task) => task.name === "taskA");
assert.deepEqual(
  allTaskA?.children?.map((task) => ({
    name: task.name,
    arrangement: task.arrangementLabel
  })),
  [
    { name: "taskA.1", arrangement: "2026.6.2" },
    { name: "taskA.2", arrangement: "2026.6.2" },
    { name: "taskA.3", arrangement: "未安排" }
  ]
);

const dayTaskA = buildTaskTree(monthData, getDayTaskIds(monthData, "2026.6.2"))
  .find((task) => task.name === "taskA");
assert.deepEqual(dayTaskA?.children?.map((task) => task.name), ["taskA.1", "taskA.2"]);
assert.equal(dayTaskA?.progress?.completed, 1);
assert.equal(dayTaskA?.progress?.total, 3);
assert.deepEqual(dayTaskA?.progress?.items.map((task) => task.name), ["taskA.1", "taskA.2", "taskA.3"]);
assert.deepEqual(
  dayTaskA?.progress?.items.filter((task) => task.latestDayKey).map((task) => task.name),
  ["taskA.1", "taskA.2"],
);

const juneWeek = buildMonthWeeks({ year: 2026, month: 6 })[0];
const priorSections = buildPriorUnfinishedSections(monthData, juneWeek, "2026.6.3");
assert.deepEqual(
  priorSections.map((section) => ({
    id: section.id,
    tasks: section.tasks.map((task) => ({
      name: task.name,
      legacy: task.legacyDateLabel,
      children: task.children?.map((child) => ({
        name: child.name,
        legacy: child.legacyDateLabel
      }))
    }))
  })),
  [
    {
      id: "doing",
      tasks: [
        {
          name: "taskA",
          legacy: undefined,
          children: [{ name: "taskA.1", legacy: undefined }]
        }
      ]
    },
    {
      id: "todo",
      tasks: [
        {
          name: "taskD",
          legacy: "6.2遗留",
          children: [
            { name: "taskD.1", legacy: "6.2遗留" },
            { name: "taskD.2", legacy: "6.2遗留" }
          ]
        },
        {
          name: "6.1 未完成",
          legacy: "6.1遗留",
          children: undefined
        }
      ]
    }
  ]
);
assert.deepEqual(buildUnfinishedTasks(monthData, juneWeek, "2026.6.1"), []);
assert.deepEqual(
  buildUnfinishedTasks(monthData, juneWeek, "2026.6.3").map((task) => ({
    date: task.name,
    tasks: task.children?.map((child) => child.name)
  })),
  [
    { date: "6.1", tasks: ["6.1 未完成"] },
    { date: "6.2", tasks: ["taskA", "taskD"] }
  ]
);

void run();

async function run(): Promise<void> {
  let diskData: unknown = {
    version: 1,
    old: true
  };
  let saveCount = 0;
  const fakePlugin = {
    async loadData(): Promise<unknown> {
      return structuredClone(diskData);
    },
    async saveData(data: TaskFlowV2Data): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 2));
      diskData = structuredClone(data);
      saveCount += 1;
    }
  };
  const store = new TaskFlowV2Store(fakePlugin as never);
  await store.load();
  await Promise.all([
    store.ensureMonth({ path: "notes/2026.6.md" } as never),
    store.ensureMonth({ path: "notes/2026.6.md" } as never),
    store.ensureMonth({ path: "notes/2026.6.md" } as never)
  ]);
  assert.equal(saveCount, 1);
  await Promise.all([
    store.mutate((data) => {
      getWeekTaskIds(data.files["notes/2026.6.md"], "first");
    }),
    store.mutate((data) => {
      getDayTaskIds(data.files["notes/2026.6.md"], "second");
    })
  ]);

  const saved = diskData as TaskFlowV2Data;
  assert.equal(saved.version, 2);
  assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));
  assert.deepEqual(getWeekTaskIds(saved.files["notes/2026.6.md"], "first"), []);
  assert.deepEqual(getDayTaskIds(saved.files["notes/2026.6.md"], "second"), []);
  assert.equal("legacyV1" in saved, false);

  diskData = {
    ...saved,
    updatedAt: "2026-07-01T00:00:00.000Z",
    files: {
      ...saved.files,
      "notes/2026.7.md": {
        tasks: {},
        weeks: {},
        confirmedTaskLogs: { taskIds: [] }
      }
    }
  };
  await store.reloadExternal();
  assert.ok(await store.getMonth({ path: "notes/2026.7.md" } as never));

  console.log("v2 data tests passed");
}
