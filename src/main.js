/*
LLM Settings Translator (llm-settings-translator)
用本地 OpenAI 兼容 LLM 自动翻译 Obsidian 插件设置弹窗内的全部文本节点。
不修改任何插件文件，纯 UI 层替换。
支持在设置中自定义端点 / 模型 / API Key，并提供「测试连接」。

跨窗口（pop-out window）兼容说明（v0.3.1 起）：
Obsidian 的「设置窗口」可能是一个独立的 pop-out window，拥有自己独立的 document。
主窗口插件代码里的 `document` 只指向主窗口，因此无法用 `document.querySelector` 摸到设置窗口的 DOM。
但 `app` 是共享单例，`app.setting.containerEl` 就是设置弹窗根节点（即使它属于另一个窗口的 document）。
Obsidian 为节点提供了 `.doc` 属性（指向元素所属 Document），并提供了全局 `activeDocument`（当前聚焦窗口的 document）。
本插件据此收集所有「可能含设置内容的 document」，在每一个里探测并翻译设置根节点。
*/
const { Plugin, PluginSettingTab, Setting, requestUrl, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions', // 默认 Ollama 的 OpenAI 兼容端点，可换成任意 OpenAI 兼容服务
  apiKey: '',
  model: 'qwen2.5:7b',
  targetLang: '简体中文', // 目标语言：默认简体中文，可改成任意语言（English / 日本語 / Français / 한국어…）
  debugMode: false // 调试模式：关闭时所有诊断文件（diag_*.txt）与版本横幅静默
};

const CHUNK = 150; // 单次翻译的文本条数上限（调大以减少请求次数，降低每请求重复的 system 提示词 token 开销）

// 给 Promise 加超时，避免本地 LLM 服务无响应时 requestUrl 永久挂起导致「翻译锁」卡死
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时（' + (ms / 1000) + 's），本地 LLM 服务可能无响应或被占用')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// 目标语言规范化：空值 / 纯数字 / 纯符号 / 超长等明显不是语言名的输入一律回退「中文」，
// 避免把乱码直接拼进给模型的提示词。含字母或汉字的（如 asdf、Mandarin、zh-CN）无法在此判定，
// 由模型按提示词规则 4 兜底：识别不出目标语言就按简体中文翻译。
function normalizeTargetLang(raw) {
  let lang = (raw || '').trim() || '简体中文';
  if (lang === '中文') lang = '简体中文'; // 旧配置兼容：'中文' 即简体中文
  if (lang.length > 30) return '简体中文';
  if (!/[a-zA-Z\u4e00-\u9fff]/.test(lang)) return '简体中文'; // 不含任何字母或汉字 → 明显不是语言名
  return lang;
}

// 设置页「目标语言」下拉的常用语言选项；不在列表内的语言可走「自定义…」手动输入
const COMMON_LANGS = [
  '简体中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español',
  'Português', 'Italiano', 'Русский', '繁體中文', 'ไทย', 'Tiếng Việt', 'العربية'
];

// 判定目标语言是否为简体中文：决定 NAME_DICT 专有名词强制覆盖与预置词条是否生效。
// 注意「繁體中文」/ Traditional Chinese 不算简体，走通用翻译规则翻成繁体。
function isZhLang(lang) {
  if (lang.indexOf('简体') >= 0) return true;
  // 简体中文的常见写法：中文 / Chinese / 普通话 / 汉语 / 语言代码(zh, zh-CN, zh-Hans...) 等。
  // 注意「繁體中文」/ Traditional Chinese 不在其中，走通用规则翻成繁体。
  const zhNames = ['中文', 'Chinese', '普通话', '汉语', 'Mandarin', 'zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh_hans', 'Simplified Chinese', '简体中文'];
  if (zhNames.indexOf(lang) >= 0) return true;
  if (/chinese/i.test(lang)) return !/traditional|繁体|繁體/.test(lang);
  return false;
}

// 按目标语言动态构造系统提示词。中文模式保留「专有名词强制翻译」规则（本地小模型常对插件名手下留情）；
// 其它语言走通用规则，让模型自由翻译，且不启用 NAME_DICT 强制覆盖（那是中文专用词条）。
function buildSysPrompt(targetLang) {
  const lang = normalizeTargetLang(targetLang);
  const zh = isZhLang(lang);
  if (zh) {
    return 'You are a UI text translator for Obsidian plugins. ' +
      'Input is a JSON object whose keys are string indices ("0","1",...) and values are UI strings (usually English). ' +
      'Translate EVERY value into Simplified Chinese and return ONLY a JSON object with the same keys and the translated values. ' +
      'Rules: (1) Even single words and proper nouns / plugin brand names MUST be translated into a Chinese equivalent ' +
      '(e.g. "Dataview"->"数据视图", "Excalidraw"->"手绘白板", "Linter"->"代码检查器", "Kanban"->"看板"). ' +
      'Do NOT leave English proper nouns unchanged. (2) Preserve placeholders like {x}, code, and technical tokens. ' +
      '(3) Do not add explanations or markdown code fences.';
  }
  return 'You are a UI text translator for Obsidian plugins. ' +
    'Input is a JSON object whose keys are string indices ("0","1",...) and values are UI strings (usually English). ' +
    'Translate EVERY value into ' + lang + ' and return ONLY a JSON object with the same keys and the translated values. ' +
    'Rules: (1) Even single words and proper nouns / plugin brand names MUST be translated into ' + lang + '. ' +
    'Do NOT leave English proper nouns unchanged. (2) Preserve placeholders like {x}, code, and technical tokens. ' +
    '(3) Do not add explanations or markdown code fences. ' +
    '(4) If the target language above is not a real, recognizable language, IGNORE all other rules above and translate EVERY value into Simplified Chinese (简体中文) instead. ' +
    'Never fall back to Traditional Chinese (繁體中文).';
}

// 已知词条强制覆盖：本地小模型常对插件专有名词「手下留情」保留英文。
// 这里用人工词条保证这些常见插件名一定翻成中文（且会写入翻译缓存，被还原时即时恢复）。
const NAME_DICT = {
  'Dataview': '数据视图',
  'Excalidraw': '手绘白板',
  'Linter': '代码检查器',
  'Omnisearch': '全能搜索',
  'OpenCode-Obsidian': 'OpenCode 同步',
  'Remotely Save': '远程保存',
  'Recent Files': '最近文件',
  'Tasks': '任务',
  'Calendar': '日历',
  'Kanban': '看板',
  'Autolink': '自动链接',
  'Reminder': '提醒',
  'Editing Toolbar': '编辑工具栏',
  'Templater': '模板引擎',
  'Canvas': '画布',
  'Outliner': '大纲工具'
};

function isTranslatableText(t) {
  return t && t.trim().length > 0 && /[A-Za-z]/.test(t);
}

// 只翻译纯英文（或以英文为主的文本）。只要文本里含有任何中文字符，就视为「已本地化 / 中英混排」，
// 不再送去翻译——否则会出现「已翻译的中文被反复送模型、被误判为拒翻词」的问题（v0.3.18 的 refused
// 记录功能暴露了这个 bug：大量已译中文被误记）。已翻译完毕的中文节点也会命中此规则自然跳过。
function isMostlyEnglish(t) {
  const s = t.trim();
  if (!/[A-Za-z]/.test(s)) return false; // 完全无拉丁字母：纯中文/符号 → 不翻译
  if (/[一-鿿]/.test(s)) return false;    // 含有任何中文字符 → 视为已本地化/混排 → 不翻译
  return true;
}

