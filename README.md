# LLM Settings Translator（设置弹窗翻译器）

用 OpenAI 兼容的 LLM 自动把 Obsidian 设置弹窗（插件设置 / 核心设置）里的英文界面翻译成你指定的语言（默认简体中文，可改为任意语言）。打开设置弹窗后约 2 秒内自动生效，无需点击任何按钮。

> ⚠️ 本插件**只翻译设置弹窗内的文字**，不修改主界面与笔记正文，也不会改动任何插件的源文件。翻译结果仅在当前会话的界面上生效。

## 功能特性

- **自动翻译**：打开任意设置弹窗（插件 / 核心设置）后，英文自动变成目标语言（约 2 秒内）。
- **多语言目标**：默认翻译成简体中文，可在设置中改为任意语言（English / 日本語 / Français / 한국어…），各语言翻译缓存独立、互不串用。
- **手动触发**：点击左侧功能区的地球图标，或插件设置页内的「翻译测试」按钮可立即重翻。
- **跨窗口支持**：设置被拖到独立 pop-out 窗口时同样生效。
- **移动端支持**：iOS / Android 均可使用，自动翻译、翻译缓存持久化、目标语言切换全部生效（`manifest.json` 已声明 `isDesktopOnly: false`）。
- **翻译缓存**：译文经 Obsidian 跨平台文件接口持久化到 `cache.json`（桌面端与移动端均生效），相同文本跨会话 / 重启复用，不重复消耗 token。
- **自适应轮询**：空闲时轮询自动降速，减少无谓开销。
- **token 透明**：设置页底部实时显示本次会话累计 token 消耗（提示词 / 补全 / 合计 / 调用次数）。
- **任意 OpenAI 兼容 API**：支持本地（Ollama、LM Studio 等）与云端（DeepSeek、OpenAI、Kimi、通义千问、智谱等）服务，填完整 `/chat/completions` 地址即可。
- **调试模式**：默认关闭；开启后可输出诊断文件，便于排查问题。

## 依赖

需要一个可用的 **OpenAI 兼容 chat completions 接口**，例如：

- 本地：[Ollama](https://ollama.com/)（默认配置 `http://127.0.0.1:11434/v1/chat/completions`，模型 `qwen2.5:7b`）
- 本地：LM Studio、vLLM 等
- 云端：DeepSeek、OpenAI、Kimi (Moonshot)、通义千问 (DashScope)、智谱 GLM 等

Obsidian 桌面版与移动版均可直接访问云端 API，无需代理。

## 安装

### 方式一：BRAT（推荐）

1. 安装社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat)（Obsidian 设置 → 社区插件 → 浏览 → 搜索 "BRAT"）。
2. 在 BRAT 设置中添加本仓库地址：`https://github.com/lindongyan1992/llm-settings-translator`
3. 启用「LLM Settings Translator」插件，并在插件设置中配置你的 LLM 端点与模型。

### 方式二：手动安装

1. 下载本仓库最新 release 中的 `main.js` 和 `manifest.json`。
2. 将它们放入 vault 的 `.obsidian/plugins/llm-settings-translator/` 目录。
3. 重启 Obsidian，在「已安装插件」中启用「LLM Settings Translator」。

### 方式三：移动端安装（Android 可手动；iOS 需等社区库）

- **Android**：下载最新 release 中的 `main.js` 和 `manifest.json`，用支持显示隐藏文件的文件管理器放入 vault 的 `.obsidian/plugins/llm-settings-translator/` 目录，重启 App 后在「已安装插件」中启用。
- **iOS**：系统 Files 应用无法访问 `.obsidian` 隐藏目录，需等待官方社区库审核通过后，在 App 内直接搜索「LLM Settings Translator」安装。

### 方式四：官方社区库（审核中）

本插件已提交 Obsidian 官方社区库审核。通过后可在 Obsidian 设置 → 社区插件 → 浏览中直接搜索「LLM Settings Translator」安装（桌面端与移动端均可），后续版本更新由 Obsidian 自动完成。

## 配置

| 设置项 | 说明 |
|---|---|
| API 端点 | OpenAI 兼容接口的完整地址，必须包含 `/chat/completions` 全路径 |
| 目标语言 | 默认「简体中文」。常用语言可直接下拉选择（English / 日本語 / 한국어 / Français / Deutsch…），其它语言需选择「自定义…」后再手动输入语言名。填了无法识别的语言名时自动按简体中文翻译。修改后重新打开设置弹窗生效 |
| 模型 | 调用的模型名称，例如 `qwen2.5:7b` / `deepseek-chat` / `gpt-4o-mini` |
| API Key | 非必填，部分本地 / 免费服务留空即可 |
| 调试模式 | 关闭（默认）时不写入任何诊断文件；开启后输出 `diag_*.txt` 便于排查 |

配置完成后点击「测试连接」验证端点与模型是否可用。

## 使用说明

- **前提条件**：LLM 可正常连接，可在插件设置页点击「测试连接」按钮确认在线。
- **自动翻译**：打开任意设置弹窗（插件 / 核心设置）后，约 2 秒内英文会自动翻译成目标语言，无需点击任何按钮。
- **目标语言**：默认简体中文；在插件设置「目标语言」中下拉选择常用语言，或选「自定义…」手动输入任意语言，重新打开设置弹窗即按新语言翻译。若填写的目标语言无法被识别，会自动按简体中文翻译，不会出现乱码结果。
- **手动触发**：也可点击左侧功能区中的地球图标手动触发翻译。
- **作用范围**：只翻译设置弹窗内的文字，主界面与笔记正文不受影响。
- **省 token**：翻译缓存已持久化（`cache.json`），相同文本跨会话 / 重启复用，不再重复消耗；空闲时轮询自动降速至 15 秒。

## 工作原理

1. 跨 document 探测设置弹窗根节点（支持 pop-out 独立窗口）。
2. 递归收集设置区域内的英文文本节点（跳过代码、输入控件、笔记编辑器等）。
3. 批量发送给 LLM 翻译（OpenAI 兼容协议，`temperature=0`），解析 JSON 映射后写回界面。
4. MutationObserver 守护 + 轮询兜底：Obsidian 重绘把英文刷回来时自动恢复中文。
5. 译文写入缓存，后续命中直接套用，不再请求模型。

## 开发

- **源码**：`src/main.js`（CommonJS 单文件实现，无 TypeScript 依赖）。
- **构建**：`npm install` → `npm run build`，esbuild 打包生成根目录 `main.js`。
- **开发模式**：`npm run dev`（esbuild watch 模式，改源码自动重新打包）。
- **发布新版本**：
  1. 修改 `src/main.js` 后执行 `npm version patch|minor|major`（自动同步 `manifest.json` 与 `versions.json`）；
  2. `git push --tags` 触发 GitHub Actions，自动构建并创建 **draft** Release（含 `main.js` + `manifest.json` 及构建溯源证明）；
  3. 在 GitHub Release 页面补充发布说明后点 **Publish release** 发布。
- **注意**：根目录 `main.js` 是构建产物（已被 `.gitignore` 排除），修改请始终编辑 `src/main.js`。

## 许可

[MIT](LICENSE)
