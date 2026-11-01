把 Discord 里的英文、日文、韩文、俄文消息自动翻译成中文，译文以带「译」标记的小字显示在原文下方，原文完整保留随时对照。

## 下载哪个

| 文件 | 说明 |
| --- | --- |
| **DiscordTranslator_1.0.0_x64-setup.exe** | 安装版，**推荐**。装完有开始菜单项和卸载入口 |
| **DiscordTranslator.exe** | 便携版，免安装双击即用，配置仍存在 `%APPDATA%\DiscordTranslator` |

浏览器扩展和 BetterDiscord 插件不在这里发二进制，源码在仓库的 `extension/` 和 `betterdiscord/` 目录，按 README 加载。

## 核心特性

- **6 个翻译源自动降级** —— 腾讯 → MyMemory → 彩云 → Google，一个挂了自动换下一个，还带冷却和额度检测
- **本地语种分组** —— 先按 Unicode 区间把消息按语言分组再批量请求，避免英日韩混排时整批翻错
- **SQLite 持久缓存** —— 30 天 TTL，重启不重翻、不重烧 API
- **额度自动踢出** —— 某个源额度耗尽时移出降级链并显示恢复倒计时，不白发请求
- **发送前翻译** —— Discord 输入框里按 `Alt + Enter`，把你要说的话翻成目标语言填回去（不自动发送，检查后按 Enter）
- **断线自动重连** —— Discord 自己重启/更新后自动恢复；若它没带调试端口会弹系统通知
- **完全离线可选** —— 一键引导部署 LibreTranslate（Docker）或 Ollama，不联网不花钱
- **多版本支持** —— 稳定版 / PTB / Canary 任选
- **快捷方式接管** —— 让桌面上的 Discord 图标直接带上翻译启动，可随时还原

## 安装步骤

1. 运行安装包
2. 打开 **Discord 自动翻译**
3. 点【连接 Discord】—— 如果 Discord 正在运行会**重启它一次**（需要开调试端口），语音会断、草稿会丢
4. 点【接管 Discord 图标】，之后点原来那个 Discord 图标就能正常翻译

> **未签名的说明**：首次运行会遇到 Windows SmartScreen 蓝色提示，点「更多信息」→「仍要运行」。这是没有购买代码签名证书的正常现象，不是文件有问题。

## 体积

- exe：**5.01 MB**
- 安装包：**2.06 MB**

不需要 Node.js、Python 或任何运行时。WebView2 在 Win10 1803+ 是系统自带的。

## 已知限制

- 只在 Windows 上实测过（x64）
- 调试端口只监听 `127.0.0.1`，但本机任何程序都能连上去执行 JS —— 这是 CDP 方案的固有代价，不是实现缺陷
- Ollama 一键部署的完整流程未实测（会下载约 2GB 模型），LibreTranslate 的 Docker 路径已验证检测与引导逻辑
- 腾讯、彩云用的是网页内部接口，不是公开 API，随时可能失效（`auto` 链会自动绕过）

## 技术实现

Discord 桌面版是 Electron 应用，本程序用 `--remote-debugging-port` 拉起它，再通过 Chrome DevTools Protocol 注入 DOM 适配层。翻译请求由宿主进程发出（Rust / service worker），因为 Discord 页面的 CSP `connect-src` 只放行 discord.com。

完整原理和开发说明见 README。
