# Stage 4 任务创建 — 方案

## 1. 功能定位

任务创建负责产生新任务记录或新的任务实例，并建立完整的父子和来源关系。

创建阶段不负责：删除、改名、排序、层级调整、日期移动、状态计算、Markdown 投影。

每次创建操作是一次完整事务。失败或取消时不留半完成数据。

---

## 2. 创建任务（面板标题 +）

### 2.1 Week 面板标题的 +

用户点击 Week 面板标题右侧的 `+` → 输入框出现 → 输入名称 → Enter 或失焦确认。

```
month.tasks 新增：
  ["tf-w-0012"]: {
    id: "tf-w-0012",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "用户输入的名称",
    status: "todo",
    parentId: null,
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.weeks 变更：
  ["2026.6.2-2026.6.8"].weekTaskIds:
    原：[..., "tf-w-0008"]
    新：[..., "tf-w-0008", "tf-w-0012"]
```

### 2.2 Day 面板标题的 +

用户点击 Day 面板标题右侧的 `+` → 输入框出现 → 输入名称 → 确认。

```
month.tasks 新增：
  ["tf-d-0012"]: {
    id: "tf-d-0012",
    area: "day",
    areaKey: "2026.6.5",
    name: "用户输入的名称",
    status: "todo",
    parentId: null,
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds:
    原：[..., "tf-d-0008"]
    新：[..., "tf-d-0008", "tf-d-0012"]
```

---

## 3. 创建子任务（任务行 +）

### 3.1 Week 区域

#### 点在 Week 独立任务上

用户点击一个 Week 独立任务（childIds 为空、parentId 为空）行右侧的 `+`。

**拒绝条件**：该任务被安排到了 Day（weektdayTaskIds 非空），且存在任一 Day 实例的 status 不为 "todo"。原因：进行中或已完成的 Day 实例已有工作记录，若 Week 源变为父任务，其状态将被新的子任务汇总所取代，原有工作记录和推进路径被打乱。

- weektdayTaskIds 为空 → 允许
- weektdayTaskIds 非空，但所有 Day 实例 status 均为 "todo" → 允许
- weektdayTaskIds 非空，且存在 Day 实例 status 不是 "todo" → 拒绝

通过后，该任务从独立任务变为父任务，下方出现子任务。

```
month.tasks 新增：
  ["tf-w-0015"]: {
    id: "tf-w-0015",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",       // 继承父
    name: "用户输入的名称",
    status: "todo",
    parentId: "tf-w-0012",                // 指向被点击的任务
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-w-0012"].childIds: [] → ["tf-w-0015"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].weekTaskIds:
    原：[..., "tf-w-0012"]
    新：[..., {id: "tf-w-0012", childIds: ["tf-w-0015"]}]
```

#### 点在 Week 父任务上

用户点击一个 Week 父任务（childIds 非空）行右侧的 `+` → 输入名称 → 确认。

```
month.tasks 新增：
  ["tf-w-0016"]: {
    id: "tf-w-0016",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "用户输入的名称",
    status: "todo",
    parentId: "tf-w-0012",
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-w-0012"].childIds: ["tf-w-0015"] → ["tf-w-0015", "tf-w-0016"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].weekTaskIds 中 "tf-w-0012" 对应的 TaskIdNode:
    childIds: ["tf-w-0015"] → ["tf-w-0015", "tf-w-0016"]
```

#### 点在 Week 子任务上

拒绝。子任务已有 parentId，不允许三级任务。

---

### 3.2 Day 区域 — 点在 Day 本地任务上

Day 本地任务指 sourceWeekTaskId 为空的 Day 任务，包括 Day 中直接创建的和延续根。

#### 点在 Day 独立任务上

用户点击一个 Day 独立任务（childIds 为空、parentId 为空）行右侧的 `+`。

**拒绝条件**：该任务 status 不为 "todo" 时拒绝。状态已是进行中或已完成的独立任务，若变为父任务，其状态将被子任务汇总取代，原有工作记录和推进路径被打乱。只有未开始的独立任务允许添加子任务。

通过后，该任务从独立变为父任务，下方出现子任务。

```
month.tasks 新增：
  ["tf-d-0020"]: {
    id: "tf-d-0020",
    area: "day",
    areaKey: "2026.6.5",                   // 继承父
    name: "用户输入的名称",
    status: "todo",
    parentId: "tf-d-0012",                  // 指向被点击的任务
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0012"].childIds: [] → ["tf-d-0020"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds:
    原：[..., "tf-d-0012"]
    新：[..., {id: "tf-d-0012", childIds: ["tf-d-0020"]}]
```

