# Task Flow 2.1 开发进度

## 当前阶段

Task Flow 2.1 桌面端稳定版本 — **功能与体验优化均已通过当前手动验收**

当前源码已于 2026-06-13 整理为独立 `V2.1` 工程，可直接复制后用于 2.1.x 或 2.2 的后续开发。

## 阶段状态

| 阶段 | 状态 | 方案文档 |
|------|------|---------|
| 阶段 1：插件基础与月文档识别 | ✅ 已完成（继承 2.0） | - |
| 阶段 2：Week、Day 与侧边栏交互框架 | ✅ 已完成（继承 2.0） | - |
| 阶段 3：V2 数据基础与真实只读显示 | ✅ 已完成（继承 2.0） | - |
| 阶段 4：created 任务创建与关系建立 | ✅ 已通过手动验收 | `Stage 4 创建-方案.md` |
| 阶段 5：deleted 任务删除与关系修复 | ✅ 已通过手动验收 | `Stage 5 删除-方案.md` |
| 阶段 6：modified 名称、排序和日期移动 | ✅ 已通过手动验收 | `Stage 6 修改-方案.md` |
| 阶段 7：常规任务状态变更 | ✅ 已通过手动验收 | `Stage 7-8 状态-方案.md` 第 7.1 节 |
| 阶段 8：结构变化后的全局状态重算 | ✅ 已通过手动验收 | `Stage 7-8 状态-方案.md` 第 7.2 节 |
| 阶段 9：第一大部分总验收 | ✅ 当前桌面端验收通过 | - |

## 已完成

- 阶段 1：插件基础与月文档识别，已通过手动验收
- 阶段 2：Week、Day 与侧边栏交互框架，已通过手动验收
- 阶段 3：V2 数据基础与真实只读显示，已通过手动验收
- 阶段 4：created 任务创建与关系建立，已通过手动验收（含文档同步）
- **阶段 4 修复**：修复延续单个子任务时文档中缺失子任务行的问题（`continueDayTask` 中 `createdIds` 顺序错误，父任务 ID 需在子任务之前插入）
- 全部阶段方案已制定完成
- **阶段 5 代码完成**：
  - `src/v2/structure/v2Deleted.ts`：按 2.1 方案重写，15 个删除入口全部实现
  - `src/v2/structure/v2Document.ts`：新增 `removeTaskLine`/`removeTaskLinesBatch`/`orphanTasklog` 文档同步函数
  - `src/v2/view.ts`：4 级确认弹窗（简单删除/父任务级联/跨区域级联/延续根继承）
  - `src/v2/__tests__/v2Deleted.test.ts`：测试重写完成，覆盖 15 个入口 + 空父处理 + 延续根提升 + 不变性验证
  - `scripts/run-v2-deleted-tests.mjs`：测试脚本
  - 全部 v2 测试通过（test:v2-data, test:v2-created, test:v2-deleted），构建通过
- **阶段 6 代码完成**：
  - `src/v2/structure/v2Document.ts`：新增 `renameTaskLine`/`reorderTaskLines`/`removeTaskWithTasklog` 文档同步函数
  - `src/v2/structure/v2Modified.ts`：完整重写（~450 行），实现 `renameTask`（含身份链同步）、`getRenamePreview`、`reorderTask`（含 TaskIdNode.childIds 同步）、`moveDayTask`（6 子类型分发）、`moveProjectionChildren`
  - `src/v2/view.ts`：4 处调用补充 `vault` 参数
  - `src/v2/__tests__/v2Modified.test.ts`：测试覆盖改名（7 用例）、排序（3 用例）、日期移动（6 子类型 + 拒绝用例）、moveProjectionChildren、不变性验证
  - `scripts/run-v2-modified-tests.mjs`：测试脚本
  - 全部 v2 测试通过（test:v2-modified, test:v2-created, test:v2-deleted, test:v2-data），构建通过
- **阶段 6 修复（2026-06-11）**：
  - `moveWeekSourceChild`：自动创建父任务时使用 Week 根 ID 而非 Week 子 ID，修复被移动子任务自身变成父任务的问题
  - `moveWeekSourceParent` 合并模式文档同步：统一使用 `movedIds` 移除所有受影响任务，修复子任务在源日文档块中残留的问题
