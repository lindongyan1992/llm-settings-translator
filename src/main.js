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

// 拒翻判定阈值：同一英文文本被模型「原样返回（拒翻）」累计达该次数，才永久记入 refused.json、后续直接跳过。
// 低于阈值时视为「暂未译出」，每次轮询继续重试——这样限流/超时/模型偶发抖动把本可翻译的 UI 文案误判为拒翻时，
// 不会因 1 次异常就被永久屏蔽，而是在重试中译出并清零计数；只有「连续 N 次都翻不出」才认定模型真不愿翻。
const REFUSE_STRIKES = 5;

const DEFAULT_SETTINGS = {
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions', // 默认 Ollama 的 OpenAI 兼容端点，可换成任意 OpenAI 兼容服务
  apiKey: '',
  model: 'qwen2.5:7b',
  targetLang: '简体中文', // 目标语言：默认简体中文，可改成任意语言（English / 日本語 / Français / 한국어…）
  debugMode: false, // 调试模式：关闭时所有诊断文件（diag_*.txt）与版本横幅静默
  stream: true, // 流式输出：开启后用 fetch 增量读取 SSE，连接持续保活、翻译量大时不易超时；关闭则走 requestUrl 非流式（超时随批大小自适应）
  timeoutSec: 0, // 请求超时(秒)：0 = 自适应（流式 5 分钟上限 / 非流式随批大小）；>0 则作为两种模式的统一硬上限
  batchSize: 25, // 每批翻译条数：超过此值自动拆分为多子批逐批请求（分治），缓解本地小模型对大批量（如 107 项）返回纯文本无 JSON 或超时
  reasoningEffort: 'minimal' // 推理强度：默认 'minimal'（压低推理）。nemotron-3.5-lightning 等推理模型会在每条翻译前做长篇思考(占 90% token、致 300s 超时)；'minimal'/'none' 可大幅压低/关闭推理、从根上消除 300s 超时。设 'auto' 可强制不发送该参数（跟随服务默认）。若接口不支持该参数会被 400 拒绝，届时自动关闭并整批重试一次
};

const CHUNK = 150; // 单次翻译的文本条数上限（调大以减少请求次数，降低每请求重复的 system 提示词 token 开销）