#### 点在 Day 父任务上

用户点击一个 Day 父任务（childIds 非空）行右侧的 `+` → 输入名称 → 确认。

```
month.tasks 新增：
  ["tf-d-0021"]: {
    id: "tf-d-0021",
    area: "day",
    areaKey: "2026.6.5",                   // 继承父
    name: "用户输入的名称",
    status: "todo",
    parentId: "tf-d-0012",
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0012"].childIds: ["tf-d-0020"] → ["tf-d-0020", "tf-d-0021"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds 中 "tf-d-0012" 对应的 TaskIdNode:
    childIds: ["tf-d-0020"] → ["tf-d-0020", "tf-d-0021"]
```

#### 点在 Day 子任务上

拒绝。子任务已有 parentId。

---

### 3.3 Day 区域 — 点在 Week 来源任务上

Week 来源任务指 sourceWeekTaskId 非空的 Day 任务。不论该任务是否已被延续到其他日期。

#### 点在 Week 来源 Day 父任务上

用户点击的 Day 父任务有 Week 来源 → 操作分两步：

1. 找到 Day 任务的 sourceWeekTaskId 对应的 Week 源父任务，在其下创建 Week 子任务
2. 将该新 Week 子任务安排到当天

数据变化：先执行 3.1「点在 Week 父任务上」的数据变更，再执行 4.2 的安排逻辑。

用户无需切到 Week 面板。结果在 Day 中可见新子任务。

#### 点在 Week 来源 Day 独立任务上

用户点击的 Day 独立任务有 Week 来源。

**拒绝条件**：该任务 status 不为 "todo" 时拒绝。原因同 3.2 Day 独立任务的拒绝条件。

通过后，操作分两步：

1. 找到 Day 任务的 sourceWeekTaskId 对应的 Week 源独立任务，在其下创建 Week 子任务（源任务从独立变为父任务）
2. 将该新 Week 子任务安排到当天

数据变化：先执行 3.1「点在 Week 独立任务上」的数据变更，再执行 4.2 的安排逻辑。

#### 点在 Week 来源 Day 子任务上

拒绝。子任务已有 parentId。

---

### 3.4 Day 区域 — 点在 Day 延续实例上

Day 延续实例指 sourceDayTaskId 非空的 Day 任务——即它是由前面某天的 Day 任务延续到今天产生的。

延续实例本身就是一条真实的 Day 任务记录。子任务直接创建在该延续实例下面，不创建到延续根下。

#### 点在延续产生的 Day 父任务实例上

用户点击的 Day 父任务是延续实例（sourceDayTaskId 非空、childIds 非空）→ 直接在它下面创建子任务。

```
month.tasks 新增：
  ["tf-d-0030"]: {
    id: "tf-d-0030",
    area: "day",
    areaKey: "2026.6.6",                   // 继承该延续实例
    name: "用户输入的名称",
    status: "todo",
    parentId: "tf-d-0025",                  // 指向该延续实例
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0025"].childIds: ["tf-d-0026"] → ["tf-d-0026", "tf-d-0030"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.6"].dayTaskIds 中 "tf-d-0025" 对应的 TaskIdNode:
    childIds: ["tf-d-0026"] → ["tf-d-0026", "tf-d-0030"]
```

**延续链状态影响**：该延续实例作为父任务，它的状态由其旗下子任务汇总。旗下子任务中，跨日期同源的子任务（即同一个逻辑子任务在不同日期的延续实例）在计数时算作一个。汇总时按去重后的子任务集合计算该父任务的状态和总进度 N/M。

例如：
- 该延续实例旗下有子 A（自己创建的）和子 B（在 day1 创建的，延续到 day2 后有同源实例）
- 子 B 在 day1 和 day2 各有一个实例，算作一个子任务
- 父任务状态看子 A + 子 B 的汇总，总进度分母为 2

#### 点在延续产生的 Day 独立任务实例上

用户点击的 Day 独立任务是延续实例（sourceDayTaskId 非空、childIds 为空）。

**拒绝条件**：该任务 status 不为 "todo" 时拒绝。

通过后，直接在它下面创建子任务。该延续实例从独立变为父任务。