// 纯递归收集「可翻译的英文文本节点」：完全基于节点真实子树（childNodes 递归），
// 不依赖任何 document 对象，因此跨 Obsidian pop-out 窗口（设置节点属于另一个 document，
// 且其 .doc/.ownerDocument 可能错位）也绝对安全。强排除：脚本/样式/代码/输入控件、笔记编辑器。
// 注意：不再使用「已翻译标记」(dataset.llmTranslated) 来跳过节点——因为 Obsidian 重绘时
// 会把中文文本节点原地还原成英文，而父元素上的标记会被保留，导致还原后的英文永远被跳过、
// 界面始终显示英文。改为完全依赖 isMostlyEnglish 过滤：已翻译的中文自然被过滤，
// 被还原的英文则会被重新收集并重新翻译（由 guardRoot 守护与 2s 轮询兜底）。
// 供 translateScope 与诊断 dry-run 共用。
const SKIP_TAGS = ['SCRIPT', 'STYLE', 'CODE', 'INPUT', 'TEXTAREA', 'SELECT'];
const SKIP_CSS = '.cm-editor, .markdown-source-view, .markdown-reading-view, .markdown-preview-view, .view-header, .workspace-tabs, .graph-view, .canvas-wrapper';
function collectTranslatableNodes(scopeEl) {
  const out = [];
  const walk = (el) => {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 3) { // TEXT_NODE
        const txt = child.nodeValue;
        if (!isTranslatableText(txt)) continue;
        if (!isMostlyEnglish(txt)) continue;
        const p = child.parentElement;
        if (!p) continue;
        if (SKIP_TAGS.indexOf(p.tagName) >= 0) continue;
        if (p.closest(SKIP_CSS)) continue;
        out.push(child);
      } else if (child.nodeType === 1) { // ELEMENT_NODE 继续递归
        walk(child);
      }
    }
  };
  walk(scopeEl);
  return out;
}

class LLMSettingsTranslator extends Plugin {
  async onload() {
    await this.loadSettings();

    // 重载证明：插件一加载就立刻往 diag_status.txt 写版本横幅。只要用户重载/重启成功，
    // 这个文件就会立刻出现并带 v0.3.14，一眼确认新代码是否真的跑起来（不再需要开设置才生成）。
    try {
      this._logStatus('===== 插件已加载 (onload) v1.4.4 =====');
    } catch (e) { /* 忽略 */ }

    this.ribbonIcon = this.addRibbonIcon('globe', '手动触发翻译', () => this.translateOpenModals(true, 5000));
    this.addSettingTab(new SettingsTab(this.app, this));

    // 直接 Hook 设置弹窗的打开 / 切换标签事件，确保打开瞬间即翻译（跨窗口也有效，
    // 因为 app.setting 是共享单例，任何窗口打开设置都会经过这里）。仅在首次 onload 时包装一次。
    try {
      const st = this.app.setting;
      if (st && typeof st.open === 'function' && !st.__llmHooked) {
        const self = this;
        const origOpen = st.open.bind(st);
        st.open = function () {
          const r = origOpen.apply(this, arguments);
          setTimeout(() => self.translateOpenModals(false), 300);
          return r;
        };
        if (typeof st.openTab === 'function') {
          const origOpenTab = st.openTab.bind(st);
          st.openTab = function () {
            const r = origOpenTab.apply(this, arguments);
            setTimeout(() => self.translateOpenModals(false), 300);
            return r;
          };
        }
        st.__llmHooked = true;
      }
    } catch (e) { console.error('[llm-settings-translator] open hook failed', e); }

    new Notice('设置弹窗翻译器已启用。');

    this.translating = false;
    this._translateStart = 0;
    // 本次会话 token 统计（从模型响应 usage 累计）；设置页与提示中展示
    this._tokens = { prompt: 0, completion: 0, total: 0, calls: 0 };
    // 自适应轮询状态：空闲（无可翻译项）计数达到阈值后，轮询降速至 15s，避免「一直在轮询」
    this._idlePolls = 0;
    this._workCounter = 0;   // 每当真正翻译出新译文自增，用于判定轮询是否空闲
    this._lastWorkTick = 0;
    this._pollMode = 'fast';
    // 翻译缓存：english(trim) -> chinese。网络翻译成功后写入；守护 observer 与写回补丁据此
    // 在 Obsidian 协调式重绘把英文还原时【同步即时】翻回中文，彻底规避「网络回合期间节点被替换、
    // 写回命中脱离文档旧节点」的竞态（v0.3.11 核心修复）。
    this._transCache = new Map();
    // 预置已知词条：仅当目标语言为中文时，已安装插件的专有名词在插件加载时即写入缓存，
    // 这样打开设置后这些词会【立即】被同步翻成中文，无需等待本地模型（消除「已知词也要等好几秒」）。
    // 非中文目标时不预置——NAME_DICT 是中文专用词条，其它语言交给模型自由翻译。
    if (this._isZh()) {
      for (const k in NAME_DICT) { if (Object.prototype.hasOwnProperty.call(NAME_DICT, k)) this._transCache.set(this._ckey(k), NAME_DICT[k]); }
    }
    // 持久化翻译缓存：从 cache.json 载入历史译文，跨会话/重启复用，避免重复消耗 token（最大省 token 项）
    // 用 vault adapter 跨平台读写（桌面端与移动端均可），替代 Node 文件系统 API
    try {
      const adapter = this.app.vault.adapter;
      const p = this._pluginFilePath('cache.json');
      if (adapter && typeof adapter.exists === 'function' && await adapter.exists(p)) {
        const arr = JSON.parse(await adapter.read(p));
        if (Array.isArray(arr)) {
          for (const kv of arr) {
            if (kv && kv.length === 2 && kv[0] && kv[1] && kv[0] !== kv[1]) {
              // 兼容 v1.0.x 旧格式（无语言前缀，视为简体中文缓存）：'Settings' -> '简体中文::Settings'
              const key = kv[0].indexOf('::') >= 0 ? kv[0] : '简体中文::' + kv[0];
              this._transCache.set(key, kv[1]);
            }
          }
        }
      }
    } catch (e) { /* 载入失败不影响主流程 */ }
    // 模型拒绝集：某英文文本经模型翻译后仍原样返回（模型不愿翻的专有名词/技术词），
    // 记录下来，后续收集时跳过，避免自动轮询每 2 秒把它重新送给慢速本地模型空跑（那些 done=0 的循环）。
    this._refused = new Set();
    // 持久化拒翻词：从 refused.json 载入历史拒翻键（含语言前缀），重启后直接跳过、不再重复送模型确认
    try {
      const rAdapter = this.app.vault.adapter;
      const rp = this._pluginFilePath('refused.json');
      if (rAdapter && typeof rAdapter.exists === 'function' && await rAdapter.exists(rp)) {
        const rArr = JSON.parse(await rAdapter.read(rp));
        if (Array.isArray(rArr)) for (const k of rArr) { if (typeof k === 'string' && k) this._refused.add(k); }
      }
    } catch (e) { /* 载入失败不影响主流程 */ }
    void this._writeRefused();
    // 看门狗：若翻译锁异常卡死（如模型请求挂起）超过 15 秒，强制释放，避免所有翻译被永久阻断
    this._watchDog = setInterval(() => {
      if (this.translating && this._translateStart && (Date.now() - this._translateStart > 15000)) {
        console.warn('[llm-settings-translator] watch dog 强制释放翻译锁');
        this.translating = false;
      }
    }, 3000);
    // 轮询兜底：设置窗口是独立 document，主窗口的 MutationObserver 观测不到它；
    // 用轮询跨 document 探测，确保任何窗口里已打开的设置弹窗都能被翻译到。
    // 自适应：空闲（无可翻译项）达阈值后降速至 15s，避免「一直在轮询」空耗。
    this._setFastPoll();
    // 初次加载后尝试一次（一般无弹窗，安全）
    setTimeout(() => this.translateOpenModals(false), 2000);
  }

