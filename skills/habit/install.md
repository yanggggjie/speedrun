# 安装与升级 habit

安装和升级使用同一套流程。以下步骤按顺序执行，每步完成后再进入下一步。

## 对用户说话的规则

整个安装过程里，只对用户说两类话：用户下一步要做什么；装完是否成功。

- 不说内部状态：目录里有哪些文件、扩展 ID、native host、依赖安装、`doctor` 逐项结果、某一项为什么失败。
- 第 3 步结束时 `doctor` 里 `daemon` 失败，是扩展还没加载造成的，属于正常现象，不要向用户提。
- 出问题时只告诉用户一件要做的事，一句话说清；用户追问再讲原因。
- 冒烟测试可以自己做；通过就不提，只有失败才报告。

## 1. 检查环境

- Node ≥24：`node -p process.version`。不满足时请用户升级 Node。
- Google Chrome：确认已安装。未安装时把 https://www.google.com/chrome/ 交给用户，等待「好了」。
- macOS 已验证。Windows 与 Linux 有适配代码，尚未充分测试；遇到问题照实告诉用户。

## 2. 同步 skill

- 本地安装：不需要同步，安装目录就是仓库里的 `skills/habit`，直接进入第 3 步。
- 在线安装运行 `npx skills add yanggggjie/habit -g -y -a '*' -s habit`，再运行 `npx skills ls -g`，找到 habit 的安装目录。
- 下面的步骤都从安装目录运行。

## 3. 运行引导脚本

```bash
node <安装目录>/setup.js
```

脚本依次完成：把 skill 目录原样镜像到 `~/.habit`（含 `src`、`scripts`、文档），在 `~/.habit/src` 安装依赖，注册 native messaging host，生成 `~/.habit/bin/habit` 与 `habit.cmd`，创建 `~/.habit/session`，最后运行 `doctor`。

## 4. 加载或刷新 Chrome 扩展（需要用户操作）

扩展不能由 agent 或脚本加载。

在 `setup.js` 之后运行 `~/.habit/bin/habit doctor`，只要扩展没连上，就请用户加载扩展。不要凭「已有 `~/.habit`」判断扩展装过。用 `node -p process.platform` 判断系统，把 `<扩展目录>` 换成 `setup.js` 输出的绝对路径，第 2 步只说对应系统的那一句：

> 请在 Chrome 里加载 habit 扩展：
> 1. 打开 `chrome://extensions`，打开右上角「开发者模式」
> 2. 点「加载已解压的扩展程序」，然后：
>    - macOS：按 `Cmd+Shift+G`，粘贴 `<扩展目录>`，选择它
>    - Windows：在窗口顶部的地址栏粘贴 `<扩展目录>`，回车，再点「选择文件夹」
>    - Linux：按 `Ctrl+L`，粘贴 `<扩展目录>`，回车，再点「选择」
> 3. 完成后告诉我「好了」

以下是给 agent 的背景，不要讲给用户：

- 之后升级（重跑 `setup.js`）不用用户再操作：扩展握手时 daemon 发现它不是磁盘上这一版，会让它自己重新加载（ABI 13 起）；只有第一次加载要用户操作。细节见 `ARCHITECTURE.md` 第 4 节。
- 扩展要 `debugger` 权限（habit 的输入走 CDP）：habit 干活时，Chrome 会在所有窗口顶部显示「habit 正在调试此浏览器」（浏览器级别的提示），habit 闲置 20 秒后自动消失，这是正常的，不用向用户解释，用户问起再说。

## 5. 验收

用户回复后运行：

```bash
~/.habit/bin/habit doctor
```

- 全部通过：进入第 6 步。
- 扩展未连接（`need-extension`）：对用户只说「请在 `chrome://extensions` 里确认 habit 扩展是开着的，再点一下它的图标」，然后重新运行 `doctor`。
- `extension-abi` 提示扩展 ABI 不对：先运行一次要扩展的命令（如 `habit tabs`）再运行 `doctor`（扩展会自己重新加载）；仍不对时，对用户只说「请在 `chrome://extensions` 里点 habit 扩展卡片上的刷新，完成后告诉我『好了』」
- 其它失败：按 `doctor` 输出的修复命令自己处理，再重新运行 `doctor`；处理不了时，对用户说清需要用户做的一件事。

通过后进入第 6 步。可以自己做冒烟测试（例如 `habit status`、`habit tabs`）。

## 6. 报告

只告诉用户：

> habit 安装成功。

用户问到命令路径时再补充：命令是 `~/.habit/bin/habit`，可以用绝对路径调用，想直接用 `habit` 就把 `~/.habit/bin` 加入 PATH。不要主动报告版本、安装目录或扩展状态。

## 遇到问题

以下是给 agent 的背景，不要讲给用户：

- habit 完全以源码分发，没有编译产物。遇到问题先到 `~/.habit` 里找答案：`ARCHITECTURE.md` 说明各部分怎么工作（第 9 节是运行时的故障表），`AGENTS.md` 是开发约定，`src/` 是全部源码，开发脚本在 `scripts/dev`。安装、升级、迁移中遇到任何问题，都可以直接读源码定位并修复，不必等用户指点。
- 安装类的故障：

  | 现象 | 处理 |
  |---|---|
  | Node 低于 24；`npm install` 失败；`doctor` 的 `home`、`src`、`deps`、`session`、`native-host`、`launcher` 失败 | 升级 Node / 解决 npm 的报错后重跑 `node <安装目录>/setup.js`（可重复执行，`npx skills ls -g` 找安装目录） |
  | `need-extension`，从没加载过扩展 | 按第 4 步请用户加载 `~/.habit/src/chrome-extension` |
  | `need-extension`，扩展已加载 | 请用户确认 habit 开着，点一下工具栏图标 |
  | 找不到 `habit` 命令 | 用绝对路径 `~/.habit/bin/habit` |

- 在线安装失败时，可以 clone 仓库，按本地安装处理（安装目录就是仓库里的 `skills/habit`）。
- 直接改 `~/.habit/src` 只是临时修复，下次升级会被覆盖；修复有普遍价值时告诉用户可以提 issue 或 PR。