// 给 Promise 加超时，避免本地 LLM 服务无响应时 requestUrl 永久挂起导致「翻译锁」卡死
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时（' + (ms / 1000) + 's），本地 LLM 服务可能无响应或被占用')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// 从模型可能夹带的「思考过程 / 解释 / 代码围栏」中提取纯 JSON 子串。
// 本地小模型 / 推理模型常在 JSON 前后输出英文分析，或把 JSON 用 ```json 包裹，
// 本函数剥离所有噪声，返回第一个 { 到最后一个 }（或 [ 到 ]）之间的子串；无法定位返回 null。
// 容错 JSON 解析：先严格，失败再修复常见「模型不守规则」写法——裸 key（{0:...} 而非 {"0":...}）、尾随逗号。
// 返回解析后的对象/数组，失败返回 null。不处理单引号字符串（避免与值内双引号冲突引入新 bug）。
function looseParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  try { const p = JSON.parse(s); if (p !== null && typeof p === 'object') return p; } catch (e) { /* 严格失败，走容错 */ }
  try {
    let t = s.replace(/([{,]\s*)([A-Za-z0-9_$\u4e00-\u9fa5]+)\s*:/g, '$1"$2":'); // 裸 key 加引号
    t = t.replace(/,(\s*[}\]])/g, '$1');                                       // 去尾随逗号
    const p = JSON.parse(t);
    if (p !== null && typeof p === 'object') return p;
  } catch (e) { /* 仍失败 */ }
  return null;
}

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text;
  s = s.replace(/```(?:json)?/gi, '');            // 去代码围栏标记
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ''); // 去推理块
  s = s.trim();
  if (!s) return null;

  // 1) 尾部优先：模型真正的 JSON 几乎总是在响应末尾（前面是英文/中文思考前缀）。
  //    枚举所有 { / [ 起点（索引降序），逐个做括号平衡扫描；思考里的多余闭合括号被忽略；
  //    文末截断（缺闭合括号）则按栈逆序补括号修复。收集所有能解析的对象，返回 key 最多的——
  //    这样即使思考里夹了零散 {..} 草稿，也会命中末尾最完整的真实 JSON。
  const openIdx = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') openIdx.push(i);
  }
  openIdx.sort((a, b) => b - a); // 越靠近末尾越优先尝试
  let best = null, bestKeys = -1;
  for (const start of openIdx) {
    const sub = balancedSlice(s, start, true);
    if (sub == null) continue;
    const p = looseParseJson(sub);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const n = Object.keys(p).length;
      if (n > bestKeys) { bestKeys = n; best = p; }
    }
  }
  if (best != null) return best;

  // 2) 全扫描兜底：收集所有平衡区间，优先最长的逐个尝试解析（处理 JSON 不在末尾等少见情况）。
  const open = { '{': '}', '[': ']' };
  const close = { '}': '{', ']': '[' };
  const candidates = [];
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {            // 跳过字符串字面量（含转义 \"）
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '"') break;
        i++;
      }
      continue;
    }
    if (open[ch]) {
      stack.push({ ch, pos: i });
    } else if (close[ch]) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].ch === close[ch]) {
          candidates.push([stack[j].pos, i]);
          stack.splice(j, 1);
          break;
        }
      }
    }
  }
  candidates.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])); // 长的优先
  for (const [a, b] of candidates) {
    const sub = s.slice(a, b + 1);
    const parsed = looseParseJson(sub);
    if (parsed && (typeof parsed === 'object')) return parsed;
  }
  return null;
}

// 从 start 位置向前做括号平衡扫描（正确跳过字符串字面量与转义）。
// 遇到与栈顶匹配的闭合括号则正常收束；遇到不匹配的多余闭合括号（思考里的 stray }）忽略。
// 到达文末仍缺闭合括号且 allowRepair=true 时，按未闭合类型栈逆序补上缺失的闭合括号后返回修复串。
function balancedSlice(s, start, allowRepair) {
  const openCh = s[start];
  const typeStack = [openCh]; // 尚未闭合的 opener 栈
  let inStr = false, esc = false;
  for (let k = start + 1; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = false; continue; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { typeStack.push(c); continue; }
    if (c === '}' || c === ']') {
      const expect = typeStack[typeStack.length - 1];
      const match = (c === '}' && expect === '{') || (c === ']' && expect === '[');
      if (match) {
        typeStack.pop();
        if (typeStack.length === 0) return s.slice(start, k + 1); // 完整闭合
      }
      // 不匹配的闭合括号忽略（thinking 噪声）
    }
  }
  if (typeStack.length > 0 && allowRepair) {
    let repair = '';
    for (let m = typeStack.length - 1; m >= 0; m--) {
      repair += typeStack[m] === '{' ? '}' : ']';
    }
    return s.slice(start) + repair; // 文末截断：补闭合括号救回译文
  }
  return null;
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
      '(3) Do not add explanations or markdown code fences. ' +
      'CRITICAL: Output the JSON object ONLY — your entire response must start with { and end with }, with absolutely no reasoning, commentary, or per-item narration before or after it.';
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
      this._logStatus('===== 插件已加载 (onload) v1.4.21 =====');
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
              // 载入即对键做空白归一，使升级前的旧缓存与现版归一键互认、不丢历史译文
              let lang, text;
              const di = kv[0].indexOf('::');
              if (di >= 0) { lang = kv[0].slice(0, di); text = kv[0].slice(di + 2); }
              else { lang = '简体中文'; text = kv[0]; }
              this._transCache.set(lang + '::' + this._normKeyText(text), kv[1]);
            }
          }
        }
      }
    } catch (e) { /* 载入失败不影响主流程 */ }
    // 模型拒绝集：某英文文本经模型翻译后仍原样返回（模型不愿翻的专有名词/技术词），
    // 记录下来，后续收集时跳过，避免自动轮询每 2 秒把它重新送给慢速本地模型空跑（那些 done=0 的循环）。
    this._refused = new Set();
    this._refuseCount = new Map(); // 拒翻计数：key -> 连续被模型原样返回的次数（达 REFUSE_STRIKES 才永久拒翻）；仅存内存，重启后重新计数
    // 持久化拒翻词：从 refused.json 载入历史拒翻键（含语言前缀），重启后直接跳过、不再重复送模型确认
    let refusedDirty = false;
    try {
      const rAdapter = this.app.vault.adapter;
      const rp = this._pluginFilePath('refused.json');
      if (rAdapter && typeof rAdapter.exists === 'function' && await rAdapter.exists(rp)) {
        const rArr = JSON.parse(await rAdapter.read(rp));
        if (Array.isArray(rArr)) {
          for (const k of rArr) {
            if (typeof k !== 'string' || !k) continue;
            // 加载期自我净化：仅保留「明显不可译」（版本号等）的拒翻键，丢弃历史误伤的可译 UI 文案。
            // 历史误伤来源：旧版在模型超时返回残缺 JSON（缺 key）时把可译文案误判为拒翻并持久化，
            // 卸载时 onunload 又会把内存旧集合 flush 回磁盘，导致磁盘清理被覆盖、死灰复燃。
            // 丢弃后在下次翻译时这些文本会重新送模型并翻译/缓存；v1.4.10 的拒翻判定已不会再把它们误判为拒翻。
            const idx = k.indexOf('::');
            const orig = idx >= 0 ? k.slice(idx + 2) : k;
            if (_looksLikeNonTranslatable(orig)) this._refused.add(k);
            else refusedDirty = true;
          }
        }
      }
    } catch (e) { /* 载入失败不影响主流程 */ }
    if (refusedDirty) void this._flushRefused(); // 净化后落盘，避免下次卸载 flush 又把误伤写回
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
    this._startRestoreLoop(); // 300ms 紧循环兜底恢复：根治切 tab / 重绘后变回英文
    this._startLongTextLoop(); // v1.4.21：60ms 长描述专项恢复（≥120 字符的说明文字）
    // 初次加载后尝试一次（一般无弹窗，安全）
    setTimeout(() => this.translateOpenModals(false), 2000);
    // 主动捕获设置 tab 切换：点击左侧导航即触发（debounce）翻译 / 恢复，
    // 弥补「切 tab 时 Obsidian 重建内容节点、旧 MutationObserver 失效」导致译文回退成英文的问题，
    // 使切回页面后中文即时恢复，不再等待轮询周期。
    this._tabClickHandler = (ev) => {
      const el = ev && ev.target;
      if (!el || !el.closest) return;
      if (el.closest('.vertical-tab-header') || el.closest('.vertical-tab-header-group') || el.closest('.setting-tab')) {
        // 立即（下一帧）用缓存把已译项翻回中文——切 tab 是"变回英文"最典型的场景，
        // 先做零延迟的缓存恢复，再等 debounce 后的完整翻译流程。
        try { this._rafRestore(); } catch (e) { /* 忽略 */ }
        if (this._tabClickTimer) clearTimeout(this._tabClickTimer);
        this._tabClickTimer = setTimeout(() => {
          try { this._rafRestore(); } catch (e2) { /* 忽略 */ }
          if (!this.translating) this.translateOpenModals(false);
        }, 300);
      }
    };
    document.addEventListener('click', this._tabClickHandler, true);
  }

  onunload() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this._watchDog) clearInterval(this._watchDog);
    if (this._restoreTimer) clearInterval(this._restoreTimer);   // v1.4.15：300ms 紧循环恢复
    if (this._longTextTimer) clearInterval(this._longTextTimer); // v1.4.21：长描述专项恢复
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer); // v1.4.18：合并兜底重扫
    if (this._fallbackTimer2) clearTimeout(this._fallbackTimer2);
    if (this._cacheSaveTimer) clearTimeout(this._cacheSaveTimer);
    if (this._guardObsMap) { for (const obs of this._guardObsMap.values()) { try { obs.disconnect(); } catch (e) {} } }
    if (this._tabClickHandler) { try { document.removeEventListener('click', this._tabClickHandler, true); } catch (e) {} }
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
    }, 6000);
  }

  // rAF 级即时恢复（v1.4.17 新增）：根发现修好后，剩下的观感问题是「重绘 → 300ms 紧循环」之间
  // 存在一个可见英文的空窗。用 requestAnimationFrame 在下一帧就套用缓存译文，把空窗压到一帧以内。
  // 内建 80ms 节流，避免与其它恢复路径抢 CPU。
  // 【v1.4.21】节流放宽到 30ms：长设置描述（300~600 字符）是用户最在意的部分，
  // 而它所在的 .setting-item-description 恰好在插件重渲染时被整段替换，空窗最刺眼。
  _rafRestore() {
    if (!this._transCache || this._transCache.size === 0) return;
    const now = Date.now();
    if (now - (this._lastRaf || 0) < 30) return;
    this._lastRaf = now;
    try {
      const roots = this.findSettingRoots();
      for (const r of roots) {
        const n = this._applyCached(r);
        if (n > 0 && this.settings && this.settings.debugMode) {
          this._logStatus('rAF 恢复 ' + n + ' 项（根数=' + roots.length + '）');
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  // 【v1.4.21 新增】长描述专项高频恢复：单独一个 60ms 循环，只处理「长度≥120 的英文节点」。
  // 起因：长设置描述的缓存命中与恢复链路本身是正确的（已入 cache.json、key 精确匹配），
  // 但它所在的 DOM 片段在 Obsidian 重渲染时会被整体替换，300ms 紧循环 + rAF 仍有可感知空窗，
  // 表现为「长描述反复变回英文、又重新翻译」。这里用独立的高频循环专攻长文本，把空窗压到最小。
  _startLongTextLoop() {
    if (this._longTextTimer) return;
    const self = this;
    this._longTextTimer = setInterval(() => {
      try {
        if (!self._transCache || self._transCache.size === 0) return;
        const roots = self.findSettingRoots();
        if (!roots.length) return;
        let restored = 0;
        for (const r of roots) {
          if (!r || !r.isConnected) continue;
          let nodes;
          try { nodes = collectTranslatableNodes(r); } catch (e) { continue; }
          for (const n of nodes) {
            const t = (n.nodeValue || '');
            if (!t || t.length < 120) continue;          // 只管长描述，短项交给紧循环
            const trimmed = t.trim();
            const cn = self._transCache.get(self._ckey(trimmed));
            if (cn && cn !== trimmed) { n.nodeValue = cn; restored++; }
          }
        }
        if (restored > 0 && self.settings && self.settings.debugMode) {
          const now = Date.now();
          if (now - (self._lastLongRestore || 0) > 3000) {
            self._lastLongRestore = now;
            self._logStatus('长描述恢复: ' + restored + ' 项（长度≥120）');
          }
        }
      } catch (e) { /* 忽略 */ }
    }, 60);
  }

  // 紧循环兜底恢复（v1.4.15 新增，根治「切 tab / 重绘后变回英文」）：
  // 每 300ms 重新探测所有设置根，用缓存把可见英文即时翻回中文。它不依赖 MutationObserver 是否恰好
  // 命中重建节点、不依赖 translating 锁、不依赖单一根节点是否存活——只要缓存有该词、且该词当前可见，
  // 最迟 300ms 内必被翻回。这是对「守护 observer + 自适应轮询」的最后一道、也是最稳的一道保险。
  _startRestoreLoop() {
    if (this._restoreTimer) return;
    const self = this;
    this._restoreTimer = setInterval(() => {
      try {
        const roots = self.findSettingRoots();
        if (!roots.length) {
          // 看门狗：命中根数=0 是「变英文」的根因，必须留痕。用「缓存样本 key 是否在 body 可见」
          // 区分「设置真没打开」与「设置开着但我们找不到根」——后者每 5s 记一次，便于事后定位。
          const now = Date.now();
          if (self.settings && self.settings.debugMode && now - (self._lastNoRootLog || 0) > 5000) {
            self._lastNoRootLog = now;
            let visible = 0;
            try {
              const docs = self.collectDocs();
              for (const doc of docs) {
                if (!doc || !doc.body) continue;
                const body = doc.body.textContent || '';
                let i = 0, hit = 0;
                for (const [k, v] of self._transCache) {
                  if (k === v) continue;
                  const orig = k.indexOf('::') >= 0 ? k.slice(k.indexOf('::') + 2) : k;
                  if (orig && orig.length >= 6 && body.indexOf(orig) >= 0) hit++;
                  if (++i >= 200) break;
                }
                visible += hit;
              }
            } catch (e) { /* 忽略 */ }
            self._logStatus('restoreLoop: 命中根数=0｜缓存样本在 body 可见数=' + visible
              + '（visible>0 说明设置已打开但根发现失败＝真因；visible=0 说明设置未打开，正常）');
            // visible>0 → 根发现失败且确有可见英文：自动落盘完整 DOM 快照，事后无需用户点任何按钮即可定位
            if (visible > 0) {
              try { void self._dumpRootFailureDiag(visible); } catch (e3) { /* 忽略 */ }
            }
          }
          return;
        }
        let total = 0;
        let pending = 0;
        let longestEn = null;     // v1.4.21：记录本轮所见最长英文节点（长描述专项诊断用）
        for (const r of roots) {
          const n = self._applyCached(r);
          if (n > 0) total += n;
          // 统计仍未缓存的英文（切 tab 后新出现、或首翻尚未覆盖的），用于决定是否需要发起翻译
          try {
            const nodes = collectTranslatableNodes(r);
            for (const nd of nodes) {
              const t = (nd.nodeValue || '').trim();
              if (!t) continue;
              if (!longestEn || t.length > longestEn.length) longestEn = t;
              const ck = self._ckey(t);
              if (self._transCache && self._transCache.has(ck)) continue;
              if (self._refused && self._refused.has(ck)) continue;
              if (self._looksLikeNonTranslatable(t)) continue;   // v1.4.19：技术记号不触发翻译
              pending++;
            }
          } catch (e2) { /* 忽略 */ }
        }
        if (total > 0 && self.settings && self.settings.debugMode) {
          self._logStatus('restoreLoop: 即时恢复 ' + total + ' 项英文→中文（缓存命中）');
        }
        // 【v1.4.21 长描述专项诊断】若扫描到的最长英文节点长度可观（≥120 字符，说明是设置说明文字）
        // 却始终没被恢复（total=0），说明「缓存里有译文、但实时 DOM 里的同一段英文匹配不上缓存 key」。
        // 这类"缓存命中不了"的情况肉眼就是"长描述反复变英文"，必须留痕才能定位。
        if (self.settings && self.settings.debugMode && longestEn && longestEn.length >= 120 && total === 0) {
          const nowL = Date.now();
          if (nowL - (self._lastLongMiss || 0) > 8000) {
            self._lastLongMiss = nowL;
            const ckL = self._ckey(longestEn);
            const inCache = !!(self._transCache && self._transCache.has(ckL));
            self._logStatus('长描述未恢复: 长度=' + longestEn.length
              + ' 缓存命中=' + inCache
              + ' 归一键长度=' + self._normKeyText(longestEn).length
              + ' 原文前60=' + JSON.stringify(longestEn.slice(0, 60)));
          }
        }
        // 存在未缓存英文且当前空闲 → 主动发起翻译（带 1.2s 节流）。
        // 之前紧循环只做缓存恢复、不翻新词，导致「切 tab 后新出现的英文」要等轮询（最慢 6s）才翻，
        // 观感就是"切回来先是英文、过一会儿才变中文"。这里补上即时翻译触发。
        if (pending > 0 && !self.translating) {
          const nowp = Date.now();
          if (nowp - (self._lastPendingTrigger || 0) > 1200) {
            self._lastPendingTrigger = nowp;
            for (const r of roots) { if (r && r.isConnected) self.translateScope(r, false); }
          }
        }
        // 根数异常告警：设置页正常只应是 1~3 个根。若又出现几十个，说明容器过滤失效、
        // 笔记/编辑器被误当设置根（会导致同一批文本反复重翻）。留痕便于第一时间发现。
        if (self.settings && self.settings.debugMode && roots.length > 6) {
          const now2 = Date.now();
          if (now2 - (self._lastRootWarn || 0) > 30000) {
            self._lastRootWarn = now2;
            const tags = roots.slice(0, 8).map((r) => r.tagName + '.' + (r.className || '').toString().split(' ').slice(0, 2).join('.')).join(' | ');
            self._logStatus('⚠ restoreLoop 根数异常=' + roots.length + '（疑似误含笔记/编辑器视图）: ' + tags);
          }
        }
      } catch (e) { /* 忽略 */ }
    }, 300);
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
      let arr = Array.from(this._transCache.entries()).filter((kv) => kv[0] !== kv[1] && !this._looksDynamic(kv[0]));
      if (arr.length > 10000) arr = arr.slice(arr.length - 10000); // 体积上限放宽（常规设置文案远多于动态垃圾），超出保留最近
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
    if (this._refuseCount) this._refuseCount.clear();
    void this._flushRefused();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 兼容性纠正：v11 之前 reasoningEffort 字段不存在，旧 data.json 可能持久化了空串 ""。
    // Object.assign 合并时空串会覆盖 DEFAULT_SETTINGS 的 'minimal'，导致「满推理 → 300s 超时 →
    // 翻译永不落盘、界面永不写回、轮询每 30s 死循环重发」的现象。空串/缺失一律回退为 'minimal'（即默认意图）。
    if (!this.settings.reasoningEffort) this.settings.reasoningEffort = 'minimal';
  }

  // 插件目录内文件的跨平台相对路径（桌面端与移动端 adapter 均可用，替代 Node 文件系统 API，
  // 让翻译缓存与诊断文件在移动端也能正常读写）
  _pluginFilePath(file) {
    return '.obsidian/plugins/llm-settings-translator/' + file;
  }

  // 缓存键文本归一：折叠所有空白（空格/制表/换行）为单空格并 trim。
  // 插件更新若只改了前后/内部空白，归一后键仍一致 → 命中旧译文，无需重翻。
  _normKeyText(t) {
    if (!t) return '';
    return String(t).replace(/\s+/g, ' ').trim();
  }
  // 判断文本是否明显动态（日期/文件名/超长），这类不值得缓存，避免挤掉常规设置文案。
  // 【v1.4.20 修正】原阈值 300 字符会误伤「合法的长设置描述」——Remotely Save / Notebook Navigator
  // 等插件的说明文字普遍 300~600 字符，被判为动态后【拒绝入缓存】，于是：
  //   翻译成功(done=1) → 不入缓存 → Obsidian 重建节点 → 又变"新项" → 再翻一次 → 无限循环，
  // 表现为「同一条描述被反复重翻、界面反复变英文」（日志实证：315 字符的长描述，
  // `done=1/1 实时仍英文=12` 反复出现，cache.json 中该条命中数=0）。
  // 现把阈值提高到 1200，并在【不含日期、不像文件路径】时不再因长度排除——
  // 真正该排除的是「含具体日期/文件名的动态值」，而非「长得像说明文字的静态文案」。
  _looksDynamic(text) {
    if (!text) return false;
    const t = typeof text === 'string' ? text : String(text);
    if (t.length > 1200) return true;                    // 极端超长（多为日志/堆栈文本）仍排除
    if (/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/.test(t)) return true; // 含日期：2026-08-19 等
    // 含扩展名且无空格（更像文件名/路径，而非设置句）
    if (/\.[a-z0-9]{2,5}\b/i.test(t) && t.indexOf(' ') < 0) return true;
    return false;
  }
  // 判断文本是否明显「不应翻译」（用于保守地记入拒翻词，避免误伤本可翻译的 UI 文案）。
  // 覆盖三类模型几乎必然原样返回、且反复重翻纯浪费 token 的技术记号：
  //  1) 版本号：v1.2.3 / v0.2.11
  //  2) 计量单位记号：1 MB / 5 GB / 100 KB / 30%（下拉框常见选项，译了也没意义）
  //  3) 纯 URL / 邮箱：http(s)://… / name@example.com
  // 其余（如 "Vault profile" "Add profile..." 等真实 UI 文案）一律不当作拒翻，留待重试翻译。
  // 【v1.4.19 起因】实测下拉框里的 "1 MB"…"1000 MB" 这类项从未进缓存（模型原样返回→既不缓存也不拒翻，
  // 仍在 5 次观察期内），于是每轮都被当"新待翻译项"反复送模型，日志出现
  // `待翻译 12 项 → done=1/12 实时仍英文=11 → 待翻译 11 项` 的死循环，界面因此反复闪英文。
  _looksLikeNonTranslatable(text) {
    if (!text) return false;
    const t = (typeof text === 'string' ? text : String(text)).trim();
    if (!t) return false;
    // 1) 版本号
    if (/^v\d+\.\d+(\.\d+)*$/i.test(t)) return true;
    // 2) 计量单位记号（纯数字+单位，可含空格/小数）：1 MB、5GB、100 KB、30%、1.5 s
    if (/^\d+(?:[.,]\d+)?\s?(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB|ms|s|sec|min|hr|h|px|em|rem|%|B|K|M|G|T)$/i.test(t)) return true;
    // 3) 纯 URL / 邮箱
    if (/^https?:\/\/\S+$/i.test(t)) return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return true;
    return false;
  }
  // 翻译缓存 / 拒翻词的语言隔离键：英文 "Settings" 在中文目标下译为"设置"、日语下译为"設定"，
  // 键形如 "简体中文::Settings" / "日本語::Settings"。切换目标语言后各语言缓存互不串用，旧语言缓存保留。
  // 键做空白归一（_normKeyText），提升跨插件更新的复用率。
  _ckey(t) {
    return normalizeTargetLang(this.settings && this.settings.targetLang) + '::' + this._normKeyText(t);
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
    const resp = await withTimeout(requestUrl({
      url: s.endpoint,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (s.apiKey || '')
      },
      body: JSON.stringify(body)
    }), 15000, '测试连接');
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
    this._pruneGuardObs(); // 清理已脱离文档的旧根 observer（切 tab / 视图重建后），避免 Map 无限增长
    // 【v1.4.18 收敛】原实现对【每个根】都挂 800ms / 1500ms 两个兜底重翻定时器，3 个根即 6 个定时器；
    // 叠加每 2s 轮询与 translateOpenModals 自身的 500ms 等待，导致同一批根在 1~2 秒内被重复全量扫描
    // 3~5 次（实测日志同秒内出现多条"命中根节点 3 个 / translateScope"）。高频全量 DOM 遍历
    // 不但空耗 CPU，还会与 Obsidian 自己的重绘争抢主线程，反而放大"重绘把译文冲掉 → 再次变英文"。
    // 现改为：① 根仍各自挂 observer（守护是必要的）；② 兜底重翻【全根合并为一次】，且做节流；
    // ③ 兜底前先走 _applyCached 同步恢复（零延迟），只有确实还有未缓存英文时才发起网络翻译。
    for (const r of roots) {
      this.guardRoot(r);
      // 首次仍立即翻译（保持原行为：打开设置页立刻翻，不等兜底定时器）
      this.translateScope(r, verbose);
    }
    this._scheduleFallbackRescan(roots);
  }

  // 合并式兜底重扫：所有根共用一个定时器，并按 700ms 节流。切 tab / 异步渲染出未缓存英文时才真正翻译。
  _scheduleFallbackRescan(roots) {
    const self = this;
    if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
    const run = () => {
      self._fallbackTimer = null;
      if (self.translating) return;                 // 正在翻译就跳过，轮询/紧循环会兜住
      const now = Date.now();
      if (now - (self._lastFallback || 0) < 700) return;
      self._lastFallback = now;
      for (const r of roots) {
        if (!r || !r.isConnected) continue;
        // 先同步恢复缓存（零延迟、不进网络），只有仍存在未缓存英文时才调 translateScope 发请求
        let applied = 0;
        try { applied = self._applyCached(r); } catch (e) { /* 忽略 */ }
        if (applied === 0) self.translateScope(r, false);
      }
    };
    this._fallbackTimer = setTimeout(run, 800);
    if (!this._fallbackTimer2) {
      this._fallbackTimer2 = setTimeout(() => {
        this._fallbackTimer2 = null;
        const now = Date.now();
        if (now - (this._lastFallback2 || 0) < 700) return;
        this._lastFallback2 = now;
        for (const r of roots) {
          if (!r || !r.isConnected) continue;
          let applied = 0;
          try { applied = this._applyCached(r); } catch (e) { /* 忽略 */ }
          if (applied === 0) this.translateScope(r, false);
        }
      }, 1500);
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
        if (this._looksLikeNonTranslatable(t)) continue;  // v1.4.19：技术记号不算待翻译项
        return true;
      }
    }
    return false;
  }

  // Obsidian 官方 API 提供的权威容器候选（不依赖 CSS 类名）。
  // 【关键】iterateAllLeaves 会返回【所有】工作区叶子视图（笔记编辑器、右侧栏、各类插件面板…），
  // 若不加过滤地全当设置根，会让每轮扫描命中几十个无关根（实测「命中根节点 21 个」），
  // 把笔记/编辑器里的英文持续当"待翻译项"反复送模型、又立刻被重绘冲掉——即用户看到的
  // 「变回英文然后又重新翻译」。因此这里只返回【确实含设置标记、且不是笔记/编辑器视图】的容器。
  _apiContainers() {
    const out = [];
    const MARK = '.setting-item, .vertical-tab-content, .vertical-tab-header, .setting-item-name';
    const NOTE = '.cm-editor, .markdown-source-view, .markdown-reading-view, .markdown-preview-view, .graph-view, .canvas-wrapper, .view-content';
    const looksLikeSettings = (el) => {
      if (!el || el.nodeType !== 1) return false;
      try {
        // 必须是含设置标记的容器；纯笔记/编辑器视图直接排除
        if (!el.querySelector || !el.querySelector(MARK)) return false;
        if (el.matches && el.matches(NOTE)) return false;
        return true;
      } catch (e) { return false; }
    };
    // 1) 设置界面容器（最权威）
    try {
      const sc = this.app.setting && this.app.setting.containerEl;
      if (sc) out.push(sc);
    } catch (e) { /* 忽略 */ }
    // 2) 工作区叶子视图：只保留其中含设置标记的（排除笔记编辑器/侧栏等无关视图）
    try {
      this.app.workspace.iterateAllLeaves((leaf) => {
        try {
          const vc = leaf.view && (leaf.view.containerEl || (leaf.view.contentEl && leaf.view.contentEl.parentElement));
          if (vc && looksLikeSettings(vc)) out.push(vc);
        } catch (e2) { /* 忽略 */ }
      });
    } catch (e) { /* 忽略 */ }
    return out;
  }

  // 查找设置弹窗根节点（跨 document 探测）。策略（v1.4.16，从根上修「命中根数=0」盲区）：
  //  A) Obsidian API 容器优先（app.setting.containerEl + 全部叶子视图）——权威、不依赖类名；
  //  B) DOM 兜底三层：所有含设置标记的 .modal → 非笔记类 .view-content → 任意设置标记元素向上兜底；
  //  C) 「已译 key 全文反查」：若 A/B 都没找到（容器类名与本插件假设不符），
  //     则在所有 document.body 里用翻译缓存的 key 反查包含这些 key 的元素，把命中的元素当作根。
  //     这一层保证「只要某词曾译出中文且当前可见，就一定能被找到并即时恢复」，不依赖任何容器结构假设。
  //  最后做包含关系去重（去掉被其它根包含的），避免重复处理。
  findSettingRoots() {
    const MARK = '.setting-item, .vertical-tab-content, .vertical-tab-header, .setting-item-name';
    const NOTE = '.cm-editor, .markdown-source-view, .markdown-reading-view, .markdown-preview-view, .graph-view, .canvas-wrapper';
    const docs = this.collectDocs();
    const candidates = [];
    const push = (el) => { if (el && el.nodeType === 1) candidates.push(el); };

    // A) Obsidian API 容器
    for (const c of this._apiContainers()) push(c);

    for (const doc of docs) {
      if (!doc) continue;
      // B1) 所有含 MARK 的 .modal
      try {
        doc.querySelectorAll('.modal').forEach((m) => { if (m.querySelector && m.querySelector(MARK)) push(m); });
      } catch (e) { /* 忽略 */ }
      // B2) 所有含 MARK 且非笔记编辑器的 .view-content
      try {
        doc.querySelectorAll('.view-content').forEach((v) => { if (!v.querySelector(NOTE) && v.querySelector(MARK)) push(v); });
      } catch (e) { /* 忽略 */ }
      // B3) 兜底：任意设置标记元素，只向上找「安全容器」（设置 modal / 非笔记 view-content / 设置 tab 容器）。
      // 【v1.4.17 修正】原兜底会退到 anyMark.parentElement，那可能只是单个 .setting-item，
      // 会漏掉同一 tab 内其它设置项，且有落入笔记区域的风险；现改为逐级向上找，直到命中安全容器为止。
      try {
        const anyMark = doc.querySelector(MARK);
        if (anyMark) {
          let up = anyMark.closest('.modal, .view-content, .workspace-drawer, .prompt, .vertical-tab-content');
          if (up && !up.querySelector(NOTE)) push(up);
          else if (up && up.closest('.modal, .view-content')) push(up.closest('.modal, .view-content'));
          else if (anyMark.closest('.setting-item') && anyMark.closest('.setting-item').parentElement) {
            // 极端兜底：至少取设置项的父容器（覆盖整个设置项区域）
            const si = anyMark.closest('.setting-item');
            if (si && si.parentElement) push(si.parentElement);
          }
        }
      } catch (e) { /* 忽略 */ }
    }

    // C) 已译 key 全文反查（兜底之兜底）：在所有 document.body 里找包含「任一已译 key」的最小元素
    if (candidates.length === 0 && this._transCache && this._transCache.size > 0) {
      // 取一批样本 key（避免遍历整个缓存过慢）
      const samples = [];
      let i = 0;
      for (const [k, v] of this._transCache) {
        if (k === v) continue; // 跳过「key===value」的自映射
        const orig = k.indexOf('::') >= 0 ? k.slice(k.indexOf('::') + 2) : k;
        if (orig && orig.length >= 2 && orig.length <= 80 && !/[\u4e00-\u9fff]/.test(orig)) samples.push(orig);
        if (++i >= 400) break;
      }
      for (const doc of docs) {
        if (!doc || !doc.body) continue;
        for (const s of samples) {
          try {
            // 用 TreeWalker 找包含该 key 文本的元素
            const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
            let n;
            while ((n = walker.nextNode())) {
              if (n.nodeValue && n.nodeValue.indexOf(s) >= 0) {
                const host = n.parentElement;
                if (host) push(host.closest('.modal, .view-content, .workspace-drawer') || host);
                break;
              }
            }
          } catch (e) { /* 忽略 */ }
          if (candidates.length > 0) break; // 找到一个即可
        }
        if (candidates.length > 0) break;
      }
    }

    // 包含关系去重：去掉被其它候选根包含的元素（保留最外层），避免 modal 与其内部 content 重复处理
    const keep = [];
    for (const a of candidates) {
      let contained = false;
      for (const b of candidates) {
        if (a !== b && b !== a && b.contains && b.contains(a)) { contained = true; break; }
      }
      if (!contained) keep.push(a);
    }
    return keep;
  }


  // 为设置根节点挂一个持久「守护」：一旦 Obsidian 因重绘 / 切换标签 / 焦点变化
  // 重置了文本节点（把已翻译的中文变回英文），立即（debounce 后）重新翻译。
  // 跨窗口安全：observer 挂在 root 节点上，无论它属于哪个 document，都能正确观测其子树变化。
  // 防死循环：翻译写回后节点变中文，collectTranslatableNodes 会过滤掉（isMostlyEnglish=false），
  // 再次触发时收集到 0 个英文即 return，不会无限重翻。
  // 多根守护：维护 root→observer 的 Map，对每个当前设置根节点独立挂 MutationObserver。
  // 相比早期「单例只守护最后一个 root」，多根能覆盖「设置弹窗 + 独立视图 + 切 tab 后重建的新根节点」等情形，
  // 避免切 tab / 重绘时旧根被重建、旧 observer 失效却无人接管新根，导致译文回退成英文。
  guardRoot(root) {
    if (!root) return;
    if (!this._guardObsMap) this._guardObsMap = new Map();
    if (this._guardObsMap.has(root)) return; // 该根已守护，避免重复
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
      this._guardObsMap.set(root, obs);
    } catch (e) {
      console.error('[llm-settings-translator] guard observer failed', e);
    }
  }

  // 清理已脱离文档的守护 observer（settings 视图被销毁/重建后，旧根节点不在文档中，其 observer 已无意义），
  // 防止 _guardObsMap 无限增长，并避免对已死根做无用观测。在每次 translateOpenModals 重挂根时调用。
  _pruneGuardObs() {
    if (!this._guardObsMap) return;
    for (const [root, obs] of this._guardObsMap) {
      try { if (!root || !root.isConnected) { obs.disconnect(); this._guardObsMap.delete(root); } } catch (e) { /* 忽略 */ }
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

  // 根发现失败时的自动诊断快照（由 300ms 紧循环看门狗在「可见英文>0 且命中根数=0」时自动触发）：
  // 穷举各 document 下所有可能承载设置的容器（.modal / .view-content / .vertical-tab-content /
  // .setting-item / body 等），逐个统计「其中缓存样本 key 可见数」与「可翻译英文节点数」，
  // 用来确定可见英文究竟挂在哪个容器下（可能根本不在 .modal / .view-content 里）。
  async _dumpRootFailureDiag(visible) {
    try {
      const now = Date.now();
      if (now - (this._lastFailDump || 0) > 20000) return; // 20s 最多一次，避免刷盘
      this._lastFailDump = now;
      const lines = [];
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      lines.push('=== 根发现失败自动诊断 ' + ts + ' (v1.4.16) ===');
      lines.push('缓存样本在 body 可见数=' + visible + '（说明设置确实开着、且有已译词当前可见，但命中根数=0）');
      const docs = this.collectDocs();
      lines.push('候选 document 数: ' + docs.length);
      const SELS = ['.modal', '.modal-container', '.view-content', '.vertical-tab-content',
        '.vertical-tab-header-group', '.setting-item', '.workspace-drawer', '.prompt', '.popup'];
      let di = 0;
      for (const doc of docs) {
        if (!doc) continue;
        lines.push('--- document[' + (di++) + '] body可见字符数=' + ((doc.body && doc.body.textContent || '').length) + ' ---');
        for (const sel of SELS) {
          let els = [];
          try { els = Array.from(doc.querySelectorAll(sel)); } catch (e) { continue; }
          if (!els.length) continue;
          const rows = [];
          els.forEach((el, idx) => {
            let body = '';
            try { body = el.textContent || ''; } catch (e) {}
            // 统计缓存样本 key 在此容器内的可见数
            let i = 0, hit = 0, samples = [];
            for (const [k, v] of (this._transCache || new Map())) {
              if (k === v) continue;
              const orig = k.indexOf('::') >= 0 ? k.slice(k.indexOf('::') + 2) : k;
              if (orig && orig.length >= 6 && !/[\u4e00-\u9fff]/.test(orig)) {
                if (body.indexOf(orig) >= 0) { hit++; if (samples.length < 5) samples.push(orig); }
              }
              if (++i >= 200) break;
            }
            const en = this._liveEnCount(el);
            if (hit > 0 || en > 0) {
              rows.push('    [' + sel + '#' + idx + '] tag=' + el.tagName + ' class="' + (el.className || '').toString().slice(0, 70)
                + '" 缓存key可见=' + hit + ' 可译英文节点=' + en + (samples.length ? ' 样例=' + JSON.stringify(samples) : ''));
            }
          });
          if (rows.length) { lines.push('  ' + sel + ' 命中 ' + rows.length + ' 个容器：'); rows.forEach((r) => lines.push(r)); }
        }
      }
      const content = lines.join('\n') + '\n';
      try {
        const adapter = this.app.vault.adapter;
        if (adapter && typeof adapter.write === 'function') {
          await adapter.write(this._pluginFilePath('diag_rootfail.txt'), content);
        }
      } catch (e2) { /* 忽略 */ }
    } catch (e) { /* 忽略 */ }
  }

  // 注：原 v1.4.15/v1.4.16 的手动诊断方法 _diagVisible 已随丝带诊断按钮一并移除
  // （modal 打开时丝带被遮挡、按钮实际不可用；诊断改由 restoreLoop 看门狗自动落盘 diag_rootfail.txt）。

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
      let s = '=== 模型拒翻词记录 (v1.4.13) ' + ts + ' ===\n';
      s += '永久拒翻（连续原样返回达 ' + REFUSE_STRIKES + ' 次）：' + (this._refused ? this._refused.size : 0) + ' 项。\n';
      s += '观察期（已连续原样返回但未达阈值，下次轮询继续重试）：' + (this._refuseCount ? this._refuseCount.size : 0) + ' 项。\n';
      s += '如需强制翻译，告诉 AI 在 NAME_DICT 加一条即可。\n';
      let i = 0;
      if (this._refused && this._refused.size) {
        s += '【永久拒翻】\n';
        this._refused.forEach((w) => {
          const orig = w.indexOf('::') >= 0 ? w.slice(w.indexOf('::') + 2) : w;
          s += (i++) + ': ' + orig + '\n';
        });
      }
      if (this._refuseCount && this._refuseCount.size) {
        s += '【观察期】\n';
        this._refuseCount.forEach((c, w) => {
          const orig = w.indexOf('::') >= 0 ? w.slice(w.indexOf('::') + 2) : w;
          s += (i++) + ': ' + orig + ' (' + c + '/' + REFUSE_STRIKES + ')\n';
        });
      }
      if ((!this._refused || this._refused.size === 0) && (!this._refuseCount || this._refuseCount.size === 0)) s += '（暂无）\n';
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
    let restored = 0;
    let refusedNew = 0;   // v1.4.19：本轮新记入拒翻的技术记号数量
    for (const n of all) {
      const t = (n.nodeValue || '').trim();
      if (!t) continue;
      const ck = this._ckey(t);
      if (this._transCache && this._transCache.has(ck)) {
        const cn = this._transCache.get(ck);
        if (cn && cn !== t) { n.nodeValue = cn; restored++; } // 即时恢复（含预置词条），无需网络
      } else if (this._refused && this._refused.has(ck)) {
        // 模型已确认不愿翻译该词：跳过，避免反复空跑慢速本地模型
      } else if (this._looksLikeNonTranslatable(t)) {
        // 【v1.4.19】技术记号（1 MB / 30% / https://…）首次遇到即记拒翻，不再送模型。
        // 此前它们每轮都被当"新待翻译项"反复送模型（模型原样返回→既不缓存也不拒翻），
        // 形成 `待翻译 12 项 → done=1/12 → 待翻译 11 项` 死循环，界面因此反复闪英文。
        if (this._refused) this._refused.add(ck);
        refusedNew++;
      } else {
        toTranslate.push(n);
      }
    }
    if (refusedNew > 0) {
      void this._flushRefused();
      void this._writeRefused();
      this._logStatus('translateScope: 新记入拒翻技术记号 ' + refusedNew + ' 项（不送模型）');
    }
    const originals = toTranslate.map((n) => n.nodeValue);
    if (!toTranslate.length) {
      // 全部命中缓存：恢复已在上面完成。若本次确实还原了被重绘 / 切 tab 回退的英文（restored>0），
      // 说明发生了视图变化，立即切回快速轮询并保持监控，避免降速到慢档后恢复不及时（最长 15s 会被感知为「变回英文」）。
      if (restored > 0) { this._setFastPoll(); this._idlePolls = 0; }
      if (verbose) new Notice('该设置区域内未检测到可翻译的英文文本。');
      this._logStatus('translateScope: 无可翻译项（缓存已全部命中或无非英文文本），本次即时恢复 ' + restored + ' 项，跳过');
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
            if (this._refuseCount) this._refuseCount.delete(this._ckey(srcText)); // 译出即清零拒翻计数，避免历史误判累积
            if (this._transCache) {
              // 动态文本（日期/文件名/超长）不入缓存，避免挤掉常规设置文案、导致插件更新后常规项被淘汰而重翻
              if (!this._looksDynamic(srcText)) this._transCache.set(this._ckey(srcText), tr);
              this._transCache.set(this._ckey(tr), tr); // 译文自身也入缓存（带语言前缀），已翻译外文文本不再被二次送模型
            }
            done++;
          } else if (!forced) {
            // 未翻译的处理：区分「响应缺失/截断导致该 key 没结果」与「模型明确原样返回」两种情况。
            // 关键修复：在 300s 超时死循环期间，模型常返回截断的残缺 JSON，缺失 key 被误判为「拒翻」并
            // 永久写入 refused.json，导致本可翻译的 UI 文案（如 Vault profile / Add profile...）再也翻不出来。
            // 因此：① 响应里压根没有该 key（tr 为空）→ 不判定为拒翻，留待下次轮询/重开重试；
            //       ② 模型明确原样返回（tr === srcText）→ 仅当文本明显不可译（版本号等）才记拒翻，
            //          其余可译文案不记拒翻，下次重试大概率译出，避免误伤。
            const missing = (tr == null);
            if (!missing && tr === srcText) {
              const ck = this._ckey(srcText);
              if (this._looksLikeNonTranslatable(srcText)) {
                // 版本号等明显不可译：立即永久拒翻，避免反复空跑慢速模型
                if (this._refused) { this._refused.add(ck); void this._flushRefused(); }
                void this._writeRefused();
              } else {
                // 其余（可译 UI 文案）被原样返回：累计计数，达阈值才永久拒翻。
                // 限流/超时/模型偶发抖动导致的「拒翻」会在重试中译出并清零计数，不会被永久屏蔽。
                const c = (this._refuseCount ? (this._refuseCount.get(ck) || 0) : 0) + 1;
                if (this._refuseCount) this._refuseCount.set(ck, c);
                if (c >= REFUSE_STRIKES) {
                  if (this._refused) { this._refused.add(ck); void this._flushRefused(); } // 连续 N 次都翻不出 → 永久拒翻
                  void this._writeRefused();
                } else {
                  // 观察期：仅内存计数，不写 refused.json；下次轮询继续送模型重试
                  void this._writeRefused();
                }
              }
            }
            // 其余（缺失 key：限流/超时/截断）→ 不记拒翻、不计数，保持原英文等待重试
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

  // 流式推理：Obsidian 的 requestUrl 不支持流式响应（只能等完整 resp.text 返回），
  // 故流式必须改用浏览器原生 fetch + ReadableStream 增量读取 SSE。
  // 注意：renderer 下的 fetch 受 CORS 限制，而 requestUrl 走 Electron 主进程不受限；
  // 因此「fetch 不可用 / 响应非 SSE / 未产出有效内容」时由 batchTranslate 回退到 requestUrl 非流式。
  // 返回模型累积的纯文本内容（即本插件需要的翻译映射 JSON 字符串）。
  async _streamChat(body, headers, url) {
    if (typeof fetch !== 'function' || typeof ReadableStream === 'undefined') {
      throw new Error('STREAM_UNSUPPORTED: 当前环境无 fetch，无法流式');
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      let txt = '';
      try { txt = (await resp.text()).slice(0, 200); } catch (e) {}
      throw new Error('HTTP ' + resp.status + (txt ? ' - ' + txt : ''));
    }
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      throw new Error('STREAM_UNSUPPORTED: 响应不支持 ReadableStream');
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let content = '';
    let usage = null;
    let gotData = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          gotData = true;
          try {
            const ev = JSON.parse(data);
            const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
            if (d && typeof d.content === 'string') content += d.content;
            if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
          } catch (e) { /* 心跳 / 注释行忽略 */ }
        }
      }
      const rest = buf.trim();
      if (rest.startsWith('data:')) {
        const data = rest.slice(5).trim();
        if (data && data !== '[DONE]') {
          try {
            const ev = JSON.parse(data);
            const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
            if (d && typeof d.content === 'string') content += d.content;
            if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
          } catch (e) {}
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }
    if (!gotData && !content) throw new Error('STREAM_UNSUPPORTED: 流式响应未返回任何 data 事件（服务可能不支持流式）');
    this._streamUsage = usage;
    return content;
  }

  async batchTranslate(texts) {
    const s = this.settings;
    const baseSize = (typeof s.batchSize === 'number' && s.batchSize >= 1) ? s.batchSize : 25;
    return await this._translateSplit(texts, baseSize, s, 0);
  }

  // 分治翻译：把 texts 拆成 size 子批，逐批请求并合并（结果键按全局索引重映射）。
  // 单子批失败 → 缩小一半递归重试；size 降到 1 仍失败则该条放弃（记录警告，不阻断整批）。
  // 解决「本地小模型对大批量（如 107 项）易返回纯文本无 JSON 或超时」的问题。
  async _translateSplit(texts, size, s, depth) {
    if (!Array.isArray(texts) || texts.length === 0) return {};
    if (size <= 1 || depth >= 6) {
      // 最小单元（单条或已达递归深度上限）：直接请求，失败则该条放弃（不阻断整批）
      try {
        return await this._translateBatchOnce(texts, s);
      } catch (e) {
        console.warn('[llm-settings-translator] 子批翻译失败（放弃该批 ' + texts.length + ' 项）:', e && e.message);
        return {};
      }
    }
    const out = {};
    for (let i = 0; i < texts.length; i += size) {
      const sub = texts.slice(i, i + size);
      let map;
      try {
        map = await this._translateBatchOnce(sub, s);
      } catch (e) {
        // 单子批失败 → 缩小一半递归重试一次（更小的批本地模型更易产出合法 JSON 且在时限内完成）
        try {
          map = await this._translateSplit(sub, Math.max(1, Math.floor(size / 2)), s, depth + 1);
        } catch (e2) {
          map = {};
        }
      }
      if (map && typeof map === 'object') {
        for (const k in map) out[String(i + Number(k))] = map[k];
      }
    }
    return out;
  }

  // 单批请求：流式优先（fetch + SSE），「连接/协议」类失败（含 CORS 拦截的 Failed to fetch）回退非流式
  // requestUrl（Electron 主进程，本地可靠）；「流式超时」不上抛回退（模型慢，回退无济于事，交给上层缩小重试）。
  // 返回键为「本批内局部索引」{ "0": 译文, ... }，由 _translateSplit 重映射为全局索引。
  // 把模型原始响应(raw)解析为「局部索引 → 译文」映射对象。
  // 兼容：① 标准 chat-completion 壳（取 choices[0].message.content 再解析）② 直接就是映射 ③ 数组。
  // 全程用 extractJsonObject 容错剥离「思考前缀 / 代码围栏 / 零散括号」。
  // 返回对象；完全无法解析（如 content 也是纯文本无 JSON）返回 null，供调用方决定重试或缩小子批。
  _decodeModelResponse(raw, texts) {
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = extractJsonObject(raw); }
    if (parsed == null) return null;
    let transMap = parsed;
    // ① chat-completion 壳：模型把译文放在 message.content 里（本地代理常如此封装）
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && Array.isArray(parsed.choices)) {
      const msg = parsed.choices[0] && parsed.choices[0].message;
      if (msg && typeof msg.content === 'string') {
        let cj = null;
        try { cj = JSON.parse(msg.content.trim()); } catch (e) { cj = extractJsonObject(msg.content); }
        if (cj == null) return null; // content 也是纯文本（思考/解释）无 JSON → 上层重试
        transMap = cj;
      }
    }
    if (Array.isArray(transMap)) {
      const out = {};
      transMap.forEach((v, i) => { out[String(i)] = v; });
      return out;
    }
    if (transMap && typeof transMap === 'object' && !Array.isArray(transMap)) {
      const keys = Object.keys(transMap);
      // 安全兜底：若模型把 key 重排成「原文」而非 "0"..，但条数正好等于 texts.length，
      // 按值插入顺序与 texts 对齐（本地模型通常保序），避免整批漏翻。
      if (keys.length > 0 && !keys.every((k) => /^\d+$/.test(k))) {
        const vals = keys.map((k) => transMap[k]);
        if (vals.length === texts.length) {
          const out = {};
          texts.forEach((_, i) => { out[String(i)] = vals[i]; });
          return out;
        }
      }
      return transMap;
    }
    return null;
  }

  async _translateBatchOnce(texts, s, reinforce) {
    const obj = {};
    texts.forEach((t, i) => { obj[String(i)] = t; });
    let sysContent = buildSysPrompt(s.targetLang);
    let userContent = JSON.stringify(obj);
    if (reinforce) {
      // 强化重试：本地推理模型上一轮只吐了思考/解释没给 JSON。 blunt 强制只输出 JSON。
      sysContent += '\n\n上一轮你返回了非 JSON 的纯文本（解释或思考）。本次必须且只能输出 JSON 对象，' +
        '绝不要任何解释、思考、前缀或代码围栏。直接以 { 开头、以 } 结尾。';
      userContent += '\n\n（重要）只回复 JSON 对象，不要思考、不要解释、不要任何额外文字。';
    }
    // 响应预填（forced prefix）：用一条 assistant 消息以 "{" 起头，强制模型从 JSON 起始符续写，
    // 抑制 hy3 等本地小模型的英文「逐条复述 / 思考前缀」，既省 token 又消除前缀占预算致 JSON 截断的风险。
    // 绝大多数 OpenAI 兼容服务（含 opencode2api）支持；若服务返回 400 拒绝预填，则关闭并整批重试一次。
    // 推理强度控制：nemotron-3.5-lightning 等推理模型会在每条翻译前做长篇思考（占 90% token、常致 300s 超时）。
    // 发送 OpenAI 兼容的 reasoning_effort 字段可压低/关闭推理。一旦启用推理控制，预填会与推理协议冲突，故放弃预填。
    const reasoningOn = () => !!s.reasoningEffort && s.reasoningEffort !== 'auto' && !s._reasoningUnsupported;
    const buildMessages = () => {
      const m = [
        { role: 'system', content: sysContent },
        { role: 'user', content: userContent }
      ];
      // 预填仅在「未禁用预填」且「未启用推理控制」时生效（推理模型不支持 assistant 前缀续写）
      if (!s._prefillUnsupported && !reasoningOn()) m.push({ role: 'assistant', content: '{' });
      return m;
    };
    const buildBody = () => {
      const b = {
        model: s.model || 'hy3',
        messages: buildMessages(),
        temperature: 0,
        // 每项译文约 80 token，叠加 2048 余量，封顶 16384（推理关闭后预算可显著降低）
        max_tokens: Math.min(16384, Math.max(4096, texts.length * 80 + 2048)),
        stream: s.stream !== false
      };
      if (reasoningOn()) b.reasoning_effort = s.reasoningEffort;
      return b;
    };
    let body = buildBody();
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (s.apiKey || '')
    };
    const userMs = (s.timeoutSec > 0) ? s.timeoutSec * 1000 : 0;
    // 流式超时自适应：本地模型逐条思考很慢，固定 300s 既易误杀也空等；按条数给更合理上限，
    // 用户显式 timeoutSec 仍为硬上限。
    const streamMs = Math.max(userMs || 60000, texts.length * 3000);
    const nonStreamMs = Math.max(userMs || 20000, texts.length * 600);
    const doRequest = async (reqBody) => {
      // 限流/5xx 重试：免费档/共享端点常返回 429（FreeUsageLimitError）或偶发 5xx，
      // 直接上抛会让整批翻译失败，且在旧版中会被误判为「拒翻」永久写入 refused.json。
      // 这里对 429/5xx 做指数退避重试（最多 4 次：1s→2s→4s→8s），耗尽后才上抛给上层。
      const MAX_RETRY = 4;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        try {
          let raw = '';
          if (reqBody.stream) {
            try {
              this._streamUsage = null;
              raw = await withTimeout(this._streamChat(reqBody, headers, s.endpoint), streamMs, '模型请求(流式)');
            } catch (e) {
              // 仅「流式超时」不回退（模型慢，回退非流式无济于事）；其余连接/协议错误回退非流式
              const isTimeout = !!(e && /超时/.test(e.message));
              if (isTimeout) throw e;
              console.warn('[llm-settings-translator] 流式失败（连接/协议），回退非流式:', e && e.message);
            }
          }
          if (!raw) {
            // 非流式：超时随批大小自适应（大批量不再卡死在固定 15s），从根上缓解「翻译量大就超时」；
            // 用户显式设置 timeoutSec 时作为硬上限，但下限仍随条数走，避免重蹈固定小超时覆辙
            const resp = await withTimeout(requestUrl({
              url: s.endpoint,
              method: 'POST',
              contentType: 'application/json',
              headers,
              body: JSON.stringify(Object.assign({}, reqBody, { stream: false }))
            }), nonStreamMs, '模型请求');
            if (resp.status < 200 || resp.status >= 300) throw new Error('HTTP ' + resp.status);
            raw = resp.text || '';
            this._streamUsage = null;
          }
          return raw;
        } catch (e) {
          const m = (e && e.message && e.message.match(/HTTP (\d+)/));
          const code = m ? m[1] : '';
          const retriable = (code === '429' || /^5\d\d$/.test(code));
          if (retriable && attempt < MAX_RETRY - 1) {
            const wait = Math.min(8000, 1000 * Math.pow(2, attempt));
            this._logStatus('模型限流/暂不可达(HTTP ' + code + ')，' + wait + 'ms 后重试(' + (attempt + 1) + '/' + (MAX_RETRY - 1) + ')');
            await new Promise((r) => setTimeout(r, wait));
            lastErr = e;
            continue;
          }
          throw e;
        }
      }
      throw lastErr || new Error('模型请求重试耗尽');
    };
    // 请求 + 400 优雅回退级联：① 预填被拒 → 关预填重试；② 推理参数被拒 → 关推理重试；否则上抛
    let raw;
    try {
      raw = await doRequest(body);
    } catch (e) {
      const is400 = !!(e && /HTTP 400/.test(e.message));
      if (!is400) throw e;
      if (!s._prefillUnsupported) {
        s._prefillUnsupported = true;          // 先尝试去掉预填（推理模型/不支持前缀的服务）
        body = buildBody();
        try {
          raw = await doRequest(body);
        } catch (e2) {
          if (!(e2 && /HTTP 400/.test(e2.message)) || !reasoningOn()) throw e2;
          s._reasoningUnsupported = true;      // 仍 400 且启用了推理 → 关推理参数重试
          body = buildBody();
          raw = await doRequest(body);
        }
      } else if (reasoningOn()) {
        s._reasoningUnsupported = true;        // 已无预填仍 400 → 关推理参数重试
        body = buildBody();
        raw = await doRequest(body);
      } else {
        throw e;
      }
    }
    // 诊断：把本次请求文本与模型原始响应写入文件，便于排查（仅调试模式）
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
    raw = raw.trim();
    // token 统计：与解析解耦，先单独取 usage（流式在 _streamChat 内已存 _streamUsage）
    let usage = this._streamUsage || null;
    if (!usage) {
      try {
        const p = JSON.parse(raw);
        if (p && p.usage && typeof p.usage === 'object') usage = p.usage;
      } catch (e) {
        const j = extractJsonObject(raw);
        if (j && j.usage) usage = j.usage;
      }
    }
    const map = this._decodeModelResponse(raw, texts);
    if (usage && typeof usage.total_tokens === 'number') {
      this._tokens = this._tokens || { prompt: 0, completion: 0, total: 0, calls: 0 };
      this._tokens.prompt += (usage.prompt_tokens || 0);
      this._tokens.completion += (usage.completion_tokens || 0);
      this._tokens.total += (usage.total_tokens || 0);
      this._tokens.calls += 1;
      this._logStatus('[token] 本次 +' + (usage.total_tokens || 0) + ' / 累计 ' + this._tokens.total + ' (模型调用 ' + this._tokens.calls + ' 次)');
    }
    if (map) return map;
    // 解析失败（模型返回纯文本/思考前缀、无 JSON）：未强化则同一批重试一次（加 blunt 提示），
    // 仍失败再抛出，由 _translateSplit 缩小子批递归（25→12→6…），小批量更易让本地模型产出合法 JSON。
    if (!reinforce) {
      return this._translateBatchOnce(texts, s, true);
    }
    throw new Error('模型未返回可解析的 JSON（纯文本/思考前缀，强化重试仍失败）');
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
      .setName('目标语言 (Language)')
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
      .setName('流式输出 (Stream)')
      .setDesc('默认开启。开启后用 fetch 增量读取 SSE，连接持续保活、翻译量大时不易超时；关闭则走 requestUrl 非流式（超时随批大小自适应）。若端点不支持流式或受 CORS 限制失败，插件会自动回退非流式。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.stream !== false)
        .onChange(async (v) => {
          this.plugin.settings.stream = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('请求超时 (秒)')
      .setDesc('0 = 自适应（流式上限 5 分钟、非流式随批大小，约 20s 起、每条 +0.6s）。填入正数（如 120）则作为流式与非流式两种模式的统一硬上限；建议不要设得过小，否则翻译量大仍会超时。')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.step = '10';
        text.setPlaceholder('0 (自适应)')
          .setValue(String(this.plugin.settings.timeoutSec || 0))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.timeoutSec = (Number.isFinite(n) && n > 0) ? n : 0;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('每批翻译条数')
      .setDesc('单次请求发送给模型的文本条数。本地小模型（如 hy3）对大批量易返回纯文本无 JSON 或超时；超过此值会自动拆分为多个子批逐批翻译，单批失败自动缩小重试。默认 25；模型更强可调大（更少请求、更省 token），更弱可调小（如 10~15）。')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.step = '5';
        text.setPlaceholder('25')
          .setValue(String(this.plugin.settings.batchSize || 25))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.batchSize = (Number.isFinite(n) && n >= 1) ? n : 25;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('推理强度 (Reasoning)')
      .setDesc('仅对推理模型有效（如 nemotron-3.5-lightning）。此类模型会在每条翻译前做长篇思考，占 90% token、常致 300s 超时。选「最少/关闭」可大幅压低或关闭推理、显著加速翻译；插件默认已设为「最少推理 (minimal)」，无需手动改。若你的接口不支持该参数会被 400 拒绝，届时自动关闭并对整批重试一次（翻译仍正常，仅不省推理）。想完全跟随服务默认可改回「不发送」。')
      .addDropdown(dd => dd
        .addOption('auto', '不发送（跟随服务默认）')
        .addOption('low', '轻度推理 (low)')
        .addOption('minimal', '最少推理 (minimal) — 默认')
        .addOption('none', '关闭推理 (none)')
        .setValue(this.plugin.settings.reasoningEffort || 'auto')
        .onChange(async (v) => {
          this.plugin.settings.reasoningEffort = v || 'auto';
          // 切换推理强度时重置「接口不支持」标记，使其重新尝试发送
          this.plugin._reasoningUnsupported = false;
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