```
month.tasks 新增：
  ["tf-d-0034"]: {
    id: "tf-d-0034",
    area: "day",
    areaKey: "2026.6.6",
    name: "用户输入的名称",
    status: "todo",
    parentId: "tf-d-0028",                  // 指向该延续实例
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0028"].childIds: [] → ["tf-d-0034"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.6"].dayTaskIds:
    原：[..., "tf-d-0028"]
    新：[..., {id: "tf-d-0028", childIds: ["tf-d-0034"]}]
```

该延续实例变为父任务后，状态汇总规则同上（跨日期同源子任务去重计数）。

#### 点在延续产生的 Day 子任务实例上

拒绝。子任务已有 parentId。

---

## 4. 将 Week 任务安排到 Day

入口：Week 任务右键菜单 →「添加到指定日期」→ 在日期选择弹窗中选择目标日期。

本质：不移动 Week 任务。Week 原任务保留，目标日生成对应的 Day 实例。

假设目标日期为 `2026.6.5`，所属周键为 `2026.6.2-2026.6.8`。

### 4.1 Week 父任务安排到某天

用户右键 Week 父任务（childIds 非空）→ 选择目标日期 → 确认。

假设该 Week 父任务为 `tf-w-0010`，旗下子任务为 `tf-w-0011`、`tf-w-0012`。

```
month.tasks 新增：
  ["tf-d-0040"]: {
    id: "tf-d-0040",
    area: "day",
    areaKey: "2026.6.5",
    name: "tf-w-0010 的名称",               // 同步自 Week 源
    status: "todo",
    parentId: null,
    childIds: ["tf-d-0041", "tf-d-0042"],
    sourceWeekTaskId: "tf-w-0010",
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }
  ["tf-d-0041"]: {
    id: "tf-d-0041",
    area: "day",
    areaKey: "2026.6.5",
    name: "tf-w-0011 的名称",
    status: "todo",
    parentId: "tf-d-0040",
    childIds: [],
    sourceWeekTaskId: "tf-w-0011",
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }
  ["tf-d-0042"]: { ... }                    // 对应 tf-w-0012，字段同上

month.tasks 变更：
  ["tf-w-0010"].weektdayTaskIds: [...] → [..., "tf-d-0040"]
  ["tf-w-0011"].weektdayTaskIds: [...] → [..., "tf-d-0041"]
  ["tf-w-0012"].weektdayTaskIds: [...] → [..., "tf-d-0042"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds:
    原：[...]
    新：[..., {id: "tf-d-0040", childIds: ["tf-d-0041", "tf-d-0042"]}]
```

### 4.2 Week 子任务单独安排到某天

用户右键 Week 子任务（parentId 非空，设为 `tf-w-0011`，其父为 `tf-w-0010`）→ 选择目标日期。

父任务自动跟过去，作为层级容器。未安排的兄弟子任务不出现在目标日。

```
month.tasks 新增：
  ["tf-d-0043"]: {
    id: "tf-d-0043",
    area: "day",
    areaKey: "2026.6.5",
    name: "tf-w-0010 的名称",               // 父任务同步过去
    status: "todo",
    parentId: null,
    childIds: ["tf-d-0044"],
    sourceWeekTaskId: "tf-w-0010",
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }
  ["tf-d-0044"]: {
    id: "tf-d-0044",
    area: "day",
    areaKey: "2026.6.5",
    name: "tf-w-0011 的名称",
    status: "todo",
    parentId: "tf-d-0043",
    childIds: [],
    sourceWeekTaskId: "tf-w-0011",
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-w-0010"].weektdayTaskIds: [...] → [..., "tf-d-0043"]
  ["tf-w-0011"].weektdayTaskIds: [...] → [..., "tf-d-0044"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds:
    原：[...]
    新：[..., {id: "tf-d-0043", childIds: ["tf-d-0044"]}]
```

### 4.3 Week 独立任务安排到某天

用户右键 Week 独立任务（childIds 为空、parentId 为空）→ 选择目标日期。

```
month.tasks 新增：
  ["tf-d-0045"]: {
    id: "tf-d-0045",
    area: "day",
    areaKey: "2026.6.5",
    name: "tf-w-0013 的名称",
    status: "todo",
    parentId: null,
    childIds: [],
    sourceWeekTaskId: "tf-w-0013",
    sourceDayTaskId: null,
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-w-0013"].weektdayTaskIds: [...] → [..., "tf-d-0045"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds:
    原：[...]
    新：[..., "tf-d-0045"]
```