  onunload() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this._watchDog) clearInterval(this._watchDog);
    if (this._guardObs) { try { this._guardObs.disconnect(); } catch (e) {} }
    if (this._guardTimer) clearTimeout(this._guardTimer);
    // 卸载时把当前缓存落盘，保证下次启动能复用（异步，内部已捕获异常）
    void this._flushCache();
    void this._flushRefused();
  }

  // 轮询：快速档（2s）与慢速档（15s）之间自适应切换。仅在真正翻译出新译文时回到快速档，
  // 否则空闲计数累加，达 4 次后降为慢速档——已翻译完成的页面不再频繁扫描/空跑。
  _setFastPoll() {
    if (this._pollMode === 'fast' && this.pollTimer) return;
    this._pollMode = 'fast';
    if (this.pollTimer) clearInterval(this.pollTimer);
    const self = this;
    this.pollTimer = setInterval(() => {
      if (self.translating) return;
      if (self._lastWorkTick === self._workCounter) {
        self._idlePolls = (self._idlePolls || 0) + 1;
        if (self._idlePolls >= 4) self._setSlowPoll();
      } else {
        self._idlePolls = 0;
        self._lastWorkTick = self._workCounter;
      }
      self.translateOpenModals(false);
    }, 2000);
  }

  _setSlowPoll() {
    if (this._pollMode === 'slow' && this.pollTimer) return;
    this._pollMode = 'slow';
    if (this.pollTimer) clearInterval(this.pollTimer);
    const self = this;
    this.pollTimer = setInterval(() => {
      if (self.translating) return;
      self.translateOpenModals(false);
    }, 15000);
  }

  // 翻译缓存持久化：防抖写入 cache.json，并剔除「key===value」（已译中文标记，可由 isMostlyEnglish 推导），控制体积
  _saveCache() {
    if (this._cacheSaveTimer) return;
    this._cacheSaveTimer = setTimeout(() => {
      this._cacheSaveTimer = null;
      void this._flushCache();
    }, 3000);
  }

  // 跨平台落盘：用 vault adapter 写插件目录下的 cache.json（移动端无 Node 文件系统，必须走 adapter）
  async _flushCache() {
    try {
      const adapter = this.app.vault.adapter;
      if (!adapter || typeof adapter.write !== 'function') return;
      let arr = Array.from(this._transCache.entries()).filter((kv) => kv[0] !== kv[1]);
      if (arr.length > 3000) arr = arr.slice(arr.length - 3000); // 体积上限，超出保留最近
      await adapter.write(this._pluginFilePath('cache.json'), JSON.stringify(arr));
    } catch (e) { /* 忽略 */ }
  }

  // 拒翻词持久化：跨平台写插件目录下的 refused.json（键含语言前缀，与翻译缓存同理跨语言隔离）
  async _flushRefused() {
    try {
      const adapter = this.app.vault.adapter;
      if (!adapter || typeof adapter.write !== 'function') return;
      let arr = Array.from(this._refused || []);
      if (arr.length > 1000) arr = arr.slice(arr.length - 1000); // 体积上限，超出保留最近
      await adapter.write(this._pluginFilePath('refused.json'), JSON.stringify(arr));
    } catch (e) { /* 忽略 */ }
  }

  // 清空拒翻记录：更换端点/模型后调用——新模型可能愿意翻译旧模型拒翻的词，避免被历史记录永久屏蔽
  resetRefused() {
    if (this._refused) this._refused.clear();
    void this._flushRefused();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  // 插件目录内文件的跨平台相对路径（桌面端与移动端 adapter 均可用，替代 Node 文件系统 API，
  // 让翻译缓存与诊断文件在移动端也能正常读写）
  _pluginFilePath(file) {
    return '.obsidian/plugins/llm-settings-translator/' + file;
  }

  // 翻译缓存 / 拒翻词的语言隔离键：英文 "Settings" 在中文目标下译为"设置"、日语下译为"設定"，
  // 键形如 "简体中文::Settings" / "日本語::Settings"。切换目标语言后各语言缓存互不串用，旧语言缓存保留。
  _ckey(t) {
    return normalizeTargetLang(this.settings && this.settings.targetLang) + '::' + t;
  }

  // 目标语言是否为简体中文：决定 NAME_DICT 专有名词强制覆盖与预置词条是否生效
  _isZh() {
    return isZhLang(normalizeTargetLang(this.settings && this.settings.targetLang));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 用当前设置发送一条测试请求，返回可读的结果信息
  async testConnection() {
    const s = this.settings;
    if (!s.endpoint) throw new Error('未填写 API 端点');
    const body = {
      model: s.model || 'hy3',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
        { role: 'user', content: 'Reply with the single word: OK' }
      ],
      temperature: 0,
      stream: false
    };
    const resp = await requestUrl({
      url: s.endpoint,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (s.apiKey || '')
      },
      body: JSON.stringify(body)
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error('HTTP ' + resp.status);
    return 'HTTP ' + resp.status;
  }

  // 收集所有「可能含设置内容的 document」：
  // 1) 主窗口 document
  // 2) app.setting.containerEl.doc（设置弹窗根节点所属的 document，跨窗口关键）
  // 3) 全局 activeDocument（当前聚焦窗口，设置窗口打开后通常聚焦它）
  collectDocs() {
    const docs = [];
    const seen = new Set();
    const add = (d) => {
      if (d && d.nodeType === 9 && !seen.has(d)) { seen.add(d); docs.push(d); }
    };
    add(document);
    try {
      const st = this.app.setting;
      if (st && st.containerEl && st.containerEl.doc) add(st.containerEl.doc);
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof activeDocument !== 'undefined' && activeDocument) add(activeDocument);
    } catch (e) { /* 忽略 */ }
    // 额外扫描主窗口内嵌 iframe 的 contentDocument：某些插件的设置/详情以 iframe 承载，
    // 其文本节点属于 iframe 的 document，主窗口 querySelector 摸不到，必须纳入候选。
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((f) => { try { if (f.contentDocument) add(f.contentDocument); } catch (e2) { /* 跨域 iframe 不可访问，忽略 */ } });
    } catch (e) { /* 忽略 */ }
    return docs;
  }

  // 翻译当前打开的设置界面。
  // verbose: 是否弹提示；waitMs: 若一开始没找到，最多等待多少毫秒（期间持续探测）
  async translateOpenModals(verbose, waitMs) {
    verbose = !!verbose;
    let roots = this.findSettingRoots();
    if (roots.length === 0 && waitMs && waitMs > 0) {
      if (verbose) new Notice('未检测到设置界面，正在等待你打开设置（最多 5 秒）。', 5000);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        roots = this.findSettingRoots();
        if (roots.length > 0) break;
      }
    }
    if (roots.length === 0) {
      const now = Date.now();
      if (now - (this._lastNoRoot || 0) > 15000) {
        this._lastNoRoot = now;
        this._logStatus('translateOpenModals: 未检测到设置界面（根节点=0）');
      }
      if (verbose) new Notice('未检测到打开的设置界面。请先打开 Obsidian 设置（齿轮图标或命令面板搜「设置」），保持弹窗打开，再点此按钮 / 地球图标。');
      return;
    }
    this._logStatus('translateOpenModals: 命中根节点 ' + roots.length + ' 个，开始翻译');
    // 找到设置区域：手动(verbose)每次都提示；
    // 自动(轮询)仅在【真的有待翻文本、会发请求】时才提示（_anyPending 判定），空闲（缓存/拒翻已覆盖）不弹，避免每 20 秒刷屏
    if (verbose) {
      new Notice('找到待翻译区域，开始翻译…');
    } else if (this._anyPending(roots)) {
      const _now = Date.now();
      if (_now - (this._lastFoundNotice || 0) > 10000) {
        this._lastFoundNotice = _now;
        new Notice('找到待翻译区域，开始翻译…');
      }
    }
    // 关键：设置页里的社区插件列表、各插件设置项均为【异步渲染】，
    // 打开瞬间未必已全部挂载。先等约 500ms 让内容稳定，再重新探测根并翻译，
    // 避免「首翻只翻到半截、剩下的英文永远靠守护补」的竞态遗漏。
    await new Promise((r) => setTimeout(r, 500));
    roots = this.findSettingRoots();
    if (roots.length === 0) {
      if (verbose) new Notice('设置界面已关闭或内容尚未就绪，未翻译。');
      return;
    }
    for (const r of roots) {
      this.translateScope(r, verbose);
      this.guardRoot(r);
      // 兜底重翻：异步加载后延迟出现的节点 / 初次写回命中旧节点的情形，
      // 在 800ms、1500ms 各再触发一次（此时缓存已就绪，命中即同步翻回）。
      setTimeout(() => { if (!this.translating) this.translateScope(r, false); }, 800);
      setTimeout(() => { if (!this.translating) this.translateScope(r, false); }, 1500);
    }
  }

  // 判定这些根里是否【真有】需要送模型翻译的文本：
  // 与 translateScope 的过滤逻辑对齐——缓存已命中（会即时套用、不进网络）或已进拒翻集合的词都算「无需再翻」。
  // 非英文过滤已由 collectTranslatableNodes 完成。自动轮询据此决定是否提示「找到区域」，避免空闲时也刷屏。
  _anyPending(roots) {
    for (const r of roots) {
      const nodes = collectTranslatableNodes(r);
      for (const n of nodes) {
        const t = (n.nodeValue || '').trim();
        if (!t) continue;
        const ck = this._ckey(t);
        if (this._transCache && this._transCache.has(ck)) continue;
        if (this._refused && this._refused.has(ck)) continue;
        return true;
      }
    }
    return false;
  }

  // 查找设置弹窗根节点（跨 document 探测）：在每个候选 document 里按优先级寻找设置结构
  findSettingRoots() {
    const MARK = '.setting-item, .vertical-tab-content, .vertical-tab-header, .setting-item-name';
    const NOTE = '.cm-editor, .markdown-source-view, .markdown-reading-view, .markdown-preview-view, .graph-view, .canvas-wrapper';
    // 0) 最可靠：直接拿 app.setting.containerEl（它所属的 document 由 .doc 给出，无需关心在哪个窗口）
    try {
      const st = this.app.setting;
      if (st && st.containerEl && st.containerEl.querySelector &&
          st.containerEl.querySelector(MARK)) {
        return [st.containerEl];
      }
    } catch (e) { /* 忽略，走下方跨 document 扫描 */ }

    const docs = this.collectDocs();
    for (const doc of docs) {
      if (!doc) continue;
      // 1) 含设置标记的标准 modal（必须含 MARK，避免误抓其它 modal）
      let root = Array.from(doc.querySelectorAll('.modal'))
        .find((m) => m.querySelector && m.querySelector(MARK));
      if (root) return [root];
      // 2) 含设置标记、且内部不含笔记编辑器的 view-content（兼容「设置以工作区视图形式打开」）
      //    用 querySelector(NOTE) 排除笔记视图：笔记编辑器是 view-content 的【后代】，closest 查不到，必须用后代查询。
      root = Array.from(doc.querySelectorAll('.view-content'))
        .find((v) => !v.querySelector(NOTE) && v.querySelector(MARK));
      if (root) return [root];
      // 3) 兜底：任意含设置标记的节点（无论何种容器），取其最近的 modal/view-content 或父节点
      const content = doc.querySelector(MARK);
      if (content) {
        const r = content.closest('.modal, .view-content') || content.parentElement || content;
        return [r];
      }
    }
    return [];
  }

  // 为设置根节点挂一个持久「守护」：一旦 Obsidian 因重绘 / 切换标签 / 焦点变化
  // 重置了文本节点（把已翻译的中文变回英文），立即（debounce 后）重新翻译。
  // 跨窗口安全：observer 挂在 root 节点上，无论它属于哪个 document，都能正确观测其子树变化。
  // 防死循环：翻译写回后节点变中文，collectTranslatableNodes 会过滤掉（isMostlyEnglish=false），
  // 再次触发时收集到 0 个英文即 return，不会无限重翻。
  guardRoot(root) {
    if (!root) return;
    if (this._guardRoot === root && this._guardObs) return; // 已挂过，避免重复
    if (this._guardObs) { try { this._guardObs.disconnect(); } catch (e) {} }
    this._guardRoot = root;
    const self = this;
    const obs = new MutationObserver(() => {
      // 同步即时重翻：Obsidian 一旦把文本还原成英文（缓存命中），立刻套用中文，
      // 抢在 Obsidian 下一次协调式重绘前落地——这是规避「写回命中脱离文档旧节点」竞态的关键。
      // 不依赖网络，故不受 translating 锁限制，也不会因 await 期间节点被替换而失效。
      try { self._applyCached(root); } catch (e) { /* 忽略 */ }
      if (self._guardTimer) clearTimeout(self._guardTimer);
      self._guardTimer = setTimeout(() => {
        if (!self.translating) self.translateScope(root, false);
      }, 150);
    });
    try {
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      this._guardObs = obs;
    } catch (e) {
      console.error('[llm-settings-translator] guard observer failed', e);
    }
  }

  // 即时重翻（无网络、同步）：用翻译缓存把「被 Obsidian 重绘还原成英文」的实时节点立刻翻回中文。
  // 必须在 MutationObserver 回调里同步调用，才能在 Obsidian 下一次重绘前抢先落地。
  // 缓存 english->chinese 由 translateScope 在网络翻译成功后写入；首次翻译后任何还原都会被即时恢复。
  _applyCached(scopeEl) {
    if (!scopeEl || !this._transCache || this._transCache.size === 0) return 0;
    let applied = 0;
    try {
      const nodes = collectTranslatableNodes(scopeEl);
      for (const n of nodes) {
        const t = (n.nodeValue || '').trim();
        const ck = this._ckey(t);
        if (t && this._transCache.has(ck)) {
          const cn = this._transCache.get(ck);
          if (cn && cn !== t) { n.nodeValue = cn; applied++; }
        }
      }
    } catch (e) { /* 忽略 */ }
    return applied;
  }

  // 统计「实时 DOM」中仍为英文的可翻译节点数，用于把「写回到底有没有真落地到活节点」
  // 一锤定音地反馈给用户（避免旧版只看捕获引用、被「写中脱离文档旧节点」误导成成功）。
  _liveEnCount(scopeEl) {
    try {
      const fresh = collectTranslatableNodes(scopeEl);
      let c = 0;
      fresh.forEach((n) => {
        const t = (n.nodeValue || '').trim();
        if (isTranslatableText(t) && isMostlyEnglish(t)) c++;
      });
      return c;
    } catch (e) { return -1; }
  }

  // 全程流水账：把「每次自动/手动翻译尝试」的关键结果写入 diag_status.txt，
  // 用于一锤定音定位「自动翻译到底成功没、卡在哪一环」（自动模式失败是静默的，用户看不到任何提示）。
  async _logStatus(line) {
    try {
      if (!this.settings || !this.settings.debugMode) return; // 调试模式关闭时静默（发布版默认）
      const adapter = this.app.vault.adapter;
      if (!adapter || typeof adapter.append !== 'function') return;
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const p = this._pluginFilePath('diag_status.txt');
      try {
        await adapter.append(p, '[' + ts + '] ' + line + '\n');
      } catch (e2) {
        // 文件不存在时 append 可能失败（移动端），回退为写入首行（首次创建）
        await adapter.write(p, '[' + ts + '] ' + line + '\n');
      }
    } catch (e) { /* 不影响主流程 */ }
  }

  // 拒翻词记录：把「模型坚持返回原样英文、且不在 NAME_DICT」的词写入 diag_refused.txt。
  // 每次有新增即按内存 Set 重写整个文件（去重、清晰）。这样用户重载插件、开下设置后，
  // 我（AI）直接读这个文件就能知道界面残留了哪些英文词，无需用户手动辨认；
  // 要强制翻译这些词，只需在 NAME_DICT 加一条对应词条即可。
  async _writeRefused() {
    try {
      if (!this.settings || !this.settings.debugMode) return; // 调试模式关闭时静默（发布版默认）
      const adapter = this.app.vault.adapter;
      if (!adapter || typeof adapter.write !== 'function') return;
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      let s = '=== 模型拒翻词记录 (v1.4.4) ' + ts + ' ===\n';
      s += '以下词模型坚持返回原样英文（且不在 NAME_DICT），属模型能力边界。\n';
      s += '如需强制翻译，告诉 AI 在 NAME_DICT 加一条即可。\n';
      s += '当前共 ' + this._refused.size + ' 项：\n';
      let i = 0;
      this._refused.forEach((w) => {
        // 拒翻词以「语言::原文」存储，这里剥掉语言前缀仅显示原文
        const orig = w.indexOf('::') >= 0 ? w.slice(w.indexOf('::') + 2) : w;
        s += (i++) + ': ' + orig + '\n';
      });
      if (this._refused.size === 0) s += '（暂无）\n';
      await adapter.write(this._pluginFilePath('diag_refused.txt'), s);
    } catch (e) { /* 不影响主流程 */ }
  }

  async translateScope(scopeEl, verbose) {
    verbose = !!verbose;
    if (this.translating) {
      if (verbose) {
        // 手动触发（如「翻译测试」按钮 / 地球图标）：先等最多 4 秒让自动翻译收尾；
        // 若 4 秒后仍被占用（多半是上一次请求卡死、锁未释放），则强制接管，确保手动点击一定生效。
        let w = 0;
        while (this.translating && w < 4000) { await new Promise((r) => setTimeout(r, 200)); w += 200; }
        if (this.translating) {
          console.warn('[llm-settings-translator] 检测到翻译锁长时间未释放，强制重置后继续（手动触发）');
          this.translating = false;
        }
      } else {
        // 自动轮询：正在翻译则直接跳过，避免并发重复请求
        return;
      }
    }
    // 纯递归遍历（见 collectTranslatableNodes）：完全基于节点真实子树，不依赖任何 document 对象，
    // 因而在 Obsidian pop-out 窗口（设置节点属于另一个 document，且 .doc/.ownerDocument 可能错位）下也安全。
    // 关键修复（v0.3.11）：缓存命中的「被还原英文」立即同步套用中文（不进网络批次），避免竞态。
    const all = collectTranslatableNodes(scopeEl);
    const toTranslate = [];
    for (const n of all) {
      const t = (n.nodeValue || '').trim();
      if (!t) continue;
      const ck = this._ckey(t);
      if (this._transCache && this._transCache.has(ck)) {
        const cn = this._transCache.get(ck);
        if (cn && cn !== t) n.nodeValue = cn; // 即时恢复（含预置词条），无需网络
      } else if (this._refused && this._refused.has(ck)) {
        // 模型已确认不愿翻译该词：跳过，避免反复空跑慢速本地模型
      } else {
        toTranslate.push(n);
      }
    }
    const originals = toTranslate.map((n) => n.nodeValue);
    if (!toTranslate.length) {
      if (verbose) new Notice('该设置区域内未检测到可翻译的英文文本。');
      this._logStatus('translateScope: 无可翻译项（缓存已全部命中或无非英文文本），跳过');
      return;
    }
    this._logStatus('translateScope: 待翻译 ' + toTranslate.length + ' 项，开始请求模型');

    this.translating = true;
    this._translateStart = Date.now();
    const total = toTranslate.length;
    const _t0 = (this._tokens && this._tokens.total) || 0;   // 本次翻译起始 token 计数（用于算「单次消耗」）
    const _c0 = (this._tokens && this._tokens.calls) || 0;
    let done = 0;
    if (verbose) new Notice('本区域待翻译文本 ' + total + ' 项，正在请求模型…');
    try {
      for (let i = 0; i < toTranslate.length; i += CHUNK) {
        const sliceNodes = toTranslate.slice(i, i + CHUNK);
        const sliceTexts = sliceNodes.map((x) => x.nodeValue);
        const trans = await this.batchTranslate(sliceTexts);
        sliceNodes.forEach((node, j) => {
          const srcText = (sliceTexts[j] || '').trim();
          let tr = trans[String(j)] != null ? trans[String(j)] : (trans[j] != null ? trans[j] : null);
          // 已知词条强制覆盖：仅中文目标生效（NAME_DICT 是中文专用词条），确保专有名词一定翻中文
          const forced = this._isZh() && NAME_DICT[srcText];
          if (forced) tr = NAME_DICT[srcText];
          if (tr && tr !== srcText) {
            node.nodeValue = tr;
            if (this._transCache) {
              this._transCache.set(this._ckey(srcText), tr);
              this._transCache.set(this._ckey(tr), tr); // 译文自身也入缓存（带语言前缀），已翻译外文文本不再被二次送模型
            }
            done++;
          } else if (!forced) {
            // 模型原样返回、且非已知词条 → 标记「模型拒绝翻译」（按语言隔离），后续自动轮询不再空跑
            if (this._refused) {
              this._refused.add(this._ckey(srcText));
              void this._flushRefused(); // 持久化拒翻键，重启后不再重复送模型确认
            }
            void this._writeRefused();
          }
        });
      }
      // 有新译文产生：记录工作信号（供自适应轮询判定），并落盘缓存（跨会话复用、省 token）
      if (done > 0) {
        this._workCounter = (this._workCounter || 0) + 1;
        this._setFastPoll();
        this._idlePolls = 0;
        this._saveCache();
      }
      // 网络翻译完成后，Obsidian 可能在 await 期间已把文本节点替换成新节点（协调式重绘），
      // 上面 node.nodeValue=tr 可能写到了已脱离文档的旧节点上。用「当前实时 DOM」重新收集一遍，
      // 把已缓存的译文立即套用到活节点，确保落地；之后由 guardRoot 在每次重绘时持续即时恢复。
      const reapplyCached = () => {
        try {
          const fresh = collectTranslatableNodes(scopeEl);
          for (const n of fresh) {
            const t = (n.nodeValue || '').trim();
            const ck = this._ckey(t);
            if (t && this._transCache && this._transCache.has(ck)) {
              const cn = this._transCache.get(ck);
              if (cn && cn !== t) n.nodeValue = cn;
            }
          }
        } catch (e) { /* 忽略 */ }
      };
      reapplyCached();
      // 硬兜底：若实时 DOM 仍有英文（写回瞬间又被重绘 / 首抓命中旧节点），立刻再重抓重翻最多 4 次
      // （每次间隔 150ms），最大努力把中文落到活节点。这是「写回落地」的最后一道保险。
      for (let k = 0; k < 4; k++) {
        const liveNow = this._liveEnCount(scopeEl);
        if (liveNow === 0) break;
        await new Promise((r) => setTimeout(r, 150));
        reapplyCached();
      }
      if (done > 0) {
        const liveEn = this._liveEnCount(scopeEl);
        this._logStatus('translateScope 成功: done=' + done + '/' + total + ' 实时仍英文=' + liveEn);
        const tail = liveEn === 0
          ? '；本次写回已全部落地为中文 ✓'
          : ('；仍有 ' + liveEn + ' 项未翻译（多为模型保留的专有名词）');
        const tk = this._tokens || { total: 0, calls: 0 };
        const batchTok = tk.total - _t0;        // 本次（这次翻译动作）消耗
        const batchCalls = tk.calls - _c0;      // 本次 HTTP 请求次数
        new Notice('设置已翻译 (' + done + '/' + total + ' 项)' + tail
          + ' ［本次 +' + batchTok + ' tokens，调用 ' + batchCalls + ' 次；累计 ' + tk.total + '，会话共 ' + tk.calls + ' 次］', 7000);
        this._verifyWrite(scopeEl, toTranslate, originals, verbose);
      }
      else {
        this._logStatus('translateScope: done=0（模型未返回不同于原文（英文）的译文，可能是服务返回异常）');
        if (verbose) new Notice('已处理 ' + total + ' 项，模型未返回译文。详见diag_translate.txt。');
      }
    } catch (e) {
      console.error('[llm-settings-translator]', e);
      this._logStatus('translateScope 异常: ' + e.message);
      // 自动轮询（verbose=false）失败时不弹提示，避免启动期/本地 LLM 服务未就绪时的噪声；
      // 仅手动触发（verbose=true，如地球图标/「翻译当前设置」按钮）才提示失败原因，便于定位
      // （最常见原因：本地 127.0.0.1:8000 的 LLM 服务未启动）。
      if (verbose) new Notice('翻译失败: ' + e.message);
      else {
        // 自动模式也给出节流提示 + 写状态文件，避免「静默失败、用户完全无反馈」
        const now = Date.now();
        if (now - (this._lastAutoFail || 0) > 15000) {
          this._lastAutoFail = now;
          new Notice('自动翻译未成功，请确认 LLM 服务在线；如需排查原因，请在插件设置中开启「调试模式」', 6000);
        }
      }
    } finally {
      this.translating = false;
    }
  }

  // 写回验证器（v0.3.11 强化）：除复查捕获的节点引用外，额外在「写回后立即」与「800ms 后」
  // 用 collectTranslatableNodes(scopeEl) 重新收集【实时 DOM】的英文节点数，一锤定音说明中文
  // 到底有没有真正落地到活节点（旧版只查捕获引用，会被「写中脱离文档旧节点」误导成成功）。
  _verifyWrite(scopeEl, nodes, originals, verbose) {
    const sampleLines = (arr) => arr.join('\n');
    const liveEnCount = () => {
      try {
        const fresh = collectTranslatableNodes(scopeEl);
        let c = 0;
        fresh.forEach((n) => {
          const t = (n.nodeValue || '').trim();
          if (isTranslatableText(t) && isMostlyEnglish(t)) c++;
        });
        return { total: fresh.length, en: c };
      } catch (e) { return { total: -1, en: -1 }; }
    };
    const readState = () => {
      let stillEn = 0, reverted = 0;
      const sample = [];
      nodes.forEach((n, i) => {
        const cur = (n.nodeValue || '').trim();
        if (isTranslatableText(cur) && isMostlyEnglish(cur)) stillEn++;
        if (originals[i] && cur === originals[i].trim()) reverted++;
        if (i < 8) sample.push(i + ': [' + (originals[i] || '').trim() + '] -> [' + cur + ']');
      });
      return { stillEn, reverted, sample };
    };
    const writeDiag = async (label, st, live) => {
      try {
        if (!this.settings || !this.settings.debugMode) return; // 调试模式关闭时静默（发布版默认）
        const adapter = this.app.vault.adapter;
        if (!adapter || typeof adapter.write !== 'function') return;
        // 裁决行置顶：一眼判定「写回到底落没落地」。同时 console.log，方便用户在 Obsidian
        // 开发者工具（Ctrl+Shift+I → Console）直接看到，不必翻文件。
        const verdict = (live.en === 0)
          ? '【裁决】✅ 写回已落地到活节点（实时 DOM 英文数=0），界面应已显示中文。'
          : '【裁决】❌ 写回未落地（实时 DOM 仍有 ' + live.en + ' 项英文）→ 极可能是设置弹窗运行在独立渲染进程，主窗口插件 JS 改不到它的显示。需改用「把翻译逻辑注入设置窗口自身 document 去执行」的方案。';
        const txt = '=== 写回验证 ' + label + ' ===\n' +
          verdict + '\n' +
          '捕获节点数 = ' + nodes.length + '\n' +
          '捕获节点中仍为英文 = ' + st.stillEn + '\n' +
          '捕获节点中被还原为原文 = ' + st.reverted + '\n' +
          '【实时 DOM】collectTranslatableNodes 命中总数 = ' + live.total + '\n' +
          '【实时 DOM】其中仍为英文 = ' + live.en + '\n' +
          '样本(前8):\n' + sampleLines(st.sample) + '\n';
        await adapter.write(this._pluginFilePath('diag_verify.txt'), txt);
        console.log('[llm-settings-translator] ' + verdict);
      } catch (e) { /* 不影响主流程 */ }
    };
    const imm = readState();
    void writeDiag('写回后立即', imm, liveEnCount());
    setTimeout(() => {
      const later = readState();
      void writeDiag('800ms 后', later, liveEnCount());
    }, 800);
  }

  async batchTranslate(texts) {
    const s = this.settings;
    const obj = {};
    texts.forEach((t, i) => { obj[String(i)] = t; });
    const body = {
      model: s.model || 'hy3',
      messages: [
        { role: 'system', content: buildSysPrompt(s.targetLang) },
        { role: 'user', content: JSON.stringify(obj) }
      ],
      temperature: 0,
      stream: false
    };
    const resp = await withTimeout(requestUrl({
      url: s.endpoint,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (s.apiKey || '')
      },
      body: JSON.stringify(body)
    }), 15000, '模型请求');
    if (resp.status < 200 || resp.status >= 300) throw new Error('HTTP ' + resp.status);
    let raw = resp.text || '';
    // 诊断：把本次请求文本与模型原始响应写入文件，便于排查「模型未返回不同译文」（仅调试模式）
    try {
      if (this.settings.debugMode) {
        const adapter = this.app.vault.adapter;
        if (adapter && typeof adapter.write === 'function') {
          const enCount = texts.filter((t) => /^[A-Za-z0-9 ,.\-:()/]+$/.test(t.trim())).length;
          const dbg = '=== 本次发送文本 (共 ' + texts.length + ' 项，其中近似纯英文/数字 ' + enCount + ' 项) ===\n' +
            texts.slice(0, 40).map((t, i) => i + ': ' + t).join('\n') +
            '\n=== 模型原始响应 (前 1200 字符) ===\n' + raw.slice(0, 1200) + '\n=== end ===';
          await adapter.write(this._pluginFilePath('diag_translate.txt'), dbg);
        }
      }
    } catch (e) { /* 诊断写入失败不影响翻译 */ }
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);
    // 关键修复（v0.3.15）：本地 OpenAI 兼容服务返回的是「标准 chat completion 壳」
    // {"choices":[{"message":{"content":"{\"0\":\"自动链接\",...}"}}]}，而插件需要的是
    // 内层 content 里的「翻译映射 { "0": "译文", ... }」。此前直接把外壳当映射读
    // trans["0"]，永远 undefined → done 永远 0 → 从未真正写回译文（界面恒英文）。
    // 这里兼容三种返回：① 标准壳（提取 choices[0].message.content 再解析）；
    // ② 直接就是翻译映射；③ 数组。
    let transMap = parsed;
    try {
      if (parsed && Array.isArray(parsed.choices) && parsed.choices[0] && parsed.choices[0].message) {
        let c = (parsed.choices[0].message.content || '').toString();
        c = c.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
        transMap = JSON.parse(c);
      }
    } catch (e) {
      // content 内不是合法 JSON（例如模型直接回了纯文本）→ 退回外壳，交给上层按字符串兜底
      transMap = parsed;
    }
    if (Array.isArray(transMap)) {
      const out = {};
      transMap.forEach((v, i) => { out[String(i)] = v; });
      return out;
    }
    // 累计 token 消耗：OpenAI 兼容响应在 usage 字段给出 prompt/completion/total_tokens
    try {
      const u = (parsed && parsed.usage) || (transMap && transMap.usage) || null;
      if (u && typeof u.total_tokens === 'number') {
        this._tokens = this._tokens || { prompt: 0, completion: 0, total: 0, calls: 0 };
        this._tokens.prompt += (u.prompt_tokens || 0);
        this._tokens.completion += (u.completion_tokens || 0);
        this._tokens.total += (u.total_tokens || 0);
        this._tokens.calls += 1;
        this._logStatus('[token] 本次 +' + (u.total_tokens || 0) + ' / 累计 ' + this._tokens.total + ' (模型调用 ' + this._tokens.calls + ' 次)');
      }
    } catch (e) { /* 不影响翻译 */ }
    return transMap;
  }

  // 诊断：把当前页面与设置相关的关键选择器数量、跨窗口 document 信息写入 diag.txt
  async diagnoseDom() {
    const lines = [];
    lines.push('===== 跨窗口 document 探测（v0.3.1 新增，最关键）=====');
    try {
      const st = this.app.setting;
      if (!st) {
        lines.push('app.setting = 不存在（异常环境）');
      } else {
        lines.push('app.setting 存在 = 是');
        const ce = st.containerEl;
        lines.push('app.setting.containerEl 存在 = ' + (!!ce));
        if (ce) {
          lines.push('containerEl.className = ' + (ce.className || '(无class)').toString().slice(0, 200));
          lines.push('containerEl.doc === document(主窗口) ? ' + (ce.doc === document));
          const ceDoc = ce.doc || ce.ownerDocument;
          if (ceDoc) {
            lines.push('containerEl.doc 内 .setting-item = ' + ceDoc.querySelectorAll('.setting-item').length);
            lines.push('containerEl.doc 内 .modal = ' + ceDoc.querySelectorAll('.modal').length);
          } else {
            lines.push('containerEl.doc 不存在（节点未挂到任何 document，即空壳）');
          }
        }
      }
    } catch (e) {
      lines.push('读取 app.setting 出错: ' + e.message);
    }

    try {
      lines.push('activeDocument 存在 = ' + (typeof activeDocument !== 'undefined' && !!activeDocument));
      if (typeof activeDocument !== 'undefined' && activeDocument) {
        lines.push('activeDocument === document(主窗口) ? ' + (activeDocument === document));
        lines.push('activeDocument 内 .setting-item = ' + activeDocument.querySelectorAll('.setting-item').length);
        lines.push('activeDocument 内 .modal = ' + activeDocument.querySelectorAll('.modal').length);
      }
    } catch (e) {
      lines.push('读取 activeDocument 出错: ' + e.message);
    }

    lines.push('');
    lines.push('===== 各候选 document 内的设置标记数 =====');
    const docs = this.collectDocs();
    docs.forEach((d, i) => {
      if (!d) return;
      let tag = 'doc#' + i;
      if (d === document) tag += '(主窗口 document)';
      try {
        lines.push(tag + ': .setting-item=' + d.querySelectorAll('.setting-item').length +
          ' / .modal=' + d.querySelectorAll('.modal').length +
          ' / .view-content=' + d.querySelectorAll('.view-content').length);
      } catch (e) {
        lines.push(tag + ': 读取出错 ' + e.message);
      }
    });
    // 汇总：找到含设置标记的根（即翻译会命中的目标）
    const roots = this.findSettingRoots();
    lines.push('=> findSettingRoots 命中根节点数 = ' + roots.length);

    lines.push('');
    lines.push('===== 命中根节点的遍历 dry-run（纯递归 collectTranslatableNodes，不调模型）=====');
    if (roots.length === 0) {
      lines.push('（无命中根，跳过）');
    } else {
      roots.forEach((root, ri) => {
        lines.push('#' + ri + ' <' + (root.tagName || '?') + '>.' + ((root.className || '').toString().slice(0, 60)));
        try {
          lines.push('  所属 doc === 主窗口 document ? ' + (root.ownerDocument === document) + '（false 表示命中设置窗口的 document）');
          const ns = collectTranslatableNodes(root);
          lines.push('  可翻译英文文本节点数 = ' + ns.length);
          ns.slice(0, 25).forEach((node, i) => {
            lines.push('    ' + i + ': ' + node.nodeValue.trim().slice(0, 60));
          });
          // 对比：旧的「ownerDocument.createTreeWalker」方式在跨窗口下是否会抛错 / 遍历为空
          try {
            const d = root.ownerDocument || root.doc || document;
            const w = d.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
            let c = 0; while (w.nextNode()) c++;
            lines.push('  [对比] ownerDocument.createTreeWalker 文本节点数 = ' + c + '（与上行差异大或抛错，即旧方式在跨窗口下失效，新递归方式不受影响）');
          } catch (e) {
            lines.push('  [对比] ownerDocument.createTreeWalker 抛错: ' + e.message + '（旧方式失效，新递归方式不受影响）');
          }
        } catch (e) {
          lines.push('  dry-run 抛错: ' + e.message);
        }
      });
    }

    lines.push('');
    lines.push('===== 传统 CSS 选择器探测（当前主窗口 document，仅供参考）=====');
    const sel = ['.modal', '.modal.mod-settings', '.setting-item', '.vertical-tab-content',
      '.vertical-tab-header', '.setting-item-name', '.workspace-leaf', '.view-content',
      '.menu', '.suggestion-container', '.prompt', '.popover'];
    for (const s of sel) lines.push(s + ' × ' + document.querySelectorAll(s).length);

    const txt = lines.join('\n');
    try {
      const adapter = this.app.vault.adapter;
      if (!adapter || typeof adapter.write !== 'function') throw new Error('adapter 不可用');
      await adapter.write(this._pluginFilePath('diag.txt'), txt);
      new Notice('诊断已写入 diag.txt');
    } catch (e) {
      new Notice('诊断写入失败: ' + e.message);
    }
    console.log('[llm-settings-translator] DIAG\n' + txt);
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'LLM Settings Translator' });

    // 使用说明卡片（放在最顶部，方便用户一眼看到）
    const help = containerEl.createEl('div', { cls: 'llm-translator-help' });
    help.setAttribute('style', 'background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 12px 14px; margin: 6px 0 18px; font-size: var(--font-ui-smaller); line-height: 1.65; color: var(--text-muted);');
    help.createEl('div', { text: '使用说明', attr: { style: 'font-weight: 600; color: var(--text-normal); margin-bottom: 6px; font-size: var(--font-ui-small);' } });
    const helpLines = [
      '• 前提条件：LLM可正常连接，可点击测试连接按钮确认在线。',
      '• 自动翻译：打开任意设置弹窗（插件 / 核心设置）后，约 2 秒内英文会自动翻译成中文，无需点击任何按钮。',
      '• 目标语言：默认翻译成简体中文，可在「目标语言」改为任意语言，修改后重新打开设置弹窗生效。',
      '• 手动触发（可选）：也可点击功能区中的地球图标手动触发翻译。',
      '• 作用范围：只翻译设置页面内的文字，主界面与笔记正文不受影响。',
      '• 节省策略：翻译缓存与拒翻词均已持久化（cache.json / refused.json），跨会话/重启复用，不再重复消耗；空闲时轮询自动降速至 15 秒。每次翻译的 token 消耗会在翻译提示中显示。'
    ];
    helpLines.forEach((line) => help.createEl('p', { text: line, attr: { style: 'margin: 3px 0;' } }));

    new Setting(containerEl)
      .setName('API 端点 (Endpoint)')
      .setDesc('OpenAI 兼容接口需包含 /chat/completions 全路径')
      .addText(text => text
        .setPlaceholder('http://127.0.0.1:11434/v1/chat/completions')
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (v) => {
          this.plugin.settings.endpoint = v.trim();
          await this.plugin.saveSettings();
          this.plugin.resetRefused(); // 端点变更后清空拒翻记录，避免旧记录屏蔽新服务
        }));

    const langSetting = new Setting(containerEl)
      .setName('目标语言')
      .setDesc('默认简体中文。常用语言可直接下拉选择，其它语言需选择「自定义…」后再手动输入语言名。修改后重新打开设置弹窗生效（各语言翻译缓存独立，互不串用）。填了无法识别的语言名时自动按简体中文翻译。');
    // 下拉框与输入框上下分布（Obsidian 默认左右并排，这里把控件区改为纵向排列）；
    // 不设置任何宽度，与 API 端点输入框一样走 Obsidian 默认宽度，保持统一
    langSetting.controlEl.style.flexDirection = 'column';
    langSetting.controlEl.style.gap = '6px';
    let langText = null;
    let langDd = null;
    langSetting.addDropdown(dd => {
      langDd = dd;
      const cur = normalizeTargetLang(this.plugin.settings.targetLang);
      const hit = COMMON_LANGS.indexOf(cur) >= 0;
      for (const l of COMMON_LANGS) dd.addOption(l, l);
      dd.addOption('__custom__', '自定义…');
      dd.setValue(hit ? cur : '__custom__');
      dd.onChange(async (v) => {
        if (v === '__custom__') return; // 保持输入框当前值，让用户手动改
        this.plugin.settings.targetLang = v;
        if (langText) langText.setValue(v);
        await this.plugin.saveSettings();
      });
    });
    langSetting.addText(text => {
      langText = text;
      text.setPlaceholder('简体中文')
        .setValue(this.plugin.settings.targetLang)
        .onChange(async (v) => {
          const lang = normalizeTargetLang(v);
          this.plugin.settings.targetLang = lang;
          text.setValue(lang); // 无效输入即时回显为「简体中文」
          if (langDd) {
            if (COMMON_LANGS.indexOf(lang) >= 0) langDd.setValue(lang);
            else langDd.setValue('__custom__');
          }
          await this.plugin.saveSettings();
        });
      // 下拉框与输入框严格等宽：Obsidian 的 select 默认宽度比文本输入框窄（主题内置），
      // 渲染完成后把输入框的实际宽度同步给下拉框，保证两控件与 API 端点输入框宽度一致
      const syncWidth = () => {
        if (langDd && text.inputEl && text.inputEl.offsetWidth > 0) {
          langDd.selectEl.style.width = text.inputEl.offsetWidth + 'px';
          return true;
        }
        return false;
      };
      if (!syncWidth()) requestAnimationFrame(syncWidth);
    });

    new Setting(containerEl)
      .setName('模型 (Model)')
      .setDesc('调用的模型名称，例如 qwen2.5:7b / deepseek-chat / gpt-4o-mini')
      .addText(text => text
        .setPlaceholder('qwen2.5:7b')
        .setValue(this.plugin.settings.model)
        .onChange(async (v) => {
          this.plugin.settings.model = v.trim();
          await this.plugin.saveSettings();
          this.plugin.resetRefused(); // 模型变更后清空拒翻记录，新模型可能愿意翻旧模型拒翻的词
        }));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('非必填，部分本地/免费服务留空也可。输入内容以密码形式显示。')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sk-... (可留空)')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('使用当前配置发送一条测试请求，验证端点与模型是否可用。')
      .addButton(btn => btn
        .setButtonText('测试连接')
        .setCta()
        .onClick(async () => {
          btn.setButtonText('测试中...');
          btn.setDisabled(true);
          try {
            const msg = await this.plugin.testConnection();
            new Notice('连接成功: ' + msg);
          } catch (e) {
            new Notice('连接失败: ' + e.message);
          } finally {
            btn.setButtonText('测试连接');
            btn.setDisabled(false);
          }
        }));

    new Setting(containerEl)
      .setName('翻译测试')
      .setDesc('立即翻译当前页面进行测试，完成后将出现提示语。')
      .addButton(btn => btn
        .setButtonText('翻译测试')
        .onClick(() => this.plugin.translateOpenModals(true, 5000)));

    new Setting(containerEl)
      .setName('调试模式')
      .setDesc('关闭（默认）：不写入任何诊断文件（diag_status / diag_translate / diag_verify / diag_refused），版本横幅静默。开启：恢复全部诊断输出，便于排查问题。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugMode)
        .onChange(async (v) => {
          this.plugin.settings.debugMode = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('诊断 DOM 结构')
      .setDesc('若一直识别不到待翻译区域，请点击开始诊断按钮，把当前页面关键元素数量写入diag.txt（重点看顶部「跨窗口 document 探测」一节，会报告设置窗口的 document 是否被本插件探测到），便于定位问题。')
      .addButton(btn => btn
        .setButtonText('开始诊断')
        .onClick(() => void this.plugin.diagnoseDom()));

    const tk = this.plugin._tokens || { prompt: 0, completion: 0, total: 0, calls: 0 };
    new Setting(containerEl)
      .setName('累计 Token 消耗（本次会话）')
      .setDesc('合计 ' + tk.total + ' tokens，模型调用 ' + tk.calls + ' 次。翻译缓存已持久化到 cache.json，重启 Obsidian 后复用、不再重复消耗。重新打开本页或点击刷新统计按键可刷新数据。')
      .addButton(btn => btn
        .setButtonText('刷新统计')
        .onClick(() => this.display()));
  }
}

module.exports = LLMSettingsTranslator;
module.exports.default = LLMSettingsTranslator;
