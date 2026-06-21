# Task Flow

Task Flow 是一个为 Obsidian 设计的任务侧边栏插件。

它想解决的问题很简单：任务应该继续留在 Markdown 里，但每天真正执行任务的时候，不应该只能在文档里来回找。

Task Flow 把任务执行、日期切换、周计划、标签分组、任务延续和工作记录放进一个独立侧边栏；Markdown 文档仍然是任务的真实存储位置。

<img src="picture/桌面端4.png" alt="Task Flow 桌面端总览" width="900">

## 它适合什么场景

如果你的 Obsidian 里已经有日记、周记、项目记录、工作记录，Task Flow 更像是在这些内容旁边长出来的一块任务操作面板。

它不是要把任务从 Obsidian 里搬出去，也不是要把任务变成另一个封闭系统。它做的是：

- 在侧边栏里快速查看今天要做什么
- 在周视图里整理一周的任务安排
- 用 `#标签` 把任务按项目、阶段或类型分组
- 创建、编辑、完成、延续任务时，继续写回 Markdown
- 在桌面端和手机端使用同一套任务规则

## 日常使用方式

### 处理今天的任务

日任务视图是 Task Flow 最常用的入口。你可以切换日期，查看某一天的任务，直接完成、编辑或新增任务。

任务会按标签分组显示。没有标签的任务会排在上方；有标签的任务会进入对应标签组。

<img src="picture/桌面端界面2.png" alt="Task Flow 日任务视图" width="360">

### 安排一周的任务

周任务视图用来整理一周范围内的任务。它适合处理还没安排到具体日期的事项，也适合在一周维度上做任务回看。

<img src="picture/桌面端界面.png" alt="Task Flow 周任务视图" width="360">

### 切换目标时间

Task Flow 有自己的时间选择器。你可以在任务面板中切换日期或周范围，而不需要先打开对应的月度文档。

<img src="picture/桌面端界面3.png" alt="Task Flow 时间选择器" width="360">

### 在手机端继续使用

手机端保留和桌面端一致的任务逻辑。底部操作区、任务列表和标签菜单针对触控做了适配。

<p>
  <img src="picture/手机端界面1.jpg" alt="Task Flow 手机端日任务" width="220">
  <img src="picture/手机端界面2.jpg" alt="Task Flow 手机端周任务" width="220">
  <img src="picture/手机端界面3.jpg" alt="Task Flow 手机端任务操作" width="220">
  <img src="picture/手机端界面4.jpg" alt="Task Flow 手机端底部面板" width="220">
</p>

## Markdown 仍然是源头

Task Flow 不把任务藏进只属于插件自己的格式里。任务最终仍然保存为普通 Markdown：

```markdown
- [ ] 写测试用例 #项目A #阶段1
```

在任务面板里创建任务时，可以这样输入：

```text
#项目A #阶段1 写测试用例
```

保存后，Task Flow 会把任务内容整理成更适合 Markdown 阅读的形式：

```markdown
- [ ] 写测试用例 #项目A #阶段1
```

这样即使不打开 Task Flow，任务仍然可以被 Obsidian 原生搜索、链接、编辑和同步。

## 标签工作流

Task Flow 使用 Obsidian 原生 `#标签`。

当前版本只使用任务中的前两个标签参与侧边栏分组：

```text
#项目A #阶段1 写测试用例
```

这里：

- `#项目A` 是主标签
- `#阶段1` 是子标签
- 后续更多标签会作为普通 Obsidian 标签保留

子标签不会无条件展开成分组。只有同一主标签下，同一个子标签拥有多个任务时，才会显示子标签分组。这样可以避免任务很少时界面被过度拆碎。

标签胶囊也可以作为操作入口：桌面端右键打开标签菜单，手机端长按打开标签菜单。当前已支持新增标签任务、编辑标签名称和调整标签顺序。

## 当前已经支持

Task Flow 2.1 / 2.1.1 当前主要支持：

- 日任务面板
- 周任务面板
- 独立时间选择
- Markdown 任务读写
- 在非目标文档中操作目标月份任务
- 任务创建、编辑、完成、删除
- 子任务
- 任务延续
- 任务移动
- 工作记录跳转
- Obsidian 原生标签识别
- 主标签和子标签分组
- 标签菜单
- 标签排序
- 桌面端和手机端适配

## 安装

当前仓库默认不提交构建产物，需要本地构建后安装。

```powershell
npm install
npm run build
```

构建完成后会生成：

```text
dist/task-flow/
```

把整个 `task-flow` 文件夹复制到 Obsidian 仓库的插件目录：

```text
.obsidian/plugins/
```

然后在 Obsidian 设置中启用 Task Flow。

## 开发

项目需要 Node.js 20 或更高版本。

```powershell
npm install
npm run build
npm test
```

主要目录：

```text
src/
├─ main.ts                 插件入口
└─ v2/                     Task Flow V2 源码

scripts/                   构建和测试脚本
doc/                       方案、计划和交接文档
picture/                   README 展示图片
package.json               依赖和脚本
tsconfig.json              TypeScript 配置
esbuild.config.mjs         打包配置
versions.json              Obsidian 插件版本兼容信息
```

## 项目状态

这是一个个人工作流驱动的 Obsidian 插件项目，目前重点是稳定满足日常任务管理需求。

后续升级会优先围绕 UI 细节、标签相关操作和跨端体验继续推进。