### 4.4 同一父任务下多个子任务安排到同一天

用户先将子任务 A 安排到某日，再将同父下的子任务 B 也安排到同日。

安排 A 时：执行 4.2 → 创建 Day 父实例 + Day 子实例 A。
安排 B 时：创建 Day 子实例 B，追加到已存在的 Day 父实例的 childIds 中。不会重复创建 Day 父实例。

```
// 安排 B 后，Day 父实例的变更：
month.tasks 变更：
  ["tf-d-0043"].childIds: ["tf-d-0044"] → ["tf-d-0044", "tf-d-0046"]

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.5"].dayTaskIds 中 "tf-d-0043" 的 TaskIdNode:
    childIds: ["tf-d-0044"] → ["tf-d-0044", "tf-d-0046"]
```

### 4.5 同一任务安排到多个不同日期

同一个 Week 任务安排到 6.5，再安排到 6.6：两次操作独立，各日期各有一份 Day 实例，互不干扰。

### 4.6 目标日已有同来源实例

遍历目标日期的 dayTaskIds，检查 sourceWeekTaskId 是否等于当前 Week 任务 ID。若已存在则跳过不创建。选中任务全部已存在时提示用户。

### 4.7 批量安排

多选 Week 任务后右键安排：对每个选中任务依次执行 4.1-4.4 的逻辑。

### 4.8 拒绝条件

目标日期不在所选周（weekKey 范围）内时拒绝。

---

## 5. 为 Day 任务建立 Week 来源

入口：Day 任务右键菜单 →「添加到周任务」。

本质：不移动 Day 任务。在 Week 中生成对应记录，建立 Day → Week 双向来源关系。

假设目标周键为 Day 任务所在周。

### 5.1 Day 独立任务添加

用户右键一个 Day 独立任务（设为 `tf-d-0050`，childIds 为空、parentId 为空、sourceWeekTaskId 为空、sourceDayTaskId 为空）→「添加到周任务」。

```
month.tasks 新增：
  ["tf-w-0020"]: {
    id: "tf-w-0020",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "tf-d-0050 的名称",               // 同步自 Day 任务
    status: "todo",
    parentId: null,
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: ["tf-d-0050"],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0050"].sourceWeekTaskId: null → "tf-w-0020"
  // sourceDayTaskId 和 daytdayTaskIds 不变

month.weeks 变更：
  ["2026.6.2-2026.6.8"].weekTaskIds:
    原：[...]
    新：[..., "tf-w-0020"]
```

### 5.2 Day 父任务添加

用户右键一个 Day 父任务（设为 `tf-d-0051`，childIds = ["tf-d-0052"]）→「添加到周任务」。

```
month.tasks 新增：
  ["tf-w-0021"]: {
    id: "tf-w-0021",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "tf-d-0051 的名称",
    status: "todo",
    parentId: null,
    childIds: ["tf-w-0022"],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: ["tf-d-0051"],
    daytdayTaskIds: null
  }
  ["tf-w-0022"]: {
    id: "tf-w-0022",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "tf-d-0052 的名称",
    status: "todo",
    parentId: "tf-w-0021",
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: ["tf-d-0052"],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0051"].sourceWeekTaskId: null → "tf-w-0021"
  ["tf-d-0052"].sourceWeekTaskId: null → "tf-w-0022"
  // sourceDayTaskId 不变

month.weeks 变更：
  ["2026.6.2-2026.6.8"].weekTaskIds:
    原：[...]
    新：[..., {id: "tf-w-0021", childIds: ["tf-w-0022"]}]
```

### 5.3 延续链上的任务添加

**延续链父任务添加**：
用户右键延续链上任何一个父任务（不论它是延续根还是第几代延续实例）→「添加到周任务」。

该任务所在的整条延续链打包关联到一个新 Week 任务。无论从链上哪个入口操作，结果相同：链上所有实例的 sourceWeekTaskId 指向新 Week 任务。（它下面的子任务也同样如此，但是注意子任务不能直接这样，下面有说明）

示例：`tf-d-0060` 是延续根父任务（原身份 D4，childIds = ["tf-d-0061"]，daytdayTaskIds = ["tf-d-0070"]）：

