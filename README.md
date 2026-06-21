# Task Flow

Task Flow 是一个面向 Obsidian 的任务管理插件。

它把任务放在独立侧边栏中管理，同时继续使用 Markdown 文档作为任务内容的存储位置。目标是让日任务、周任务、标签分组、任务延续和工作记录可以在一个清晰的任务面板里完成。

> 当前仓库是 Task Flow 2.1 / 2.1.1 的源码工程。

## 功能特点

- 独立侧边栏任务面板
- 日任务和周任务切换
- 基于目标月文档的任务读写
- 支持在非月文档中查看和操作任务
- 支持任务创建、删除、编辑、状态切换
- 支持子任务、任务延续、任务移动
- 支持任务工作记录跳转
- 支持 Obsidian 原生 `#标签` 语法
- 支持按主标签、子标签分组显示任务
- 支持标签任务创建、标签编辑和标签排序
- 支持桌面端和手机端使用

## 标签规则

创建或编辑任务时，可以在输入开头写标签：

```text
#项目A #阶段1 写测试用例
```

写入 Markdown 时会保存为：

```markdown
- [ ] 写测试用例 #项目A #阶段1
```

Task Flow 当前只使用前两个标签参与分组：

- 第一个标签作为主标签
- 第二个标签作为子标签

更多标签仍会作为普通 Obsidian 标签保留。

## 安装使用

当前仓库默认不提交构建产物。

本地构建后，会生成可安装插件目录：

```text
dist/task-flow/
```

将整个 `task-flow` 文件夹复制到 Obsidian 仓库的：

```text
.obsidian/plugins/
```

然后在 Obsidian 设置中启用插件。

## 开发环境

需要安装 Node.js 20 或更高版本。

首次打开工程后执行：

```powershell
npm install
```

构建插件：

```powershell
npm run build
```

运行测试：

```powershell
npm test
```

测试包含数据、创建、删除、修改和状态相关用例。

## 项目结构

```text
src/
├─ main.ts                 插件入口
└─ v2/                     Task Flow V2 源码

scripts/                   构建和测试脚本
doc/                       方案、计划和交接文档
package.json               依赖和脚本
tsconfig.json              TypeScript 配置
esbuild.config.mjs         打包配置
versions.json              Obsidian 插件版本兼容信息
```

## 当前状态

已完成：

- 全局任务面板升级
- 标签分组功能升级
- 移动端和桌面端基础回归

当前进入维护状态，后续主要处理明确的问题修复和小范围体验优化。

## 说明

这是一个个人使用场景驱动的 Obsidian 插件项目。

如果你想基于它继续开发，建议先阅读：

- `doc/V2.1.1/Task Flow 2.1.1 新对话交接.md`
- `doc/V2.1.1/Task Flow 2.1.1 标签分组功能升级方案.md`
