/*!
 * Discord Translator — DOM 适配层
 * 负责：扫描消息 / 提取文本 / 排队翻译 / 插入译文 / 跟随 Discord 虚拟列表更新
 * 暴露 self.DTDom
 */
(function (root) {
  'use strict';

  const NS = 'dt';

  const SEL = {
    listItem: 'li[id^="chat-messages-"]',
    content: '[id^="message-content-"]',
    replied: '[class*="repliedMessage_"]',
    username: '[class*="username_"]',
    timestamp: 'time[datetime]',
    toolbar: '[class*="messageButtons_"], [class*="buttons_"]'
  };

  const SKIP_TAGS = {
    PRE: 1,
    CODE: 1,
    SCRIPT: 1,
    STYLE: 1,
    VIDEO: 1,
    AUDIO: 1,
    CANVAS: 1,
    SVG: 1,
    BUTTON: 1,
    TEXTAREA: 1
  };

  let bridge = null;
  let settings = {};
  let observer = null;
  let scanTimer = null;
  let running = false;
  let debugMode = false;

  function dbg() {
    if (!debugMode) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift('[DT:dom]');
    console.log.apply(console, args);
  }

  const inFlight = new Set(); // li.id 正在翻译
  const queue = []; // 待翻译项
  const skipped = new Map(); // key -> 原文，记录「确认无需译文」的消息，防止反复重试
  let flushTimer = null;
  let flushing = false;

  function markSkipped(key, srcText) {
    skipped.set(key, srcText);
    if (skipped.size > 1000) {
      const iter = skipped.keys();
      for (let i = 0; i < 500; i++) {
        const next = iter.next();
        if (next.done) break;
        skipped.delete(next.value);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 文本提取                                                            */
  /* ------------------------------------------------------------------ */

  function collect(node, out) {
    if (!node) return;

    if (node.nodeType === 3) {
      out.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName;
    if (tag === 'BR') {
      out.push('\n');
      return;
    }
    if (SKIP_TAGS[tag]) {
      out.push(' ');
      return;
    }
    if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || node.getAttribute('data-name') || '';
      out.push(alt);
      return;
    }
    // Discord 的 spoiler 内容默认遮盖，不主动翻译（避免剧透外泄）
    const cls = node.getAttribute && node.getAttribute('class');
    if (cls) {
      if (cls.indexOf('spoiler') !== -1) {
        out.push(' ');
        return;
      }
      if (cls.indexOf('repliedMessage') !== -1) {
        out.push(' ');
        return;
      }
    }

    for (let i = 0; i < node.childNodes.length; i++) collect(node.childNodes[i], out);
  }

  function extractText(el) {
    const out = [];
    collect(el, out);
    let text = out.join('');
    text = text.replace(/\u00a0/g, ' ');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();
    return text;
  }

  /** 当前所在频道 ID（私信或服务器频道都会返回频道 ID） */
  function currentChannelId() {
    const m = String(location.pathname || '').match(/\/channels\/(?:@me|\d+)\/(\d+)/);
    return m ? m[1] : '';
  }

  /** 消息作者名（Discord 把用户名放在 h3 的第一个 span 里） */
  function getAuthor(li) {
    const h = li.querySelector('h3');
    if (!h) return '';
    const span = h.querySelector('span');
    return span ? String(span.textContent || '').trim() : '';
  }

  function isTranslatable(text) {
    if (!text) return false;
    // 去掉纯符号 / 纯数字
    const stripped = text.replace(/[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
    return stripped.length >= 2;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function buildNode() {
    const wrap = document.createElement('div');
    wrap.className = NS + '-trans';
    const badge = document.createElement('span');
    badge.className = NS + '-badge';
    badge.textContent = '译';
    const text = document.createElement('span');
    text.className = NS + '-text';
    wrap.appendChild(badge);
    wrap.appendChild(text);
    return wrap;
  }

  function render(item, result) {
    const { li, contentEl, key, srcText } = item;
    if (!li.isConnected || !contentEl.isConnected) {
      dbg('render skip (detached)', key, li.isConnected, contentEl && contentEl.isConnected);
      return;
    }

    let node = li.querySelector(':scope > .' + NS + '-trans');
    if (!node) {
      // 可能挂在 contentEl 的父节点下
      node = contentEl.parentElement && contentEl.parentElement.querySelector(':scope > .' + NS + '-trans');
    }
    if (!node) {
      node = buildNode();
      contentEl.insertAdjacentElement('afterend', node);
    }

    node.setAttribute('data-dt-for', key);
    node.setAttribute('data-dt-src', srcText);
    node.setAttribute('data-dt-lang', result.detected || '');
    node.setAttribute('data-dt-target', settings.targetLang || '');
    node.classList.remove(NS + '-trans--error');

    const badge = node.querySelector('.' + NS + '-badge');
    const textEl = node.querySelector('.' + NS + '-text');

    if (badge) {
      const from = result.detected ? root.DTEngine.langName(result.detected) || result.detected : '自动';
      badge.title = from + ' → ' + (root.DTEngine.langName(settings.targetLang) || settings.targetLang);
    }
    if (textEl) textEl.textContent = result.text;

    // replace 模式：隐藏原文
    if (settings.display === 'replace') {
      contentEl.classList.add(NS + '-orig-hidden');
    } else {
      contentEl.classList.remove(NS + '-orig-hidden');
    }
  }

  function restoreOrigins(scope) {
    const root2 = scope || document;
    const hidden = root2.querySelectorAll('.' + NS + '-orig-hidden');
    for (let i = 0; i < hidden.length; i++) hidden[i].classList.remove(NS + '-orig-hidden');
  }

  function removeError(li) {
    if (!li) return;
    const nodes = li.querySelectorAll('.' + NS + '-error');
    for (let i = 0; i < nodes.length; i++) nodes[i].remove();
  }

  function removeNode(li) {
    if (!li) return;
    const nodes = li.querySelectorAll('.' + NS + '-trans');
    for (let i = 0; i < nodes.length; i++) nodes[i].remove();
    removeError(li);
    restoreOrigins(li);
  }

  function shortMsg(s) {
    const t = String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > 56 ? t.slice(0, 56) + '…' : t;
  }

  /**
   * 翻译失败时在消息下方放一个可点击的失败标记。
   * 只显示一行短提示，完整原因放在 title 里，避免弄脏聊天区。
   */
  function renderError(item, message) {
    const { li, contentEl, key, srcText } = item;
    if (!li.isConnected || !contentEl || !contentEl.isConnected) return;

    if (typeof bridge.onError === 'function') {
      try {
        bridge.onError(key, message, srcText);
      } catch (e) {
        /* ignore */
      }
    }

    removeError(li);

    const box = document.createElement('div');
    box.className = NS + '-error';
    box.setAttribute('data-dt-for', key);
    box.setAttribute('data-dt-src', srcText);
    box.title = message;

    const icon = document.createElement('span');
    icon.className = NS + '-error-icon';
    icon.textContent = '!';

    const text = document.createElement('span');
    text.className = NS + '-error-text';
    text.textContent = '翻译失败：' + shortMsg(message);

    const retry = document.createElement('button');
    retry.className = NS + '-retry';
    retry.type = 'button';
    retry.textContent = '重译';
    retry.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeError(li);
      skipped.delete(key);
      enqueue({ li, contentEl, key, srcText });
    });

    box.appendChild(icon);
    box.appendChild(text);
    box.appendChild(retry);

    contentEl.insertAdjacentElement('afterend', box);
  }

  function removeAllNodes() {
    const nodes = document.querySelectorAll('.' + NS + '-trans');
    for (let i = 0; i < nodes.length; i++) nodes[i].remove();
    restoreOrigins(document);
    queue.length = 0;
    inFlight.clear();
    skipped.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 扫描                                                                */
  /* ------------------------------------------------------------------ */

  function getSettingsSnapshot() {
    return settings || {};
  }

  function enqueue(item) {
    queue.push(item);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 120);
    }
  }

  async function flush() {
    if (flushing || !running) return;
    if (queue.length === 0) return;
    flushing = true;

    const batch = queue.splice(0, queue.length);
    const currentSettings = getSettingsSnapshot();

    // 相同文本合并，减少请求
    const groups = new Map();
    for (const item of batch) {
      if (!groups.has(item.srcText)) groups.set(item.srcText, []);
      groups.get(item.srcText).push(item);
      inFlight.add(item.key);
    }

    const texts = Array.from(groups.keys());
    const CHUNK = 24;

    try {
      for (let i = 0; i < texts.length; i += CHUNK) {
        if (!running) break;
        const chunk = texts.slice(i, i + CHUNK);
        let results;
        try {
          results = await bridge.translate(chunk, currentSettings);
        } catch (e) {
          console.warn('[Discord Translator] 翻译失败', e);
          chunk.forEach((t) => groups.get(t).forEach((it) => inFlight.delete(it.key)));
          continue;
        }

        dbg(
          'chunk',
          'len=' + chunk.length,
          'results=' + (results ? results.length : 'null'),
          JSON.stringify(chunk.map((s) => s.slice(0, 14)))
        );

        for (let ci = 0; ci < chunk.length; ci++) {
          // 逐条独立 try/catch：任何一条出错都不能拖累同批其它消息
          try {
            const src = chunk[ci];
            const items = groups.get(src) || [];
            const r = results && results[ci];
            for (const it of items) inFlight.delete(it.key);

            dbg('result', ci, 'ok=' + (r && r.ok), 'src=' + src.slice(0, 26));

            if (!r || !r.ok) {
              const errMsg = (r && r.error) || '翻译失败';
              console.warn('[Discord Translator] ' + errMsg);

              for (const it of items) {
                // 网络抖动之类的一次性失败先静默重试，两次都失败才挂错误标记
                if (!it.retried) {
                  it.retried = true;
                  skipped.delete(it.key);
                  setTimeout(() => {
                    if (running && it.li && it.li.isConnected) enqueue(it);
                  }, 2500);
                } else {
                  renderError(it, errMsg);
                }
              }
              continue;
            }
            if (!r.text) {
              // 空译文，标记为无需翻译，避免反复重试
              for (const it of items) {
                markSkipped(it.key, it.srcText);
                removeNode(it.li);
              }
              continue;
            }

            const same = root.DTEngine.isSameLang(r.detected, currentSettings.targetLang);
            if (same && currentSettings.skipSameLang !== false) {
              for (const it of items) {
                markSkipped(it.key, it.srcText);
                removeNode(it.li);
              }
              continue;
            }

            // 译文与原文一致（例如 "lol"），标记后不再重复请求
            if (r.text.trim() === src.trim()) {
              for (const it of items) {
                markSkipped(it.key, it.srcText);
                removeNode(it.li);
              }
              continue;
            }

            for (const it of items) render(it, r);
          } catch (err) {
            console.warn('[Discord Translator] 单条处理失败', (err && err.message) || err);
          }
        }
      }
    } finally {
      flushing = false;
      if (queue.length > 0 && running) {
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flush();
          }, 200);
        }
      }
    }
  }

  function inspect(li) {
    if (!li || !li.isConnected) return;

    const contents = li.querySelectorAll(SEL.content);
    if (contents.length === 0) {
      removeNode(li);
      return;
    }

    // 取不在"回复预览"里的第一个 message-content
    let contentEl = null;
    for (let i = 0; i < contents.length; i++) {
      const el = contents[i];
      if (el.closest(SEL.replied)) continue;
      contentEl = el;
      break;
    }
    if (!contentEl) return;

    const key = li.id || contentEl.id;
    const srcText = extractText(contentEl);

    // 已经失败过且原文没变：保持失败标记，别反复重试刷接口
    const errExisting = li.querySelector('.' + NS + '-error');
    if (errExisting) {
      if (errExisting.getAttribute('data-dt-src') === srcText) return;
      removeError(li);
    }

    const existing = li.querySelector('.' + NS + '-trans');
    if (existing) {
      const forKey = existing.getAttribute('data-dt-for');
      const oldSrc = existing.getAttribute('data-dt-src');
      const oldTarget = existing.getAttribute('data-dt-target');

      // li 被 React 复用于其它消息
      if (forKey && forKey !== key) {
        removeNode(li);
      } else if (oldTarget && oldTarget !== (settings.targetLang || '')) {
        removeNode(li);
      } else if (oldSrc === srcText) {
        // 已翻译且内容未变
        if (!isTranslatable(srcText) && settings.skipSameLang !== false) {
          // noop
        }
        return;
      } else {
        // 消息被编辑
        removeNode(li);
      }
    }

    if (!settings.enabled) return;
    if (!isTranslatable(srcText)) return;

    // 频道白名单：配了白名单就只翻白名单里的频道
    const whitelist = settings.channelWhitelist;
    if (whitelist && whitelist.length) {
      const ch = currentChannelId();
      if (!ch || whitelist.indexOf(ch) < 0) {
        removeNode(li);
        return;
      }
    }

    // 用户黑名单：作者名命中就不翻
    const blacklist = settings.userBlacklist;
    if (blacklist && blacklist.length) {
      const author = getAuthor(li).toLowerCase();
      if (author) {
        for (let bi = 0; bi < blacklist.length; bi++) {
          const needle = String(blacklist[bi] || '').toLowerCase();
          if (needle && author.indexOf(needle) >= 0) {
            markSkipped(key, srcText);
            removeNode(li);
            return;
          }
        }
      }
    }

    // 已经确认过「无需译文」的消息（同语种 / 译不出东西），不再重复请求
    if (skipped.get(key) === srcText) return;

    // 本地语种预判：已经是目标语言的消息直接跳过，省一次请求
    if (settings.skipSameLang !== false) {
      const detected = root.DTEngine.detectScript(srcText);
      const targetBase = String(settings.targetLang || '').toLowerCase().split('-')[0];
      if (detected && targetBase && detected === targetBase) {
        markSkipped(key, srcText);
        return;
      }
    }

    if (inFlight.has(key)) return;

    const dupe = queue.some((q) => q.key === key);
    if (dupe) return;

    enqueue({ li, contentEl, key, srcText });
  }

  function scanAll() {
    if (!running) return;
    if (!settings.enabled) {
      removeAllNodes();
      return;
    }
    const items = document.querySelectorAll(SEL.listItem);
    for (let i = 0; i < items.length; i++) inspect(items[i]);
    // 消息可能不在 li 里（极少数布局），兜底扫描
    if (items.length === 0) {
      const contents = document.querySelectorAll(SEL.content);
      for (let i = 0; i < contents.length; i++) {
        const li = contents[i].closest('li') || contents[i].parentElement;
        if (li) inspect(li);
      }
    }
  }

  function scheduleScan(delay) {
    if (!running) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAll();
    }, delay || 200);
  }

  /* ------------------------------------------------------------------ */
  /* MutationObserver                                                    */
  /* ------------------------------------------------------------------ */

  function isOurMutation(record) {
    const t = record.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.classList && (t.classList.contains(NS + '-trans') || t.classList.contains(NS + '-text'))) return true;
    return false;
  }

  function onMutations(records) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (isOurMutation(r)) continue;
      if (r.type === 'characterData') {
        scheduleScan(260);
        return;
      }
      if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) {
        scheduleScan(160);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  function start(options) {
    if (running) return;
    bridge = options;
    settings = options.getSettings() || {};
    running = true;
    document.addEventListener('keydown', onComposerKeyDown, true);

    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // 首次与后续补扫
    scheduleScan(300);
    const t1 = setTimeout(scanAll, 1500);
    const t2 = setTimeout(scanAll, 4000);

    // 滚动时补扫
    window.addEventListener('scroll', onScroll, true);

    if (root.DTEngine) {
      // 预热：把已渲染消息先翻一遍
      scheduleScan(800);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }

  let scrollTimer = null;
  function onScroll() {
    if (!running) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scanAll();
    }, 180);
  }

  function stop() {
    running = false;
    if (observer) observer.disconnect();
    observer = null;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    window.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('keydown', onComposerKeyDown, true);
    const toast = document.getElementById(NS + '-toast');
    if (toast) toast.remove();
    removeAllNodes();
  }

  function updateSettings(next) {
    const prev = settings || {};
    settings = next || {};

    const targetChanged = prev.targetLang !== settings.targetLang;
    const providerChanged = prev.provider !== settings.provider;
    const displayChanged = prev.display !== settings.display;

    if (targetChanged || providerChanged) {
      removeAllNodes();
    }

    if (displayChanged && settings.display !== 'replace') {
      restoreOrigins(document);
    }

    if (!settings.enabled) {
      removeAllNodes();
      return;
    }

    scheduleScan(60);
  }

  function retranslateAll() {
    removeAllNodes();
    scanAll();
  }

  function stats() {
    return {
      rendered: document.querySelectorAll('.' + NS + '-trans').length,
      queued: queue.length,
      inFlight: inFlight.size,
      queuedKeys: queue.map((q) => q.key),
      inFlightKeys: Array.from(inFlight),
      running
    };
  }

  /* ---------------------------------------------------------------- */
  /* 发送前翻译（Alt+Enter）                                            */
  /* ---------------------------------------------------------------- */

  let toastTimer = null;

  function notifyUser(msg) {
    let el = document.getElementById(NS + '-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = NS + '-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function getComposer() {
    return document.querySelector('[role="textbox"][contenteditable="true"]');
  }

  function composerText(el) {
    // Discord 的 Slate 编辑器首字符是个零宽 BOM，要剥掉
    return String(el.textContent || '')
      .replace(/^\uFEFF/, '')
      .trim();
  }

  function selectComposer(editor) {
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 替换输入框内容。
   *
   * 实测结论（Discord 1.0.9266 / Slate）：
   *   - beforeinput 事件会被 Slate 拦下但什么都不插入（无效）
   *   - paste 事件能触发 Slate 的粘贴逻辑，但在"完全空"的编辑器上偶尔不生效
   *   - execCommand('insertText') 最稳，插入和替换都成功，且会触发 input 事件同步 React 状态
   * 所以主用 execCommand，失败再用 paste 兜底。
   */
  async function replaceComposer(editor, text, oldText) {
    selectComposer(editor);

    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (e) {
      ok = false;
    }
    await wait(140);

    const after = composerText(editor);
    // 必须确认内容"变了"，否则后台文档上 execCommand 会静默失败还返回 true
    if (ok && after && after !== oldText) return true;

    // 兜底：paste
    selectComposer(editor);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      })
    );
    await wait(140);

    const after2 = composerText(editor);
    return !!after2 && after2 !== oldText;
  }

  function sendComposer(editor) {
    const btn = document.querySelector('button[aria-label*="Send"], button[aria-label*="发送"]');
    if (btn) {
      btn.click();
      return;
    }
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      })
    );
  }

  async function translateComposer() {
    const editor = getComposer();
    if (!editor) {
      notifyUser('没找到输入框');
      return;
    }

    const text = composerText(editor);
    if (!text) {
      notifyUser('输入框是空的');
      return;
    }

    const target = settings.outgoingLang || 'en';
    const langName = root.DTEngine.langName(target) || target;

    const detected = root.DTEngine.detectScript(text);
    if (detected && detected === String(target).toLowerCase().split('-')[0]) {
      notifyUser('已经是' + langName + '了');
      return;
    }

    notifyUser('翻译中…');

    let result;
    try {
      const out = await bridge.translate([text], Object.assign({}, settings, {
        targetLang: target,
        skipSameLang: true
      }));
      result = out && out[0];
    } catch (e) {
      notifyUser('翻译失败：' + ((e && e.message) || e));
      return;
    }

    // 翻译期间用户可能又改了内容，别把新写的冲掉
    const now = getComposer();
    if (!now || composerText(now) !== text) {
      notifyUser('输入内容已变化，已取消');
      return;
    }

    if (!result || !result.ok || !result.text) {
      notifyUser('翻译失败：' + ((result && result.error) || '无结果'));
      return;
    }

    const written = await replaceComposer(now, result.text, text);
    if (!written) {
      notifyUser('写入输入框失败：请确认 Discord 窗口是激活状态');
      return;
    }

    if (settings.composerAutoSend) {
      setTimeout(() => {
        const again = getComposer();
        if (again && composerText(again)) sendComposer(again);
      }, 240);
      notifyUser('已翻译并发送');
    } else {
      notifyUser('已翻译成' + langName + '，检查后按 Enter 发送');
    }
  }

  function onComposerKeyDown(e) {
    if (!settings.composerTranslate) return;
    if (!e.altKey || e.key !== 'Enter') return;

    const t = e.target;
    if (!t || !t.closest || !t.closest('[role="textbox"]')) return;

    e.preventDefault();
    e.stopPropagation();
    translateComposer();
  }

  const api = {
    start,
    stop,
    updateSettings,
    retranslateAll,
    scanAll: () => scanAll(),
    stats,
    extractText,
    isTranslatable,
    translateComposer,
    setDebug: (v) => {
      debugMode = !!v;
    },
    SEL
  };

  root.DTDom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