```
month.tasks 新增：
  ["tf-w-0030"]: {
    id: "tf-w-0030",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "tf-d-0060 的名称",
    status: "todo",
    parentId: null,
    childIds: ["tf-w-0031"],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: ["tf-d-0060", "tf-d-0070"],  // 根 + 所有延续实例
    daytdayTaskIds: null
  }
  ["tf-w-0031"]: {
    id: "tf-w-0031",
    area: "week",
    areaKey: "2026.6.2-2026.6.8",
    name: "tf-d-0061 的名称",
    status: "todo",
    parentId: "tf-w-0030",
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: null,
    weektdayTaskIds: ["tf-d-0061", "tf-d-0071"],  // 子任务的根 + 延续实例
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0060"].sourceWeekTaskId: null → "tf-w-0030"
  ["tf-d-0061"].sourceWeekTaskId: null → "tf-w-0031"
  ["tf-d-0070"].sourceWeekTaskId: null → "tf-w-0030"   // 延续实例也关联
  ["tf-d-0071"].sourceWeekTaskId: null → "tf-w-0031"
  // sourceDayTaskId 不变，延续链关系不变
  // daytdayTaskIds 不变

month.weeks 变更：
  ["2026.6.2-2026.6.8"].weekTaskIds:
    原：[...]
    新：[..., {id: "tf-w-0030", childIds: ["tf-w-0031"]}]
```

链上所有实例（无论第几代延续）的 sourceWeekTaskId 指向新 Week 任务，sourceDayTaskId 和延续链结构不变。从链上任一任务发起操作，结果一致。

**延续链独立任务添加**：逻辑同上，Week 中产生独立任务，延续链上所有实例建立 Week 来源。

**延续链上的子任务**：不能单独添加（是子任务，属于 5.4 的拒绝范围），需通过其父任务一起添加。

### 5.4 拒绝添加的情况

| 任务类型 | 判定条件 | 原因 |
|----------|----------|------|
| 已有 Week 来源 | sourceWeekTaskId 非空 | 已有来源，不需要重复建立 |
| 是子任务 | parentId 非空 | 只有顶层任务可以添加 |

---

## 6. 将 Day 任务延续到其他日期

入口：Day 任务右键菜单 →「延续到指定日期」→ 在日期选择弹窗中选择同周目标日期。

本质：为已有 Day 任务在目标日生成延续实例。延续实例不改变来源关系。

**状态前提**：

- 非父 Day 任务：自身必须是 `doing`
- Day 父任务：当前日期下全部子任务必须是 `doing`
- 多选：展开父任务后，全部实际操作任务必须是 `doing`
- `todo`、`done`、状态混合时不显示延续入口；数据层也必须再次拒绝

假设源日期为 `2026.6.4`，目标日期为 `2026.6.6`，同属 `2026.6.2-2026.6.8`。

### 6.1 Day 父任务延续

用户右键一个 Day 父任务（设为 `tf-d-0060`，childIds = ["tf-d-0061"]）→ 延续到 2026.6.6。

```
month.tasks 新增：
  ["tf-d-0070"]: {
    id: "tf-d-0070",
    area: "day",
    areaKey: "2026.6.6",
    name: "tf-d-0060 的名称",
    status: "todo",
    parentId: null,
    childIds: ["tf-d-0071"],
    sourceWeekTaskId: null,                  // 若源有 Week 来源则继承
    sourceDayTaskId: "tf-d-0060",            // 指向延续根
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }
  ["tf-d-0071"]: {
    id: "tf-d-0071",
    area: "day",
    areaKey: "2026.6.6",
    name: "tf-d-0061 的名称",
    status: "todo",
    parentId: "tf-d-0070",
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: "tf-d-0061",            // 指向延续根子任务
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0060"].daytdayTaskIds: null → ["tf-d-0070"]
  ["tf-d-0061"].daytdayTaskIds: null → ["tf-d-0071"]
  // 首次延续：tf-d-0060 身份从 D1 变为 D4，tf-d-0061 从 D2 变为 D5

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.6"].dayTaskIds:
    原：[...]
    新：[..., {id: "tf-d-0070", childIds: ["tf-d-0071"]}]
```

### 6.2 Day 子任务单独延续

用户只选 Day 子任务（设为 `tf-d-0061`，parentId = "tf-d-0060"）→ 延续到 2026.6.6。

父任务自动跟到目标日。