- **阶段 7+8 代码完成（2026-06-11）**：
  - `src/v2/structure/v2Helpers.ts`：提取共享辅助函数（`tag`/`tagMonth`/`pushUnique`/`identity`/`sameWeek`/`parseDateKey`/`findDayInstance`/`findByIdentity`），消除 v2Created.ts 和 v2Modified.ts 间重复
  - `src/v2/structure/v2Document.ts`：新增 `updateStatusMark` 函数，按 `^taskId` 定位任务行并替换状态标记（含 `✅` 特殊状态支持）
  - `src/v2/structure/v2Status.ts`：新建核心状态变更模块（~430 行）
    - `changeDayTaskStatus`：统一状态变更入口（7.1.7 总流程）
    - `hasSpecialMark`：检测任务是否应显示 ✅（同源组内其他实例已完成）
    - `applyCrossDateSameSourceGroup`：跨日期同源组状态计算（7.1.3）
    - `applyDayParentStatus`：Day 父任务状态聚合（7.1.4，支持 Week-source 和 Day-created 两种父类型）
    - `applyWeekDaySync`：Week/Day 状态同步（7.1.6）
    - `recalcGlobalStatus`：全局状态重算（7.2），含 tasklog 对比和 confirmedTaskLogs 更新
  - `src/v2/taskProjection.ts`：`DisplayTask` 新增 `special` 字段，`toDisplayTask` 集成 `hasSpecialMark` 计算
  - `src/v2/view.ts`：
    - 状态圆点点击处理（红圈→复制 tasklog 模板、蓝圈→标记完成、绿勾→标记进行中）
    - 特殊状态圆点不可点击
    - `copyTasklogTemplate`：生成 `### 任务名 / 父任务名\ntasklog:: id\n***` 模板到剪贴板
    - tasklog 变化监听（初版为 500ms 防抖扫描，后续验收中已替换）
  - `src/v2/__tests__/v2Status.test.ts`：测试覆盖 `updateStatusMark`（6 用例）、基础状态变更（5 用例）、同源组（2 用例）、父任务聚合（3 用例）、Week/Day 同步（2 用例）、`recalcGlobalStatus`（2 用例）、延续边界用例
  - `scripts/run-v2-status-tests.mjs`：测试脚本
  - 全部 v2 测试通过（test:v2-status, test:v2-modified, test:v2-created, test:v2-deleted, test:v2-data），构建通过
  - `recalcGlobalStatus` 已集成到所有结构变更函数末尾（v2Created: 5 个导出函数、v2Deleted: 3 个导出函数、v2Modified: 2 个导出函数）
- **阶段 7+8 修复（2026-06-11）— tasklog 粘贴后状态不变**：
  - 根因：`lastTasklogSet` 初始为 null，第一个 modify 事件只建基线不检测变更；`vault.on("modify")` 对编辑器变更不可靠；`startTasklogWatch()` 每次 render 重复注册监听器
  - 修复：事件监听改用 `metadataCache.on("changed")` 并移至 `onOpen()` 一次性注册；`lastTasklogSet` 基线在 `render()` 中立即初始化；`resetForFile()` 切换文件时清空基线；删除 `startTasklogWatch`/`stopTasklogWatch` 模式
  - 提交：`cb650d8`
- **阶段 7+8 第二轮验收修复（2026-06-11，待手动验证）**：
  - 新增 `v2TaskGroups.ts`，统一按“子任务身份组”计算 Day/Week 父任务状态和总进度；跨日期同源实例只计为一个子任务
  - 所有父任务统一显示总进度；进度详情改为“进行中 / 未开始 / 已完成”，跨日期任务显示最新日期和其他日期
  - 修复全局重算错误重置全部 `confirmedTaskLogs` 的问题，仅重置本次实际消失的 tasklog
  - tasklog 扫描增加 `editor-change` 入口，防抖曾由 500ms 降为 150ms；最终方案见 Sync 冲突修复
  - 删除有关联 tasklog 的任务时增加冲突弹窗，可选择保留任务或解除绑定后删除
  - 状态圆圈改用左键 `pointerdown` 响应，修复从编辑区首次点击侧边栏不生效
  - Day 延续/移动菜单按当前日期任务状态显示：全进行中只延续、全未开始只移动、混合或含完成状态均隐藏并提示
  - 多选 Day 任务采用相同权限规则；`continueDayTask` 数据层同步拒绝未开始、混合或已完成任务
  - 全部 v2 测试和构建通过
- **阶段 7+8 第三轮验收修复（2026-06-11，待手动验证）**：
  - 修复跨日期同源任务特殊状态只参与禁止点击、未显示角标且未写回 Markdown 的问题
  - tasklog 编辑改为直接扫描编辑器当前文本，曾试用 50ms 防抖；最终调整为 200ms 批量计算与 Editor 行级写回
  - Day 已开始/已完成独立任务点击加号时立即提示，避免先出现无效输入框
  - 明确同源多日实例可在删除全部 tasklog 后全部回到未开始；保留日期实例，状态和进度仍按一个身份组计算
  - 同源组最后一个 tasklog 删除后弹出提示，并列出全部保留日期
- **阶段 7+8 Sync 冲突修复（2026-06-11，已手动验证）**：
  - 根因：tasklog 在活动编辑器中新增/删除后，插件立即使用 `vault.modify()` 整篇写回，与编辑器未保存缓冲区及 Obsidian Sync 形成双写
  - tasklog 状态变化改为单轮批量计算，新增与删除只生成一次 Markdown 结果
  - 活动 Markdown 编辑器使用 `Editor.replaceRange()` 仅替换状态变化行；没有活动编辑器时才回退 `vault.modify()`
  - 防抖调整为 200ms，兼顾响应速度与粘贴稳定性
