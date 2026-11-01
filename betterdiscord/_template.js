/**
 * @name DiscordTranslator
 * @author 1584776265
 * @version 1.0.0
 * @description 自动翻译 Discord 中的英文与其他语言消息，译文以小字显示在原文下方。支持 Google / OpenAI 兼容（DeepSeek、Ollama、OneAPI）/ LibreTranslate。
 * @source https://github.com/1584776265
 */

/*__MODULES__*/

const DT_PLUGIN_ID = 'DiscordTranslator';

module.exports = class DiscordTranslator {
  constructor(meta) {
    this.meta = meta || {};
    this.settings = null;
    this.started = false;
    this.panelEl = null;
    this.translateBridge = (texts, settings) => DTEngine.translate(texts, settings);
  }

  /* ---------------------------------------------------------------- */

  async loadSettings() {
    this.settings = await DTSettings.load();
    if (!this.settings.targetLang) this.settings.targetLang = 'zh-CN';
    return this.settings;
  }

  saveSettings(patch) {
    this.settings = DTSettings.merge(this.settings || DTSettings.DEFAULTS, patch);
    DTSettings.save(this.settings);
    if (this.started) DTDom.updateSettings(this.settings);
  }

  /* ---------------------------------------------------------------- */

  async start() {
    if (this.started) return;
    await this.loadSettings();

    if (!document.body) {
      await new Promise((r) => setTimeout(r, 800));
    }

    try {
      DTDom.start({
        translate: this.translateBridge,
        getSettings: () => this.settings
      });
      this.started = true;
    } catch (e) {
      this.started = false;
      console.error('[DiscordTranslator] 启动失败', e);
      try {
        BdApi.UI.showToast('翻译启动失败：' + e.message, { type: 'error', timeout: 5000 });
      } catch (_) {
        /* ignore */
      }
      return;
    }

    try {
      BdApi.UI.showToast('Discord 翻译已启动 → ' + (this.settings.targetLang || 'zh-CN'), {
        type: 'success',
        timeout: 2000
      });
    } catch (e) {
      /* ignore */
    }
  }

  stop() {
    if (!this.started) return;
    try {
      DTDom.stop();
    } catch (e) {
      /* ignore */
    }
    this.started = false;
    this.panelEl = null;
  }

  /* ---------------------------------------------------------------- */

  makeSelect(options, value, onChange) {
    const sel = document.createElement('select');
    sel.style.cssText =
      'width:100%;padding:8px 10px;border-radius:6px;background:var(--background-tertiary,#1e1f22);color:var(--text-normal,#dbdee1);border:1px solid var(--background-modifier-accent,#3f4147);font-size:13px;outline:none;';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  fieldLabel(text) {
    const l = document.createElement('div');
    l.textContent = text;
    l.style.cssText =
      'font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--header-secondary,#949ba4);margin-bottom:6px;';
    return l;
  }

  getSettingsPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'padding:18px;display:flex;flex-direction:column;gap:16px;max-width:520px;font-family:var(--font-primary,system-ui);';

    const title = document.createElement('div');
    title.textContent = 'Discord 自动翻译';
    title.style.cssText = 'font-size:18px;font-weight:700;color:var(--header-primary,#fff);';
    wrap.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = '译文会以带「译」标记的小字显示在每条消息下方。修改后立即生效。';
    subtitle.style.cssText = 'font-size:12.5px;color:var(--text-muted,#949ba4);line-height:1.5;';
    wrap.appendChild(subtitle);

    // 开关
    const toggleRow = document.createElement('label');
    toggleRow.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !!this.settings.enabled;
    toggle.style.cssText = 'width:18px;height:18px;accent-color:#5865f2;cursor:pointer;';
    toggle.addEventListener('change', () => this.saveSettings({ enabled: toggle.checked }));
    const toggleText = document.createElement('span');
    toggleText.textContent = '启用自动翻译';
    toggleText.style.cssText = 'font-size:14px;color:var(--text-normal,#dbdee1);';
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(toggleText);
    wrap.appendChild(toggleRow);

    // 目标语言
    const langBlock = document.createElement('div');
    langBlock.appendChild(this.fieldLabel('翻译成'));
    langBlock.appendChild(
      this.makeSelect(
        DTSettings.PRESET_LANGS.map((x) => ({ value: x.code, label: x.label })),
        this.settings.targetLang,
        (v) => this.saveSettings({ targetLang: v })
      )
    );
    wrap.appendChild(langBlock);

    // 服务商
    const provBlock = document.createElement('div');
    provBlock.appendChild(this.fieldLabel('翻译服务'));
    const provSelect = this.makeSelect(
      [
        { value: 'auto', label: '自动（国内直连优先，推荐）' },
        { value: 'tencent', label: '腾讯交互翻译（国内直连）' },
        { value: 'google', label: 'Google 翻译' },
        { value: 'caiyun', label: '彩云小译' },
        { value: 'mymemory', label: 'MyMemory' },
        { value: 'openai', label: 'OpenAI 兼容（DeepSeek / Ollama）' },
        { value: 'libre', label: 'LibreTranslate（自建）' }
      ],
      this.settings.provider,
      (v) => {
        this.saveSettings({ provider: v });
        openaiBlock.style.display = v === 'openai' ? 'flex' : 'none';
        libreBlock.style.display = v === 'libre' ? 'flex' : 'none';
      }
    );
    provBlock.appendChild(provSelect);

    const netHint = document.createElement('div');
    netHint.textContent = '网络通道：' + DTEngine.networkInfo() + '（客户端内需走 BdApi.Net 绕过 CSP）';
    netHint.style.cssText = 'font-size:11px;color:var(--text-muted,#949ba4);margin-top:6px;';
    provBlock.appendChild(netHint);
    wrap.appendChild(provBlock);

    // OpenAI 配置
    const openaiBlock = document.createElement('div');
    openaiBlock.style.cssText =
      'display:' + (this.settings.provider === 'openai' ? 'flex' : 'none') + ';flex-direction:column;gap:10px;';

    const mkInput = (key, placeholder) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.value = this.settings[key] || '';
      i.placeholder = placeholder;
      i.spellcheck = false;
      i.style.cssText =
        'width:100%;padding:8px 10px;border-radius:6px;background:var(--background-tertiary,#1e1f22);color:var(--text-normal,#dbdee1);border:1px solid var(--background-modifier-accent,#3f4147);font-size:13px;outline:none;box-sizing:border-box;';
      i.addEventListener('input', () => this.saveSettings({ [key]: i.value.trim() }));
      return i;
    };

    const baseLbl = document.createElement('div');
    baseLbl.appendChild(this.fieldLabel('API Base'));
    baseLbl.appendChild(mkInput('openaiBase', 'https://api.deepseek.com/v1'));
    openaiBlock.appendChild(baseLbl);

    const keyLbl = document.createElement('div');
    keyLbl.appendChild(this.fieldLabel('API Key'));
    const keyInput = mkInput('openaiKey', 'sk-...');
    keyInput.type = 'password';
    keyLbl.appendChild(keyInput);
    openaiBlock.appendChild(keyLbl);

    const modelLbl = document.createElement('div');
    modelLbl.appendChild(this.fieldLabel('模型'));
    modelLbl.appendChild(mkInput('openaiModel', 'deepseek-chat'));
    openaiBlock.appendChild(modelLbl);

    wrap.appendChild(openaiBlock);

    // LibreTranslate 配置
    const libreBlock = document.createElement('div');
    libreBlock.style.cssText =
      'display:' + (this.settings.provider === 'libre' ? 'flex' : 'none') + ';flex-direction:column;gap:10px;';

    const libreUrlLbl = document.createElement('div');
    libreUrlLbl.appendChild(this.fieldLabel('LibreTranslate 地址'));
    libreUrlLbl.appendChild(mkInput('libreUrl', 'http://127.0.0.1:5000'));
    libreBlock.appendChild(libreUrlLbl);

    const libreKeyLbl = document.createElement('div');
    libreKeyLbl.appendChild(this.fieldLabel('API Key（没有就留空）'));
    libreKeyLbl.appendChild(mkInput('libreKey', ''));
    libreBlock.appendChild(libreKeyLbl);

    wrap.appendChild(libreBlock);

    // 显示模式
    const disBlock = document.createElement('div');
    disBlock.appendChild(this.fieldLabel('显示方式'));
    disBlock.appendChild(
      this.makeSelect(
        [
          { value: 'below', label: '原文下方小字' },
          { value: 'replace', label: '隐藏原文，只显示译文' }
        ],
        this.settings.display,
        (v) => this.saveSettings({ display: v })
      )
    );
    wrap.appendChild(disBlock);

    // 跳过同语言
    const skipRow = document.createElement('label');
    skipRow.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;';
    const skipBox = document.createElement('input');
    skipBox.type = 'checkbox';
    skipBox.checked = this.settings.skipSameLang !== false;
    skipBox.style.cssText = 'width:18px;height:18px;accent-color:#5865f2;cursor:pointer;';
    skipBox.addEventListener('change', () => this.saveSettings({ skipSameLang: skipBox.checked }));
    const skipText = document.createElement('span');
    skipText.textContent = '已经是目标语言的消息不显示译文';
    skipText.style.cssText = 'font-size:14px;color:var(--text-normal,#dbdee1);';
    skipRow.appendChild(skipBox);
    skipRow.appendChild(skipText);
    wrap.appendChild(skipRow);

    // 字号
    const sizeBlock = document.createElement('div');
    sizeBlock.appendChild(this.fieldLabel('译文字号'));
    sizeBlock.appendChild(
      this.makeSelect(
        [12, 13, 14, 15, 16].map((n) => ({ value: String(n), label: n + ' px' })),
        String(this.settings.fontSize || 13),
        (v) => this.saveSettings({ fontSize: parseInt(v, 10) })
      )
    );
    wrap.appendChild(sizeBlock);

    // 操作按钮
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    const mkBtn = (text, onClick, danger) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText =
        'flex:1;padding:9px 12px;border-radius:6px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-accent,#3f4147);background:var(--background-secondary-alt,#2b2d31);color:var(--text-normal,#dbdee1);' +
        (danger ? 'color:#ff9a9c;' : '');
      b.addEventListener('click', onClick);
      return b;
    };

    btnRow.appendChild(
      mkBtn('测试连接', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '测试中…';
        try {
          const r = await DTEngine.test(this.settings);
          BdApi.UI.showToast(r.ok ? '连接正常 · ' + r.ms + 'ms → ' + r.text : '失败：' + r.error, {
            type: r.ok ? 'success' : 'error',
            timeout: 4000
          });
        } catch (err) {
          BdApi.UI.showToast('失败：' + err.message, { type: 'error' });
        } finally {
          btn.disabled = false;
          btn.textContent = '测试连接';
        }
      })
    );

    btnRow.appendChild(
      mkBtn('重新翻译', () => {
        DTDom.retranslateAll();
        BdApi.UI.showToast('已重新翻译当前页面', { type: 'info', timeout: 1500 });
      })
    );

    btnRow.appendChild(
      mkBtn(
        '清空缓存',
        () => {
          DTEngine.clearCache();
          DTSettings.clearCacheStorage();
          DTDom.retranslateAll();
          BdApi.UI.showToast('缓存已清空', { type: 'success', timeout: 1500 });
        },
        true
      )
    );

    wrap.appendChild(btnRow);

    this.panelEl = wrap;
    return wrap;
  }
};
