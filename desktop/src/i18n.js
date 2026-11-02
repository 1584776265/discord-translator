/**
 * 桌面版双语支持。
 *
 * 设计取舍：**中文是原文，英文是译文**。代码里照常写中文，需要英文时用 t() 查表：
 *   - 好处：中文行为与老版本逐字一致，不会因为重构 UI 文案而改错；只需要维护一份英文
 *   - 坏处：英文文案要靠 key 精确匹配，所以动态拼接的句子必须先转成带 {占位符} 的模板
 *
 * 静态 HTML 不用加任何属性：applyStatic() 会遍历一次文本节点，按 trim 后的整句匹配。
 */
(function () {
  'use strict';

  const EN = {
    /* ---- 顶部与状态 ---- */
    'Discord 自动翻译': 'Discord Auto Translate',
    译: 'T',
    '正在检查环境…': 'Checking environment…',
    '开启 / 暂停翻译': 'Start / pause translation',
    未连接: 'Not connected',
    已翻译: 'Translated',
    当前消息: 'Messages',
    今日请求: 'Requests today',
    翻译源: 'Provider',
    自动: 'Auto',
    腾讯: 'Tencent',
    彩云: 'Caiyun',
    大模型: 'LLM',
    '连接 Discord': 'Connect Discord',
    重新连接: 'Reconnect',
    重新翻译: 'Retranslate',
    已连接: 'Connected',
    翻译已开启: 'Translation on',
    翻译已暂停: 'Translation paused',
    '译文会显示在每条消息下方。关闭窗口后仍在托盘运行。':
      'Translations appear under each message. Closing the window keeps it running in the tray.',

    /* ---- 翻译设置 ---- */
    翻译设置: 'Translation',
    翻译成: 'Translate into',
    翻译服务: 'Provider',
    '自动（国内直连优先）': 'Auto (direct-first)',
    '腾讯交互翻译': 'Tencent',
    'Google 翻译': 'Google Translate',
    '彩云小译': 'Caiyun',
    'OpenAI 兼容（DeepSeek / Ollama）': 'OpenAI-compatible (DeepSeek / Ollama)',
    'LibreTranslate（自建）': 'LibreTranslate (self-hosted)',
    显示方式: 'Display',
    '原文下方小字': 'Small text below the original',
    隐藏原文: 'Hide the original',
    译文字号: 'Translation size',
    '已经是目标语言的消息不显示译文': 'Skip messages already in the target language',
    '每日请求上限（0 = 不限）': 'Daily request limit (0 = unlimited)',
    'MyMemory 邮箱（可选，填了额度提升约 10 倍）':
      'MyMemory email (optional, raises quota ~10×)',
    模型: 'Model',
    简体中文: 'Simplified Chinese',
    繁体中文: 'Traditional Chinese',
    英语: 'English',
    日语: 'Japanese',
    韩语: 'Korean',
    俄语: 'Russian',
    法语: 'French',
    德语: 'German',
    西班牙语: 'Spanish',

    /* ---- 当前频道 ---- */
    当前频道: 'Current channel',
    未在频道内: 'Not in a channel',
    '打开一个文字频道后可以把它单独加入白名单。':
      'Open a text channel to whitelist it on its own.',
    '只翻译这个频道': 'Only this channel',
    加入白名单: 'Add to whitelist',
    移出白名单: 'Remove from whitelist',
    '白名单为空，当前所有频道都会翻译。':
      'Whitelist is empty — every channel is translated.',
    '已在白名单中（共 {n} 个频道）。': 'Already whitelisted ({n} channels in total).',
    '当前频道不在白名单里，这个频道不会翻译（共 {n} 个频道在白名单）。':
      'This channel is not whitelisted, so it will not be translated ({n} channels are).',
    '现在只翻译「{name}」。': 'Now translating "{name}" only.',
    '已加入白名单，共 {n} 个频道。': 'Added to the whitelist, {n} channels in total.',
    '已移出白名单，剩 {n} 个。': 'Removed from the whitelist, {n} left.',
    私信: 'Direct message',
    频道: 'Channel',

    /* ---- 本地引擎 ---- */
    本地翻译引擎: 'Local engine',
    '让翻译完全跑在自己机器上：不联网、不花钱、没有额度限制。需要 Docker（约 600MB，镜像约 1GB）。没有 Docker 也可以直接用 Ollama 接大模型。':
      'Run translation entirely on your own machine: no network, no cost, no quotas. LibreTranslate needs Docker (~600 MB, image ~1 GB); without Docker you can use Ollama instead.',
    检测中: 'Detecting…',
    '检测中…': 'Detecting…',
    未运行: 'Not running',
    运行中: 'Running',
    已停止: 'Stopped',
    不可用: 'Unavailable',
    '已安装 · 运行中': 'Installed · running',
    '已安装 · 未启动': 'Installed · stopped',
    '运行中（127.0.0.1:5000）': 'Running (127.0.0.1:5000)',
    '运行中（127.0.0.1:11434）': 'Running (127.0.0.1:11434)',
    '部署 LibreTranslate': 'Deploy LibreTranslate',
    '部署 Ollama': 'Deploy Ollama',
    卸载: 'Uninstall',
    卸载模型: 'Remove model',
    重新检测: 'Re-check',
    '已部署（重新部署）': 'Deployed (redeploy)',
    'Docker 未运行': 'Docker not running',
    'Docker Desktop 没有运行，读不到容器状态。启动 Docker 后这里会显示已装的语言包。':
      'Docker Desktop is not running, so the container cannot be inspected. Start Docker to see installed language packs.',
    未部署: 'Not deployed',
    '还没有部署。点下面的按钮会自动拉镜像、起容器并填好地址。':
      'Not deployed yet. The button below pulls the image, starts the container and fills in the address.',
    未安装: 'Not installed',
    '还没有安装。点下面的按钮会用 winget 自动安装并下载 qwen2.5:3b（约 2GB）。':
      'Not installed yet. The button below installs Ollama via winget and pulls qwen2.5:3b (~2 GB).',
    无模型: 'No models',
    'Ollama 已安装，但没有已下载的模型。点下面的按钮下载 qwen2.5:3b（约 2GB）。':
      'Ollama is installed but has no models. The button below downloads qwen2.5:3b (~2 GB).',
    '读取失败': 'Read failed',
    未知: 'Unknown',
    '{n} 个语言包（{langs}）': '{n} language packs ({langs})',
    ' · 镜像 {size}': ' · image {size}',
    '已装模型：{list}': 'Installed models: {list}',

    /* ---- 外观与版本 ---- */
    外观与版本: 'Appearance & version',
    界面主题: 'Theme',
    跟随系统: 'Follow system',
    深色: 'Dark',
    浅色: 'Light',
    'Discord 版本': 'Discord channel',
    稳定版: 'Stable',
    界面语言: 'Language',
    '自动（跟随系统）': 'Auto (follow system)',
    中文: 'Chinese',
    当前版本: 'Current version',
    检查更新: 'Check for updates',
    正在检查更新: 'Checking for updates…',
    '已是最新版本': 'You are on the latest version',
    '有新版本 {v}': 'Version {v} is available',
    下载并安装: 'Download & install',
    正在下载并校验: 'Downloading and verifying',
    '打开下载页': 'Open download page',
    跳过: 'Later',
    '启动时自动检查更新': 'Check for updates on startup',
    '更新用代理（留空 = 用系统代理，填 direct 直连）':
      'Update proxy (empty = system proxy, "direct" = no proxy)',
    发布说明: 'Release notes',

    /* ---- 划词翻译 / 发送前翻译 ---- */
    划词翻译: 'Selection translate',
    '在消息里选中一段文字，旁边会冒出一个「译」按钮，点它单独翻这段，不影响整条消息的译文。':
      'Select some text in a message and a small button appears next to it; it translates just that fragment.',
    '选中消息文字时显示「译」按钮': 'Show the translate button when text is selected',
    发送前翻译: 'Translate before sending',
    '在 Discord 输入框里按': 'Press',
    '，把你要说的话翻成目标语言并替换输入框内容，不会自动发出去（除非你打开下面的开关）。':
      'in the Discord composer to translate your draft into the target language. It will not send unless you enable the switch below.',
    '启用 Alt + Enter 翻译输入框': 'Enable Alt + Enter to translate the composer',
    '翻译后直接发送（不再确认）': 'Send right after translating (no confirmation)',
    翻成: 'Translate into',

    /* ---- Discord 图标 ---- */
    'Discord 图标': 'Discord icon',
    已接管: 'Hooked',
    未接管: 'Not hooked',
    '已接管：点 Discord 图标会经本程序启动':
      'Hooked: the Discord shortcut starts through this app',
    '未接管：点 Discord 图标启动的客户端无法翻译':
      'Not hooked: Discord started from its icon cannot be translated',
    接管: 'Hook shortcut',
    还原: 'Restore',
    '读取快捷方式失败：': 'Failed to read shortcuts: ',

    /* ---- 术语表 ---- */
    术语表: 'Glossary',
    '每行一条': 'One entry per line',
    推荐术语: 'Suggested terms',
    加载推荐术语: 'Load suggested terms',
    导入: 'Import',
    导出: 'Export',
    清除缓存: 'Clear cache',
    日志: 'Logs',
    '打开数据目录': 'Open data folder',

    /* ---- 提示与错误 ---- */
    'CDP 未连接': 'CDP not connected',
    '无结果': 'No result',
    '已有连接流程进行中，忽略本次请求': 'A connection attempt is already running',
    '未安装 Discord': 'Discord not installed',
    '请先安装 Discord 桌面版。': 'Please install the Discord desktop app first.',
    'Discord 未开启调试端口': 'Discord is running without a debug port',
    'Discord 未运行': 'Discord is not running',
    'Discord 正在运行但未开启翻译所需的调试端口。点上面按钮会重启 Discord——当前语音通话会中断，未发送的草稿会丢失。':
      'Discord is running but without the debug port this app needs. The button above restarts Discord — current voice calls drop and unsent drafts are lost.',
    'Discord 没有运行。点击按钮会启动它并开启调试端口。':
      'Discord is not running. The button starts it with the debug port enabled.',
    '重启 Discord 并连接': 'Restart Discord & connect',
    '启动 Discord 并连接': 'Start Discord & connect',
    '正在启动 Discord…': 'Starting Discord…',
    '首次启动约需 10–20 秒': 'The first launch takes 10–20 seconds',
    '正在连接…': 'Connecting…',
    '开始启动 Discord（会先关闭现有进程）':
      'Starting Discord (existing processes are closed first)',
    '等待 Discord 页面…': 'Waiting for the Discord page…',
    '正在加载聊天界面': 'Loading the chat UI',
    连接失败: 'Connection failed',
    'Discord 页面未就绪': 'The Discord page is not ready',
    'Discord 可能还在加载，稍等几秒再点一次。':
      'Discord may still be loading — try again in a few seconds.',
    '等待 Discord 页面超时': 'Timed out waiting for the Discord page',
    '握手被拒，重启 Discord 以开启调试权限':
      'Handshake refused — restart Discord to enable debugging',
    '正在重启 Discord…': 'Restarting Discord…',
    '需要重新授权调试连接': 'Debug connection needs to be re-authorized',
    '连接出错：': 'Connection error: ',
    '连接失败: ': 'Connection failed: ',
    'WebSocket 连接超时': 'WebSocket connection timed out',
    '注入失败': 'Injection failed',
    '注入失败: ': 'Injection failed: ',
    '已注入到 Discord: ': 'Injected into Discord: ',
    '检测到 Discord 页面重载，2 秒后重新注入':
      'Discord page reloaded — re-injecting in 2 seconds',
    重新注入完成: 'Re-injection complete',
    '重新注入失败: ': 'Re-injection failed: ',
    连接已断开: 'Connection lost',
    '正在尝试重连…': 'Reconnecting…',
    'CDP 连接已断开': 'CDP connection closed',
    '调试端口拒绝了本程序的连接。Discord 必须由本程序启动（需要 --remote-allow-origins），请点【重启 Discord 并连接】':
      'The debug port refused this app. Discord must be started by this app (it needs --remote-allow-origins); click “Restart Discord & connect”.',
    '自动重连：调试端口在线，尝试连接':
      'Auto-reconnect: debug port is up, connecting',
    翻译已恢复: 'Translation resumed',
    '已重新连接到 Discord。': 'Reconnected to Discord.',
    需要重新连接: 'Reconnect needed',
    'Discord 重启后未开启调试端口': 'Discord restarted without the debug port',
    'Discord 重新启动了，但没有调试端口。点【重启 Discord 并连接】恢复（语音会断）。':
      'Discord restarted without the debug port. Click “Restart Discord & connect” to recover (voice will drop).',
    'Discord 重启了，翻译已断开': 'Discord restarted — translation stopped',
    'Discord 重启后没有开启调试端口。打开本程序点【重启 Discord 并连接】即可恢复。':
      'Discord restarted without the debug port. Open this app and click “Restart Discord & connect”.',
    'Discord 重启且无调试端口，停止自动重连':
      'Discord restarted without a debug port — auto-reconnect stopped',
    等待: 'Waiting',
    '注入已丢失（页面路由切换），正在重新注入':
      'Injection lost (route change) — re-injecting',
    '还没有连接到 Discord。': 'Not connected to Discord yet.',
    '已重新翻译当前页面。': 'Retranslated the current page.',
    '重新翻译失败：': 'Retranslate failed: ',
    '缓存已清空（内存 + 数据库）。': 'Cache cleared (memory + database).',
    '白名单设为当前频道: ': 'Whitelist set to the current channel: ',
    '白名单已清空，所有频道都会翻译。':
      'Whitelist cleared — every channel is translated.',
    检测到: 'Detected',
    'Discord 已就绪': 'Discord is ready',
    'Discord 正在运行': 'Discord is running',
    '但未开启调试端口': 'but has no debug port',
    '需要重启 Discord 才能连接': 'Discord must be restarted to connect',
    'Discord 已在运行但没开调试端口。点【重启 Discord 并连接】——语音会断，草稿会丢。':
      'Discord is running without a debug port. Click “Restart Discord & connect” — voice drops and drafts are lost.',
    '已最小化到托盘': 'Minimized to tray',
    '翻译仍在后台运行。右键托盘图标可以退出。':
      'Translation keeps running in the background. Right-click the tray icon to quit.',
    '首次关闭窗口，已提示最小化到托盘':
      'First time closing the window — minimized to tray',
    '退出前已清理页面上的译文': 'Cleaned up injected translations before exit',
    初始化失败: 'Initialization failed',
    '加载资源失败: ': 'Failed to load resources: ',
    '读取配置失败: ': 'Failed to read the config: ',
    '保存配置失败：': 'Failed to save the config: ',
    '清理失败：': 'Cleanup failed: ',
    '测试中…': 'Testing…',
    '测试失败：': 'Test failed: ',
    无返回: 'No response',
    测试翻译源: 'Test provider',
    检测失败: 'Detection failed',
    '检测失败：': 'Detection failed: ',
    '检测本地引擎失败: ': 'Local engine detection failed: ',

    /* ---- 本地引擎部署 ---- */
    '正在准备部署 Ollama…': 'Preparing the Ollama deployment…',
    '正在准备部署…': 'Preparing the deployment…',
    '部署启动失败：': 'Failed to start the deployment: ',
    '部署未完成：': 'Deployment incomplete: ',
    '本地引擎已就绪。': 'Local engine is ready.',
    '已自动切到本地大模型（Ollama · qwen2.5:3b），完全不联网。':
      'Switched to the local model (Ollama · qwen2.5:3b) — fully offline.',
    '已自动切到 LibreTranslate（http://127.0.0.1:5000）。':
      'Switched to LibreTranslate (http://127.0.0.1:5000).',
    '本地引擎部署: ': 'Local engine deployment: ',

    /* ---- 卸载 ---- */
    '卸载 LibreTranslate？\n\n': 'Uninstall LibreTranslate?\n\n',
    '会删除容器和镜像（约 1GB 磁盘）。\n':
      'This deletes the container and image (~1 GB of disk).\n',
    'Docker Desktop 本体不会被卸载，其他容器也不受影响。':
      'Docker Desktop itself stays installed and other containers are untouched.',
    '正在卸载 LibreTranslate…': 'Uninstalling LibreTranslate…',
    '卸载失败：': 'Uninstall failed: ',
    '卸载 LibreTranslate 失败: ': 'Failed to uninstall LibreTranslate: ',
    '读取 Ollama 信息失败：': 'Failed to read Ollama info: ',
    '没有可删除的 Ollama 模型。': 'No Ollama models to remove.',
    '删除模型 {name}（{size}）？\n\n': 'Remove model {name} ({size})?\n\n',
    '只删除模型文件，Ollama 程序本身保留。\n':
      'Only the model files are deleted; Ollama itself stays installed.\n',
    '删掉后【部署 Ollama】需要重新下载约 2GB。':
      'You will need to download ~2 GB again via “Deploy Ollama”.',
    '正在删除模型…': 'Removing the model…',
    '。当前翻译源已切回「自动」。': '. The provider was switched back to Auto.',
    '删除失败：': 'Removal failed: ',

    /* ---- 术语表 / 导入导出 / 快捷方式 ---- */
    '推荐术语已经全部存在了。': 'All suggested terms are already present.',
    导入术语表: 'Import glossary',
    导出术语表: 'Export glossary',
    文本文件: 'Text file',
    '导入失败：': 'Import failed: ',
    '导出失败：': 'Export failed: ',
    '接管失败：': 'Failed to hook shortcuts: ',
    '接管快捷方式失败: ': 'Failed to hook the shortcuts: ',
    '还原失败：': 'Restore failed: ',
    '读取 {name} 失败': 'Failed to read {name}',
    '已接管 {n} 个快捷方式，现在点 Discord 图标即可带翻译启动。':
      'Hooked {n} shortcuts — the Discord icon now starts with translation.',
    '接管快捷方式 {n} 个': 'Hooked {n} shortcuts',
    '已还原 {n} 个快捷方式。': 'Restored {n} shortcuts.',
    '还原快捷方式 {n} 个': 'Restored {n} shortcuts',
    'Discord 渠道切换为 ': 'Switched Discord channel to ',

    /* ---- 术语表占位符告警 ---- */
    '{n} 个术语占位符被当前翻译引擎改写，术语表未生效。':
      '{n} glossary placeholders were rewritten by the provider — the glossary did not apply.',
    '本地小模型（LibreTranslate）对术语表支持有限，建议改用腾讯 / DeepSeek / Ollama。':
      'LibreTranslate has limited glossary support; Tencent / DeepSeek / Ollama work better.',
    '当前翻译引擎不支持术语占位符，术语表未生效。建议换腾讯 / DeepSeek / Ollama。':
      'This provider does not support glossary placeholders. Try Tencent / DeepSeek / Ollama.',
    '{n} 条翻译失败: ': '{n} translations failed: ',
    '已达每日请求上限（{n}）': 'Daily request limit reached ({n})',
    '回填失败: ': 'Write-back failed: ',
    '已有连接流程进行中': 'A connection attempt is already running',
    'Discord 就绪：端口 {port}，方式 {mode}，耗时 {ms}ms':
      'Discord ready: port {port}, mode {mode}, {ms}ms',
    '已清理 7 天前的缓存，剩余 {n} 条。': 'Cleared caches older than 7 days, {n} entries left.',
    '已添加 {n} 条推荐术语（共 {total} 条），对本地小模型效果最明显。':
      'Added {n} suggested terms ({total} in total) — biggest win with small local models.',
    '加载推荐术语表，新增 {n} 条': 'Load suggested terms, {n} added',
    '已导入 {n} 条术语。': 'Imported {n} glossary entries.',
    '已导出 {n} 条术语。': 'Exported {n} glossary entries.',
    '翻译源正常 · [{provider}] {ms}ms → {text}': 'Provider OK · [{provider}] {ms}ms → {text}',
    '测试翻译源: {text}': 'Test provider: {text}',
    ' 条': ' entries',
    '{n} 个语言包': '{n} language packs',
    '不支持': 'Unsupported',

    /* ---- 自动更新（新增） ---- */
    发现新版本: 'Update available',
    '正在检查…': 'Checking…',
    '检查失败：': 'Check failed: ',
    '下载中…': 'Downloading…',
    '正在下载更新…': 'Downloading the update…',
    '更新已开始，程序即将重启': 'Update started — the app will restart',
    '便携版不自动安装': 'Portable build does not auto-install',
    '便携版请到发布页手动下载新版。': 'Please download the new version manually.',
    '稍后提醒': 'Remind me later',
    更新设置: 'Update settings',
    '安装版：下载校验后静默升级，配置与术语表自动保留。':
      'Installed build: verified silent upgrade; settings and glossary are preserved.',
    '便携版：只提示新版本，需要手动替换 exe。':
      'Portable build: only notifies you; replace the exe manually.',
    '通过代理 {proxy} 访问 GitHub': 'Using proxy {proxy} for GitHub',
    '直连 GitHub': 'Direct connection to GitHub',
    安装版: 'Installed build',
    便携版: 'Portable build',
    '安装版：下载校验后静默升级，配置与术语表自动保留。':
      'Installed build: verified silent upgrade; settings and glossary are preserved.',
    '便携版：只提示新版本，需要手动替换 exe。':
      'Portable build: only notifies you; replace the exe manually.',
    '检查失败：': 'Check failed: ',
    '更新失败：': 'Update failed: ',

    /* ---- app.js 动态文案补充 ---- */
    '频道 {name}': 'Channel {name}',
    '已切换为 {label}，重新连接后生效。': 'Switched to {label}; reconnect to apply.',
    '{bad}/{total} 条翻译失败: {err}': '{bad}/{total} translations failed: {err}',

    /* ---- HTML 静态文案补充 ---- */
    '检查中…': 'Checking…',
    '接管 Discord 图标': 'Hook Discord icon',
    '还原为原版': 'Restore original',
    '范围与术语': 'Scope & glossary',
    '频道白名单（留空 = 全部翻译）': 'Channel whitelist (empty = translate everything)',
    '忽略这些用户（每行一个用户名或 ID）': 'Ignore these users (one name or ID per line)',
    诊断: 'Diagnostics',
    调试端口: 'Debug port',
    'CDP 会话': 'CDP session',
    网络通道: 'Network channel',
    页面地址: 'Page URL',
    缓存条数: 'Cached entries',
    配置路径: 'Config path',
    清空缓存: 'Clear cache',
    '清理 7 天前': 'Prune older than 7 days',
    '打开数据目录': 'Open data folder',
    '开机自动启动': 'Start with Windows',
    版本更新: 'Updates',
    '当前版本 -': 'Current version -'
  };

  /**
   * 整段 HTML 的译文（段落里夹了 <code>/<b> 的，按节点逐句匹配会碎掉）。
   * 用法：在元素上加 data-i18n="键名"，切换语言时直接替换 innerHTML。
   */
  const EN_HTML = {
    'note.localEngine':
      'Run translation entirely on your own machine: no network, no cost, no quotas. LibreTranslate needs Docker (~600 MB, image ~1 GB). Without Docker you can use Ollama instead.',
    'note.composer':
      'Press <code>Alt + Enter</code> in the Discord composer to translate your draft into the target language. It will not send unless you enable the switch below.',
    'note.discordIcon':
      'Discord started straight from its own icon has <b>no</b> debug port, so translation will not work. Once hooked, the shortcut launches Discord through this app and translation works as usual.',
    'note.glossary':
      'The glossary works by keeping placeholders untouched: <b>Tencent / DeepSeek / Ollama</b> handle this well, while offline models like LibreTranslate may rewrite them (you will be warned when that happens).',
    'label.glossary': 'Glossary (one <code>source=target</code> per line)',
    'label.whitelist': 'Channel whitelist (empty = translate everything)',
    'label.blacklist': 'Ignore these users (one name or ID per line)'
  };

  let lang = 'zh';

  function normalizeLang(v) {
    return String(v || '').toLowerCase() === 'en' ? 'en' : 'zh';
  }

  function setLang(v) {
    lang = normalizeLang(v);
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    document.documentElement.setAttribute('data-lang', lang);

    // <title> 不在 body 里，得单独处理
    const title = document.querySelector('title');
    if (title) {
      const zh = title.getAttribute('data-zh') || title.textContent.trim();
      title.setAttribute('data-zh', zh);
      title.textContent = lang === 'en' ? EN[zh] || zh : zh;
    }
  }

  function curLang() {
    return lang;
  }

  /** 取译文：en 查表（查不到原样返回），zh 直接返回原文 */
  function t(text, vars) {
    let out = String(text == null ? '' : text);
    if (lang === 'en') {
      const hit = EN[out];
      if (hit) out = hit;
    }
    if (vars) {
      out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
    }
    return out;
  }

  /** 静态 HTML：整句精确匹配，只在 en 下改写 */
  function applyStatic(root) {
    const scope = root || document.body;
    if (!scope || lang !== 'en') return;

    // 整段替换：段落里夹了 <code>/<b> 的，逐句匹配会碎成半句
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const html = EN_HTML[key];
      if (html) el.innerHTML = html;
    });

    const skip = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentNode;
        if (!p || skip[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      const raw = node.nodeValue;
      const key = raw.trim();
      const hit = EN[key];
      if (hit) node.nodeValue = raw.replace(key, hit);
    });

    // title / placeholder 这类属性也顺手翻掉
    scope.querySelectorAll('[title], [placeholder]').forEach((el) => {
      const title = el.getAttribute('title');
      if (title && EN[title]) el.setAttribute('title', EN[title]);

      const ph = el.getAttribute('placeholder');
      if (ph && EN[ph]) el.setAttribute('placeholder', EN[ph]);
    });
  }

  window.DTI18n = { t, setLang, applyStatic, lang: curLang, dict: EN };
})();
