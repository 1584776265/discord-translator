(async function () {
  var invoke = window.__TAURI__.core.invoke;
  var out = {};

  // 1. 进程检测（现在是 Win32 snapshot，不再走 tasklist）
  out.status = await invoke('discord_status');

  // 2. 快捷方式读写（现在是 COM IShellLinkW，不再走 PowerShell）
  out.scBefore = await invoke('shortcut_info');
  try {
    out.scTakeover = await invoke('takeover_shortcut');
    out.scAfter = await invoke('shortcut_info');
    out.scRestore = await invoke('restore_shortcut');
    out.scFinal = await invoke('shortcut_info');
  } catch (e) {
    out.scError = String(e);
  }

  // 3. 翻译链路
  out.translate = await window.DTEngine.test({
    provider: 'auto',
    targetLang: 'zh-CN',
    sourceLang: 'auto'
  });

  // 4. 缓存
  out.cache = await invoke('cache_stats');

  return JSON.stringify(out, null, 2);
})()
