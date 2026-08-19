# LLM Settings Translator

Automatically translates the UI text inside Obsidian's settings modals (plugin settings / core settings) into your target language using any OpenAI-compatible LLM. Defaults to Simplified Chinese and supports any other language. Translation applies automatically about 2 seconds after you open a settings modal — no button clicks needed.

> ⚠️ This plugin only translates text inside settings modals. It never modifies the main interface, note contents, or any plugin source files. Translations take effect only on the current UI session.

## Features

- **Automatic translation**: Open any settings modal (plugin / core settings) and English text is translated into your target language within about 2 seconds.
- **Any target language**: Defaults to Simplified Chinese; you can pick a language from the dropdown (English / 日本語 / Français / 한국어 / Deutsch…) or type a custom one. Each language keeps an independent translation cache.
- **Manual trigger**: Click the globe icon in the left ribbon, or the "Test Translation" button in the plugin settings, to re-translate instantly.
- **Pop-out window support**: Works in detached pop-out settings windows too.
- **Mobile support**: Works on iOS / Android — automatic translation, persistent cache, and language switching all function (`isDesktopOnly: false`).
- **Persistent translation cache**: Translations are saved to `cache.json` through Obsidian's cross-platform file API (works on desktop and mobile), so the same text is reused across sessions and restarts, saving tokens.
- **Adaptive polling**: Polling slows down automatically when idle to reduce overhead.
- **Token transparency**: The settings tab shows the total token usage of the current session (prompt / completion / total / request count) in real time.
- **Any OpenAI-compatible API**: Works with local servers (Ollama, LM Studio, etc.) and cloud services (DeepSeek, OpenAI, Kimi, Qwen, Zhipu GLM, etc.). Provide the full `/chat/completions` endpoint URL.
- **Debug mode**: Off by default; when enabled, diagnostic files are written to help troubleshooting.

## Requirements

You need a working **OpenAI-compatible chat completions endpoint**, for example:

- Local: [Ollama](https://ollama.com/) (default config `http://127.0.0.1:11434/v1/chat/completions`, model `qwen2.5:7b`)
- Local: LM Studio, vLLM, etc.
- Cloud: DeepSeek, OpenAI, Kimi (Moonshot), Qwen (DashScope), Zhipu GLM, etc.

Both the desktop and mobile versions of Obsidian can reach cloud APIs directly, no proxy required.

## Installation

### Option 1: BRAT (recommended)

1. Install the community plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat) (Obsidian Settings → Community plugins → Browse → search "BRAT").
2. In BRAT settings, add this repository URL: `https://github.com/lindongyan1992/llm-settings-translator`
3. Enable the "LLM Settings Translator" plugin and configure your LLM endpoint and model in its settings.

### Option 2: Manual install

1. Download `main.js` and `manifest.json` from the latest release of this repository.
2. Place them into `.obsidian/plugins/llm-settings-translator/` inside your vault.
3. Restart Obsidian and enable "LLM Settings Translator" under Installed plugins.

### Option 3: Mobile install

- **Android**: Download `main.js` and `manifest.json` from the latest release and place them into `.obsidian/plugins/llm-settings-translator/` using a file manager that can show hidden files. Restart the app and enable the plugin under Installed plugins.
- **iOS**: The Files app cannot access the hidden `.obsidian` directory, so you need to wait for the official community directory review to pass, then search for "LLM Settings Translator" directly inside the app.

### Option 4: Official community directory (pending review)

This plugin has been submitted to the official Obsidian community directory. Once approved, you can find it under Obsidian Settings → Community plugins → Browse (desktop and mobile), and updates will be handled automatically by Obsidian.

## Settings

| Setting | Description |
|---|---|
| API endpoint | Full URL of an OpenAI-compatible endpoint, must include the complete `/chat/completions` path |
| Target language | Default "Simplified Chinese". Common languages can be selected from the dropdown (English / 日本語 / 한국어 / Français / Deutsch…); for others choose "Custom…" and type the language name. Unrecognized names fall back to Simplified Chinese. Reopen a settings modal after changing it |
| Model | The model name to call, e.g. `qwen2.5:7b` / `deepseek-chat` / `gpt-4o-mini` |
| API key | Optional; leave empty for some local / free services |
| Debug mode | Off by default (no diagnostic files written); when enabled, writes `diag_*.txt` files for troubleshooting |

After configuring, click "Test Connection" to verify that the endpoint and model work.

## Usage

- **Prerequisite**: The LLM must be reachable — use the "Test Connection" button in the plugin settings to confirm.
- **Automatic translation**: Open any settings modal (plugin / core settings) and English text is translated into the target language within about 2 seconds.
- **Target language**: Defaults to Simplified Chinese. Pick a common language from the dropdown, or choose "Custom…" and type any language name; reopen the modal to apply. Unrecognized names fall back to Simplified Chinese instead of producing garbled output.
- **Manual trigger**: Click the globe icon in the left ribbon to translate immediately.
- **Scope**: Only text inside settings modals is translated; the main interface and note contents are untouched.
- **Save tokens**: Translations are cached persistently in `cache.json` and reused across sessions / restarts; polling slows down to 15 seconds when idle.