```
month.tasks 新增：
  // 父任务自动跟过去
  ["tf-d-0072"]: {
    ...,
    areaKey: "2026.6.6",
    parentId: null,
    childIds: ["tf-d-0073"],
    sourceDayTaskId: "tf-d-0060",
    ...
  }
  // 被选中的子任务延续实例
  ["tf-d-0073"]: {
    ...,
    areaKey: "2026.6.6",
    parentId: "tf-d-0072",
    sourceDayTaskId: "tf-d-0061",
    ...
  }

month.tasks 变更：
  ["tf-d-0060"].daytdayTaskIds: null → ["tf-d-0072"]
  ["tf-d-0061"].daytdayTaskIds: null → ["tf-d-0073"]
  // tf-d-0060：D1 → D4，tf-d-0061：D2 → D5

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.6"].dayTaskIds:
    原：[...]
    新：[..., {id: "tf-d-0072", childIds: ["tf-d-0073"]}]
```

### 6.3 Day 独立任务延续

用户右键 Day 独立任务（设为 `tf-d-0065`，childIds 为空、parentId 为空）→ 延续到 2026.6.6。

```
month.tasks 新增：
  ["tf-d-0074"]: {
    id: "tf-d-0074",
    area: "day",
    areaKey: "2026.6.6",
    name: "tf-d-0065 的名称",
    status: "todo",
    parentId: null,
    childIds: [],
    sourceWeekTaskId: null,
    sourceDayTaskId: "tf-d-0065",
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-d-0065"].daytdayTaskIds: null → ["tf-d-0074"]
  // tf-d-0065 身份从 D3 变为 D6

month.weeks 变更：
  ["2026.6.2-2026.6.8"].days["2026.6.6"].dayTaskIds:
    原：[...]
    新：[..., "tf-d-0074"]
```

### 6.4 Week 来源 Day 任务延续

用户右键一个 Week 来源的 Day 任务（sourceWeekTaskId 非空，设为 `tf-d-0040`，sourceWeekTaskId = "tf-w-0010"）→ 延续到 2026.6.6。

```
month.tasks 新增：
  ["tf-d-0080"]: {
    id: "tf-d-0080",
    area: "day",
    areaKey: "2026.6.6",
    name: "tf-d-0040 的名称",
    status: "todo",
    parentId: null,
    childIds: ["tf-d-0081"],                 // 若有子任务同理延续
    sourceWeekTaskId: "tf-w-0010",           // 不变，仍指向 Week 源
    sourceDayTaskId: null,                   // 不变，不产生 Day 来源
    weektdayTaskIds: [],
    daytdayTaskIds: null
  }

month.tasks 变更：
  ["tf-w-0010"].weektdayTaskIds: [...] → [..., "tf-d-0080"]
  // 不产生 Day 延续根，不产生 daytdayTaskIds
```

**与 Day 延续的差异**：Week 来源任务延续后，新实例的 sourceWeekTaskId 不变，仍指向同一个 Week 源。Week 源任务的 weektdayTaskIds 直接追加新实例。不创建 Day 延续根，不引入 sourceDayTaskId。

若操作的是 Week 来源父任务，子任务同理延续，子延续实例的 sourceWeekTaskId 不变。

### 6.5 从延续实例再做延续

用户右键的任务本身已是延续实例（sourceDayTaskId 非空，指向 `tf-d-0060`）→ 再延续到第三个日期。

新延续实例的 sourceDayTaskId 仍指向同一个根 `tf-d-0060`。不产生新根。

```
month.tasks 新增：
  ["tf-d-0085"]: {
    ...,
    sourceDayTaskId: "tf-d-0060",            // 始终指向同一个根
    ...
  }

month.tasks 变更：
  ["tf-d-0060"].daytdayTaskIds: ["tf-d-0070"] → ["tf-d-0070", "tf-d-0085"]
```

### 6.6 目标日已有同身份任务

**身份判断**：取该任务的 identity = sourceWeekTaskId ?? sourceDayTaskId ?? id。在目标日遍历 dayTaskIds，对每个任务取同样身份链。两者相等即为同身份。

**结果**：
- 原任务无子任务 → 不创建，提示用户
- 原任务有子任务 → 遍历原任务的 childIds，检查目标日是否缺失子任务。缺失的补全创建，已存在的跳过。父实例本身的 childIds 更新为补全后的完整列表

### 6.7 跨周拒绝

目标日期的所属周与源任务所属周不一致时拒绝。

---

## 7. 通用规则

