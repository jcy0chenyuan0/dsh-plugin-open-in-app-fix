# dsh-plugin-open-in-app-fix

修好 dsh 的 **Open In …**：点「用 VS Code 打开」不再报 **「打开失败，请重试」**。

## 症状

dsh 会话头部（或 `Ctrl+Shift+O`）的 Open In 菜单里点 VS Code，前端弹
`path.openError` = 「打开失败，请重试」/ “Could not open. Try again.”。

## 根因（已实测复现）

`@deepseek-ai/dsh-host-open-in-app` 的 `launchDetachedApp` 用
`{ ...scrubbedParentEnv(), ...options.env }` 启动目标程序。`scrubbedParentEnv()`
只清凭据形状的名字和 `DSH_*`，**保留 `ELECTRON_RUN_AS_NODE`**。

而跑这个插件的 **Desktop Host 进程本身就是 Electron 的 Node 模式子进程**
（进程链：`DeepSeek Harness.exe`(GUI) → `DeepSeek Harness.exe --expose-internals
…dsh-desktop-host…` → 插件在这儿），所以它的环境里带着 `ELECTRON_RUN_AS_NODE=1`。

VS Code / Insiders / Cursor / Windsurf 自己也是 Electron 程序，于是它们收到
`ELECTRON_RUN_AS_NODE=1`，**被当成纯 Node 进程启动**，在 `launchWatchMs` 窗口内
立刻非零退出 → `runLaunch` 判为 `failed` → 路由回 `launch-failed` → 前端报错。

本机实测（`Code.exe <dir>`，detached + stdio:ignore，复制真实调用点）：

| 子进程环境 | 结果 |
|---|---|
| 带 `ELECTRON_RUN_AS_NODE=1`（现状） | **64 ms 后 exit code=1** → dsh 判失败 |
| 去掉该变量 | 看护窗口结束时仍在运行 → dsh 判成功，GUI 正常打开 |

## 为什么不能直接在别处修

- **不能删 `process.env.ELECTRON_RUN_AS_NODE`**：`dsh-subprocess-local` 的
  `runnerEnvironment()` 用 `scrubbedParentEnv()` 组环境，并**依赖继承**这个变量让
  `process.execPath`（Electron）以 Node 模式跑 `runner.js`。进程级删掉它，所有
  shell / exec 工具一起报废。
- **改不到 open-in-app 模块**：它调用的是 `child_process.spawn` 的 **ESM 快照绑定**
  （猴补丁模块导出无效，Node v24 实测），而且该模块打包在 `app.asar` 里。
- 它内部的 `internals.catalog` 测试接缝被打包成了单文件里的模块内常量，外部够不着。

## 修法

快照函数与内部实现唯一共享的对象是 **`ChildProcess.prototype.spawn(options)`**。
本插件只补这一个方法，并且**只对 GUI 适配器那一种启动形状**去掉选择变量：

```
detached === true 且 stdio 全为 'ignore'
```

`app.asar` 全量扫描显示，这个形状在整棵发行树里**只有一处**（就是 open-in-app 的
GUI 适配器）。subprocess runner、bash 会话、`ctx.subprocess` seam 都用结构化 stdio，
一律不受影响，继续继承变量以 Node 模式启动。

其余行为约定：

- 不改调用方传入的 env 对象（改成过滤后的副本），因此 `options.env === process.env`
  的情况也不可能演变成进程级删除；
- 不修改 `process.env`、不写注册表、不改 `app.asar`；
- 同进程内幂等；插件 dispose 时还原原方法。

## 安装

> **首次安装**：先在本目录运行 `install.ps1`（Windows）或 `node install.mjs`（macOS/Linux）。
> 脚本按当前目录自动生成 `cordis.patch.yml`（已 `.gitignore`），不写死任何盘符。

```powershell
plugin_manager install_bundle  file:<本目录的绝对路径>
```

装完在 GUI 的「设置 → 插件」里可整体启用/停用。新 bundle 通常在 profile 热重载时
即生效；若菜单仍报错，重启 dsh 桌面端。