## How it works

1. Detects settings modal root nodes across documents (including pop-out windows).
2. Recursively collects English text nodes inside the settings area (skipping code, input controls, note editors, etc.).
3. Sends them in batches to the LLM (OpenAI-compatible protocol, `temperature=0`), parses the JSON mapping, and writes translations back to the UI.
4. A MutationObserver guard plus polling fallback restores translations automatically when Obsidian re-renders and English text comes back.
5. Translations are stored in cache; subsequent matches are applied directly without calling the model again.

## Development

- **Source**: `src/main.js` (single-file CommonJS implementation, no TypeScript dependency).
- **Build**: `npm install` → `npm run build` (esbuild bundles to root `main.js`).
- **Dev mode**: `npm run dev` (esbuild watch mode; rebuilds automatically on source changes).
- **Releasing a new version**:
  1. Edit `src/main.js`, then run `npm version patch|minor|major` (syncs `manifest.json` and `versions.json` automatically).
  2. `git push --tags` triggers GitHub Actions, which builds the plugin and creates a **draft** release (including `main.js` + `manifest.json` with build provenance).
  3. Add release notes on the GitHub Release page and click **Publish release**.
- **Note**: The root `main.js` is a build artifact (excluded via `.gitignore`); always edit `src/main.js`.

## License

[MIT](LICENSE)

---

## 中文说明

# LLM Settings Translator（设置弹窗翻译器）

用 OpenAI 兼容的 LLM 自动把 Obsidian 设置弹窗（插件设置 / 核心设置）里的英文界面翻译成你指定的语言（默认简体中文，可改为任意语言）。打开设置弹窗后约 2 秒内自动生效，无需点击任何按钮。

> ⚠️ 本插件**只翻译设置弹窗内的文字**，不修改主界面与笔记正文，也不会改动任何插件的源文件。翻译结果仅在当前会话的界面上生效。

### 功能特性

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

### 安装

- **方式一：BRAT（推荐）**：安装社区插件 BRAT，在设置中添加 `https://github.com/lindongyan1992/llm-settings-translator`，然后启用本插件并配置端点与模型。
- **方式二：手动安装**：下载最新 release 中的 `main.js` 和 `manifest.json`，放入 vault 的 `.obsidian/plugins/llm-settings-translator/` 目录，重启 Obsidian 后启用。
- **方式三：移动端**：Android 可手动放入（需支持显示隐藏文件的文件管理器）；iOS 需等官方社区库审核通过后在 App 内搜索安装。
- **方式四：官方社区库（审核中）**：通过后可在设置 → 社区插件 → 浏览中直接搜索安装。

### 配置

| 设置项 | 说明 |
|---|---|
| API 端点 | OpenAI 兼容接口的完整地址，必须包含 `/chat/completions` 全路径 |
| 目标语言 | 默认「简体中文」。常用语言可直接下拉选择，其它语言选「自定义…」后手动输入；无法识别的语言名自动按简体中文翻译 |
| 模型 | 调用的模型名称，例如 `qwen2.5:7b` / `deepseek-chat` / `gpt-4o-mini` |
| API Key | 非必填，部分本地 / 免费服务留空即可 |
| 调试模式 | 关闭（默认）时不写入任何诊断文件；开启后输出 `diag_*.txt` 便于排查 |

### 使用说明

- **前提条件**：LLM 可正常连接，可在插件设置页点击「测试连接」按钮确认在线。
- **自动翻译**：打开任意设置弹窗后，约 2 秒内英文会自动翻译成目标语言。
- **手动触发**：点击左侧功能区中的地球图标可手动触发翻译。
- **作用范围**：只翻译设置弹窗内的文字，主界面与笔记正文不受影响。
- **省 token**：翻译缓存已持久化（`cache.json`），相同文本跨会话 / 重启复用；空闲时轮询自动降速至 15 秒。

### 工作原理

1. 跨 document 探测设置弹窗根节点（支持 pop-out 独立窗口）。
2. 递归收集设置区域内的英文文本节点（跳过代码、输入控件、笔记编辑器等）。
3. 批量发送给 LLM 翻译（OpenAI 兼容协议，`temperature=0`），解析 JSON 映射后写回界面。
4. MutationObserver 守护 + 轮询兜底：Obsidian 重绘把英文刷回来时自动恢复中文。
5. 译文写入缓存，后续命中直接套用，不再请求模型。

### 开发

- **源码**：`src/main.js`（CommonJS 单文件实现，无 TypeScript 依赖）。
- **构建**：`npm install` → `npm run build`，esbuild 打包生成根目录 `main.js`。
- **开发模式**：`npm run dev`（esbuild watch 模式，改源码自动重新打包）。
- **发布新版本**：修改 `src/main.js` 后执行 `npm version patch|minor|major`（自动同步 `manifest.json` 与 `versions.json`）；`git push --tags` 触发 GitHub Actions 自动构建并创建 draft Release；在 GitHub Release 页面补充发布说明后点 **Publish release** 发布。
- **注意**：根目录 `main.js` 是构建产物（已被 `.gitignore` 排除），修改请始终编辑 `src/main.js`。

### 许可

[MIT](LICENSE)
