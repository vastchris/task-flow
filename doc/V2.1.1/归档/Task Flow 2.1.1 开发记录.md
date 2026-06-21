# Task Flow 2.1.1 开发记录

## 当前状态

- 当前稳定点：052
- 当前插件源码已恢复到 `task-flow_back` 对应的任务输入与任务行显示行为。
- `dist/task-flow` 当前由源码重新构建生成，不再依赖手动覆盖备份文件。
- `src/v2/plugin/styles.css` 与 `task-flow_back/styles.css` 一致。
- 已取消任务名称 Markdown / Live Preview / titleMd 方案，后续默认禁止恢复。

## 052｜2026-06-19｜恢复源码构建版

原因：任务名称 Markdown 输入尝试影响了任务输入、任务行显示和布局稳定性。

处理：
- 恢复任务创建/编辑输入为原有 `textarea` 行为。
- 恢复手机创建弹窗为原有 `textarea` 行为。
- 移除 `titleMd` 数据字段与 Markdown 标题工具残留。
- 恢复任务行纯文本显示 `task.name`。
- 删除任务行显示中的多余变量残留。
- 保留已确认可用的阶段 1-3、5 行为。

验证：
- `npm.cmd run build --cache .npm-cache`
- `npm.cmd test --cache .npm-cache`
- 对照 `task-flow_back/main.js` 的关键片段：
  - `renderTaskInput`
  - `MobileTaskCreateModal`
  - `renderTaskRow`
  - `renderMobileActionBar`
  - `isMobileLayout`
  - `setupMobileSectionSwipe`

## 已完成并保留

- 手机端暗色渐变与创建输入框可读性。
- 手机端底部栏不透明统一。
- 手机端独立周/日切换按钮。
- 周任务界面取消横滑切换。
- 日任务界面横滑切换本周内日期。
- 日任务时间条随日期切换自动显示当前日期。
- 任务编辑入口改为右键/长按菜单中的编辑。
- 父任务改名时同步相关工作记录标题。

## 冻结范围

- 041 的手机端布局、创建页、底部操作栏、渐变、滚动隔离、未完成任务面板不要无故改动。
- 任务名称 Markdown / Live Preview 输入方案已取消，不继续修补。
- 不再新增 `titleMd`、多行标题字段、任务行 Markdown 渲染。

## 后续

- 只处理用户明确提出的新问题。
- 阶段 6-8 仍属于方案待完善，不直接进入开发。