## 自检（可选，一次性）

在本目录建一个 `run-selftest` 文件，内容写要打开的目录；插件加载时会用**与 dsh
完全相同的启动方式**（同一个 `spawn` 绑定、`detached: true`、`stdio: 'ignore'`、
同样的清洗环境）拉起 VS Code，然后把结果写进 `selftest.json`，并删除该 marker，
因此日常启动不会弹编辑器。

```powershell
Set-Content -Path "$env:USERPROFILE\.dsh\plugins\open-in-app-fix\run-selftest" -Value (Get-Location).Path
# 让插件重新加载（重启 dsh 或重新启用本 bundle）后：
Get-Content "$env:USERPROFILE\.dsh\plugins\open-in-app-fix\selftest.json"
```

`probe.outcome` 为 `launched` 即代表修好；`exited` / `exit code=1` 代表补丁没生效
（此时 `patched` 字段与 `selectorPresentInHostEnv` 可用于区分「没加载」和「形状没匹配」）。

## 本机验证结果（2026-10-12）

安装后插件在宿主进程里跑了一次真实探针（`selftest.json`，宿主进程，即
`dsh-desktop-host` 那一层）：

```json
{ "hostPid": <pid>, "selectorPresentInHostEnv": "present", "patched": true,
  "probe": { "outcome": "launched", "command": "…\\Microsoft VS Code\\Code.exe",
             "target": "<打开目录>" } }
```

即：宿主确实带着 `ELECTRON_RUN_AS_NODE=1`，补丁已装，**同一路启动当时仍在运行**
（并且真的起了一个新的 VS Code 进程）。回归侧：工具 shell 与 `python` 工具的子进程
仍然看到 `ELECTRON_RUN_AS_NODE=1`，说明 subprocess runner 未受影响。

独立用例 `test/acceptance.mjs`（`node test/acceptance.mjs`）覆盖：补丁前后对照、
五种 stdio/detached 形状、调用方 env 不被修改、重复 apply 幂等、dispose 还原。

## 顺带修掉的 profile 坑

`<profile>/pnpm-lock.yaml` 里的目录依赖版本写成了 `file:../../../plugins/…`，从 profile
目录解析会落到 `%USERPROFILE%\plugins\…`（不存在），导致**任何** `pnpm add` 都以
`ENOENT scandir` 失败。已改为 `file:../../plugins/…`（pnpm 自己在这次安装中生成的
新条目也是这个形式），改动前的原件备份在 `pnpm-lock.yaml.bak-dsh-fix`。

## 卸载

```powershell
plugin_manager remove_bundle dsh-plugin-open-in-app-fix
```

或在 GUI 插件页移除。移除后行为回到 dsh 原状（Open In 对 Electron 编辑器再次失败）。

## 上游修法建议

真正的修法在 dsh 侧：`launchDetachedApp` 组环境时删掉 `ELECTRON_RUN_AS_NODE`
（同仓的 PTC 沙箱已经这么干了：`key.toUpperCase() !== "ELECTRON_RUN_AS_NODE"`，
并且 GitHub Desktop 适配器是**显式**给该变量，说明这个变量在该仓库里本就该按
适配器逐条声明而不是从父进程继承）。dsh 修好后本插件即可卸载。

---

## 可移植性 / 换机器安装

这个仓库**不包含本机绝对路径**：`cordis.patch.yml` 由安装脚本按当前目录生成（已 `.gitignore`）。

换一台机器：

1. `git clone` 本仓库到任意目录；
2. 运行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`（Windows）或 `node install.mjs`（macOS/Linux）；
3. 在 DSH 里执行 `plugin_manager install_bundle  file:<本目录的绝对路径>`。

### 运行环境

- **Windows / macOS / Linux 的 DSH Desktop 均适用**：修的是 Electron `detached + stdio:ignore` 启动时继承 `ELECTRON_RUN_AS_NODE` 的行为。
- **Node 20+**（DSH 自带）；无第三方依赖。
- 只对「Open In …」的 detached GUI 启动生效，不影响 shell / python 等子进程。