- **阶段 7+8 手动验收通过（2026-06-11）**：
  - 状态圆圈、tasklog 新增与删除、跨日期特殊状态、父任务状态与进度均验证正常
  - Day 单选/多选的移动与延续权限、删除任务时的 tasklog 冲突处理验证正常
  - 当前版本作为后续体验优化前的稳定基线保存
- **验收后体验优化（2026-06-11）**：
  - 侧边栏主要控件统一使用左键 `pointerdown` 响应，修复从文档编辑区切换过来首次点击无效
  - 创建 Week/Day 顶层任务及子任务时先检查文档区块，缺少区块直接提示，不显示名称输入框
  - 数据层同步前置区块检查，避免创建失败后留下半完成任务数据
- **时间选择器体验优化（2026-06-12 至 2026-06-13，桌面端已手动验证）**：
  - Week 常驻横向时间条改为标题旁紫底白字胶囊标签
  - 电脑端点击标签显示覆盖式周历浮层，不参与布局、不下推周任务内容
  - 手机端点击标签从底部弹出周历面板，整周连续高亮
  - Day 保留紫底白字选中日期卡片，新增有任务日期圆点和标题旁当前日期标签
  - Day 日期条支持手机原生横向滑动、桌面拖拽和桌面鼠标滚轮
  - 日期条左右使用固定实体箭头提示剩余内容，日期卡片可从箭头下方滑过并被遮挡
  - 移除 Day 每次渲染时的 `scrollIntoView()` 和平滑自动滚动，避免遮罩闪动及点击周日时从周一跳动
  - 改造前源码快照：`backups/task-flow-pre-time-selector-2026-06-12.zip`
- **任务列表体验优化（2026-06-12 至 2026-06-13，已手动验证）**：
  - 调整任务名称字重、任务间距和长名称输入框自动换行
  - 单击任务块跳转至 tasklog 或任务行，并将目标稳定定位到编辑区可视范围
  - 使用类似 Obsidian 大纲的文本黄色高亮；编辑区点击后清除
  - 区分单击跳转与双击名称编辑，整块可跳转、名称所在行可进入编辑
  - 右键菜单顺序统一：删除位于首项，多选倒数第二，添加到周任务位于末项
- **独立源码工程整理（2026-06-13）**：
  - `V2.1` 仅保留当前 2.1 入口、V2 源码、五组自动化测试、构建脚本和 2.1 文档
  - 不包含 `src/v1`、1.0/2.0 文档、旧测试、临时数据和历史备份
  - 构建产物统一输出到 `dist/task-flow`
  - 插件与工程版本统一标记为 `2.1.0`
- **2.1 文档全量同步（2026-06-11）**：
  - 基础模型新增子任务身份组、统一父任务状态/进度、Day 操作权限和多日未开始规则
  - 阶段 4/5/6 方案同步当前延续、删除冲突和移动菜单行为
  - 阶段 7-8 方案同步特殊状态、批量 tasklog 计算、Editor 行级写回和进度详情
  - Markdown 格式规范与分阶段执行计划同步当前实现

## 已知问题

- 当前桌面端无已确认且未修复的问题。
- 手机端仍可继续进行专项手势和布局体验优化，但不影响当前桌面端稳定基线。

## 当前正在做

2.1 当前版本已整理为可独立复制、构建和继续开发的稳定源码工程。

## 下一步（优先级从高到低）

1. 以 `V2.1` 为基线复制新工程，开展 2.1.x 或 2.2 开发
2. 继续进行手机端专项体验优化
3. 修复后续实际使用中发现的回归问题

## 稳定基线

`V2.1` 文件夹是当前可见、可直接复制的 2.1 稳定源码基线。构建产物位于 `dist/task-flow`。

## 完成标准

各阶段完成标准见 `doc/Task Flow 2.1 分阶段开发执行计划.md`。

---

## 新对话读取顺序

1. `doc/Task Flow 2.1 开发进度.md`（本文）← 从这里开始
2. `doc/Task Flow 2.1 基础模型.md`
3. `doc/Task Flow 2.1 分阶段开发执行计划.md`
4. `doc/Stage 7-8 状态-方案.md`

### 关键文件索引

| 模块 | 路径 |
|------|------|
| 状态变更核心 | `src/v2/structure/v2Status.ts` |
| 子任务身份组与父任务汇总 | `src/v2/structure/v2TaskGroups.ts` |
| 共享辅助函数 | `src/v2/structure/v2Helpers.ts` |
| 文档同步 | `src/v2/structure/v2Document.ts` |
| 创建 | `src/v2/structure/v2Created.ts` |
| 删除 | `src/v2/structure/v2Deleted.ts` |
| 修改 | `src/v2/structure/v2Modified.ts` |
| UI 交互 | `src/v2/view.ts` |
| 数据投影 | `src/v2/taskProjection.ts` |
| 状态测试 | `src/v2/__tests__/v2Status.test.ts` |
| 测试脚本 | `scripts/run-v2-status-tests.mjs` |
