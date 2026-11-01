(async function () {
  var invoke = window.__TAURI__.core.invoke;
  var out = {};

  out.before = await invoke('shortcut_info');

  try {
    out.takeover = await invoke('takeover_shortcut');
  } catch (e) {
    out.takeover = 'ERR ' + e;
  }

  out.after = await invoke('shortcut_info');

  try {
    out.restore = await invoke('restore_shortcut');
  } catch (e) {
    out.restore = 'ERR ' + e;
  }

  out.final = await invoke('shortcut_info');

  return JSON.stringify(out, null, 2);
})()