1. **名称**：空名称（去除首尾空格后为空）拒绝创建并弹出提示
2. **层级**：只支持两层，子任务下不能再有子任务
3. **任务身份**：由 sourceWeekTaskId → sourceDayTaskId → id 链决定，不看名称
4. **关系正反同步**：三条关系的正向和反向字段必须同时更新，不单侧写
5. **操作不是移动**：安排/添加/延续后原任务保留在原位
6. **一次事务**：操作完整保存或完全回滚
7. **独立任务非未开始拒绝建子**：
   - Day 独立任务（status 不为 "todo"）→ 拒绝变父任务
   - Week 独立任务（已安排到 Day，且存在 Day 实例 status 不为 "todo"）→ 拒绝变父任务
8. **Day 延续状态限制**：只有当前日期全部为 `doing` 的实际任务允许延续
9. **加号前置提示**：Day 独立任务已开始或已完成时，点击加号立即提示，不先显示任务名称输入框
10. **区块前置检查**：面板标题加号和任务行加号都必须先检查实际需要写入的 Week/Day 区块；缺少区块时立即提示，不显示名称输入框，也不修改任务数据

---

## 8. 不变量

任何创建操作完成后：

- 所有 parentId 指向的任务真实存在
- 所有 childIds 中的 ID 真实存在
- 所有 sourceWeekTaskId 指向的 Week 任务真实存在
- 所有 sourceDayTaskId 指向的 Day 任务真实存在
- 所有 weektdayTaskIds 中的 Day 实例真实存在
- 所有 daytdayTaskIds 中的延续实例真实存在
- 不存在三层及以上的任务层级
- 同名任务各自独立
- 不同月文档路径下的数据互不影响

---

## 9. md 文档同步

每次创建操作在 `store.mutate()` 完成且侧边栏刷新后，同步写入 md 文档。

### 9.1 流程顺序

```
1. 用户操作
2. → 前置检查：目标区域区块是否存在
3.   → 不存在 → Notice，终止
4.   → 存在 → 继续
5. → store.mutate()：数据层操作
6. → 刷新侧边栏
7. → 写入 md 文档对应区块
```

哪些入口需要前置检查：

| 入口 | 检查目标 |
|------|---------|
| Week 面板标题 + | `%% week:周键 %%` 区块是否存在 |
| Day 面板标题 + | `%% day:日期键 %%` 区块是否存在 |
| 创建 Week 子任务 | `%% week:周键 %%` 区块是否仍然存在 |
| 创建 Day 子任务 | `%% day:日期键 %%` 区块是否仍然存在；Week 来源任务同时检查源 Week 区块 |
| Week 任务安排到 Day | `%% day:目标日期 %%` 区块是否存在 |
| Day 任务延续到其他日期 | `%% day:目标日期 %%` 区块是否存在 |
| Day 任务建立 Week 来源 | `%% week:周键 %%` 区块是否存在 |

### 9.2 写入规则

**Week 区块内插入：**

```
插入前：
%% week:2026.6.1-2026.6.7 %%
- [ ] 已有任务 ^tf-w-0001
%% week end %%

插入后（顶层独立任务）：
%% week:2026.6.1-2026.6.7 %%
- [ ] 已有任务 ^tf-w-0001
- [ ] 新任务名称 ^tf-w-0005
%% week end %%

插入后（父任务 + 子任务，同时创建的场景实际不存在——子任务创建时父任务行已存在）：
%% week:2026.6.1-2026.6.7 %%
- [ ] 父任务 ^tf-w-0001
	- [ ] 新子任务 ^tf-w-0006
%% week end %%
```

规则：
- 顶层独立任务追加到区块末尾
- 子任务插入到父任务行下方，带 2 空格缩进
- 名称取 `TaskRecord.name`，ID 取 `TaskRecord.id`

**Day 区块内插入：**

规则同上。Week 来源 Day 任务插入时格式与 Day 创建任务相同。

**批量写入优化：**

同一批次内多个任务写入同一个区块时，合并为一次文件写入操作，避免多次 I/O。

### 9.3 tasklog 扫描

`findTasklog` 用于判断 Day 非父任务是否已有工作记录：

- 扫描当前 md 文档全文
- 匹配 `tasklog:: tf-d-xxx`
- 返回匹配的任务 ID 集合

用途：侧边栏显示时，判断 Day 非父任务行前面显示蓝圈（有 tasklog）还是红圈（无 tasklog）。详见阶段 7 状态方案。
