# Magic Code 原生 macOS App

SwiftUI 菜单栏与 AppKit 生命周期承载内置 `magic-runtime`。Xcode 工程是 App 与 Swift 测试 target 的权威；TS 的 wire 定义仍来自 `packages/contracts/src/native.ts`。当前本机验证范围为 macOS 26 / arm64。

## 本地入口

从仓库根目录执行：

```sh
bash scripts/macos/build.sh
bash scripts/macos/check.sh
bash scripts/macos/verify.sh
```

- `build.sh`：TS typecheck → Bun standalone helper → Xcode App → 嵌入 → 从内到外签名 → 隔离模型/工具探针 → DMG。开发包位于 `.artifacts/macos/Magic Code Dev.app` 和同名 DMG。
- `check.sh`：Xcode Swift 测试、共享 JSON corpus、可控 helper 状态机与真实签名 helper 的 Pipe 测试。已存在开发包时复用其 helper；缺包时才调用完整 build。每次保留独立 `.xcresult`。
- `verify.sh`：校验签名与 helper 权限；临时 HOME/MAGIC_HOME、最小 PATH 下验证真 App 进程的显式退出/强杀 EOF、真实模型/工具执行链；DMG 挂载后复制到临时 Applications、卸载映像，再启动验证。默认只验证开发包，不操作真实用户数据、Terminal.app、通知或登录项。

脚本通过命令级 `DEVELOPER_DIR` 选择 Xcode，默认 `/Applications/Xcode.app/Contents/Developer`，不调用 `xcode-select --switch`。Bun 版本、锁文件快照和 Xcode/OS/架构记录在 `.artifacts/macos/build-info.json` 与 `bun.lock.snapshot`。Bun 构建插件只消除 Ink 的可选开发调试器分支，不修改依赖文件，不使用 external JS 模块。

需要仅跑 Swift 时，先确保已存在签名开发包，再运行 `check.sh`。它不会证明复用的 helper 与当前尚在变动的 TS 源一致；最终集成由完整 build 后接 check/verify 建立。

## 宿主与原生边界

- App 以 `Helpers/magic-runtime --internal-manager --host-instance UUID --app bundle.path` 启动管理者。Foundation Pipe 的写端设置 `FD_CLOEXEC`，父进程关闭多余端；stdout JSONL 和 stderr 持续收取。`MAGIC_HOME` 只在选择自定义基础目录时传入。
- `host.ready` 决定实际 socket/base/config/identity。App 原子发布私有 `host.json`，并持单实例锁；发现文件只删本代。开发路径为 `~/Library/Application Support/Magic Code Dev/runtime/host.json`，正式路径为 `Magic Code/runtime/host.json`。
- 普通状态观察只发送 observer hello 与 NativeRequest，不持有宿主权限。投影整份替换，按 serviceInstance/revision 核对；停止原样回传投影的 serviceInstance/gen，gen 是停止目标代次。
- 请求退出后等待匹配的 `host.stopped` 与管理者成功退出，才向 AppKit 确认完成。失败/超时保留同一个 shutdown request，重试不会重启宿主或重开准入。无确认而进程已死时保留故障，不伪造成功。AppKit 模态等待期间的回执用对应主 RunLoop mode 投递。
- 状态栏只展示投影。展开详情、终端接回、单项停止均有明确目标；面板交互期间分组顺序稳定，最近结果限制 10 项。退出确认列出 `affected` 影响工作，取消为回车默认动作。
- 缺省是菜单栏形态（`LSUIElement` ＋ `.accessory`：没有 Dock 图标、不进 Cmd+Tab）。**长期窗口**（设置窗口、通知/事项定位窗口）在屏上时切 `.regular`——Dock 里有图标、Cmd+Tab 切得到、被盖住也找得回来；长期窗口全部关掉就回 `.accessory`。**点菜单栏展开的那块瞬时面板不算长期窗口**，不为它切策略。策略只在 `LongLivedWindows` 一处改，判定盯的是窗口的 `isVisible` 本身（AppKit 没有「被 order out」这条通知，而关掉设置窗口走的正是 order out——只盯 `didBecomeKey` 会让 Dock 图标留在那儿下不来）。
- 终端启动通过私有 `.command` 文件和 NSWorkspace 打开 Terminal.app；现有会话传 `--session ID --open-request UUID`，新草稿只传 open request。应用打开回调只证明启动请求，匹配 `native.attached` 才确认接入。
- 通知默认关闭。设置中显式启用才申请权限；两秒合并、按事项去重、送达/已读分离。未 ready 的点击意图保留到同一 App 就绪，之后核对 dataDir 并 inspect 实际事项。多个事项进入选择窗口。
- 设置提供登录启动、通知授权状态、自定义基础目录、CLI 符号链接与卸载集成。基础路径下追加 `.magic`；切换数据目录必须无在途影响并先停止旧宿主。安装冲突不覆写，卸载只删除归本 App 所有的链接，用户记录保留。

## 开发身份与分发

Debug 使用独立名称、bundle ID 和发现目录；未明确配置时生成临时数据基础目录。`--validation-root TEMP` 与 `--validation-quit` 仅在 Debug 生效，用于隔离验证真正的 NSApplication 生命周期。Release 不解析这些测试参数。

默认使用 ad-hoc hardened runtime 签名。仅 Bun helper 带 `com.apple.security.cs.allow-jit`，原生 App 无 JIT entitlement。正式发行入口需明确设置：

```sh
MAGIC_CONFIGURATION=Release \
MAGIC_SIGN_IDENTITY='Developer ID Application: 实际身份 (TEAMID)' \
MAGIC_NOTARY_PROFILE='实际 keychain profile' \
bash scripts/macos/build.sh
```

Release 脚本执行 helper/App 签名、公证装订、DMG 公证装订与 Gatekeeper 评估。身份和 profile 由正式发布负责人提供；本机 ad-hoc 通过不能代替正式发行验证。`verify.sh` 当前自动入口是 Debug 隔离验证，不会擅自启动 Release 去读取默认用户位置。

本地验收与未验边界见 [VALIDATION.md](VALIDATION.md)。

## 共享 wire fixtures

`tests/fixtures/native-wire/*.json` 每项格式为 `{ "family": "…", "valid": true, "message": { … } }`，family 为：`NativeRequest`、`NativeResponse`、`HostRequest`、`HostResponse`、`HostDiscovery`。Swift 和 TS 应读同一 corpus；非法样本必须拒绝，合法样本 Swift decode/encode 保持 JSON 形状。当前 41 项，不提供旧协议兼容解码。


## 独立系统验收装置

`verify-terminal.py --prepare/--run` 独立执行真实 Terminal.app 接入；默认 build/check/verify 不开终端。`system-test.py prepare/read-only` 创建独立签名 Debug bundle、包内固定隔离根、默认禁止通知/登录写操作。系统权限/发送/注册只能在独立授权后通过 capability 门启用生产设置入口；具体有界步骤与恢复见 [SYSTEM_TEST_PLAN.md](SYSTEM_TEST_PLAN.md)。真实系统动作不纳入默认检查。
