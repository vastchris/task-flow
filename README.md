# Task Flow 2.1 完整源码工程

这是 Task Flow 2.1 的独立源码工程，只包含 2.1 当前运行所需的源码、测试、构建脚本和开发文档，不包含 1.0、2.0 的旧版源码。

## 目录说明

```text
V2.1/
├─ src/
│  ├─ main.ts                 插件入口
│  └─ v2/                     Task Flow 2.1 完整源码与测试
├─ scripts/                   构建产物整理脚本和 V2 测试脚本
├─ doc/                       Task Flow 2.1 开发与方案文档
├─ dist/task-flow/            构建后生成的可安装插件
├─ package.json               依赖和构建、测试命令
├─ package-lock.json          依赖版本锁定
├─ tsconfig.json              TypeScript 检查配置
├─ esbuild.config.mjs         插件打包配置
├─ versions.json              插件版本兼容信息
└─ README.md                  本说明
```

## 开发环境

需要安装 Node.js 20 或更高版本。

首次打开工程后执行：

```powershell
npm install
```

## 构建插件

```powershell
npm run build
```

构建完成后，可安装插件位于：

```text
dist/task-flow/
├─ main.js
├─ styles.css
└─ manifest.json
```

将整个 `task-flow` 文件夹复制到 Obsidian 仓库的 `.obsidian/plugins/` 下即可。

## 运行测试

```powershell
npm test
```

该命令会依次运行数据、创建、删除、修改和状态测试。

## 开发新版本

开发 2.1.1、2.1.2 或 2.2 时：

1. 完整复制整个 `V2.1` 文件夹。
2. 将副本改成新版本名称。
3. 用 Codex 或代码编辑器打开副本目录。
4. 执行 `npm install`。
5. 在副本中继续开发和构建。

原始 `V2.1` 文件夹无需改动，可随时重新构建当前稳定版本。
