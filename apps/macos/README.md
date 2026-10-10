# Magic Code 原生 macOS App

SwiftUI／AppKit 提供图形客户端与一次性平台控制入口；包内 `magic-runtime` 同时提供 CLI、Engine 和短时配置调用。Engine 是由当前登录会话的 launchd 托管的管理者主进程。App 与 TUI 分别接入它，退出任一入口不停止已受理工作。当前目标为 macOS 26 / arm64。

## 构建与检查

从仓库根目录执行：

```sh
bash scripts/macos/build.sh
bash scripts/macos/verify.sh
```

- `build.sh`：typecheck、编译 standalone helper、Xcode 构建 App、Apple Development 签名与 DMG。默认 Release；产物为 `.artifacts/macos/Magic Code.app` 和 `Magic Code-0.1.0-arm64.dmg`，同版本覆盖同一路径。可通过 `MAGIC_CONFIGURATION`、`MAGIC_SIGN_IDENTITY` 指定已有构建配置和身份。使用中的包或镜像不会被覆盖。
- `verify.sh`：签名核验、隔离 HOME 下直接运行编译版 Engine、受控模型与真实工具、客户端离开及明确停止的资源核销；存在同版 DMG 时核验镜像。不启动图形 App 或加载 launchd 任务。
- `check.sh`：Xcode 原生测试，包含共享 wire corpus、受控平台与 App 状态机、真实 helper，以及原生窗口测试。Xcode 构建可能向 LaunchServices 登记构建包；窗口及系统验证应在当前任务授权范围内运行。

构建通过命令级 `DEVELOPER_DIR` 选择 Xcode，默认 `/Applications/Xcode.app/Contents/Developer`。helper 内嵌运行所需模块，不依赖安装全局 Bun。`bun.lock` 与 `patches/undici@7.29.1.patch` 固定网络依赖及 Bun 流取消修复。仅 helper 带 JIT entitlement。Apple Development 签名和镜像核验不代表 Developer ID 公证发行。

## Engine 与客户端边界

- 同包原生入口 `--internal-engine-control` 读取既有 `baseDirectory` 偏好，并在私有生命周期锁内完成状态、启动、停止和实例切换。它不创建 SwiftUI 界面，操作结束即退出。
- launchd 任务加载到 `gui/<uid>`，plist 位于用户私有 runtime 目录，不放入自动加载的 LaunchAgents。`KeepAlive.SuccessfulExit=false` 恢复异常退出；正常停止返回 0。任务参数固定包来源、所选父目录和生命周期身份，不保存 TUI 环境。
- Engine 使用 `--internal-engine` 启动，持有发现发布、一个记录库连接、进程内 Agent 异步实例与工具归属。Agent 不对应独立 executor 进程。工具通过统一启动屏障，在 PID／启动时间和持久归属登记完成后执行。
- Engine 自己发布 `~/Library/Application Support/Magic Code/runtime/host.json`。残留文件不能证明在线；状态需核对实际进程及握手。App 退出不删除发现、不关闭 Engine。`native.stop` 停具体工作，`native.engine.stop` 停整个 Engine，均核对目标身份。
- 正常工作入口自动启动未运行的 Engine。`magic engine status`、刷新、重连及设置专用入口只查询。公开 CLI 控制为 `magic engine status|start|stop`；明确停止命令直接执行，不再追加终端确认。
- 全范围停止关闭准入、取消各 Agent 并收妥工具后才成功。失联时短控制先移除系统任务，再复用 TS 资源回收。停止发起者离开不挂断该操作。重启只核旧资源与中断状态，不自动续跑。
- TUI 首次提交／明确继续携带其启动时继承的环境与 cwd。正在运行的工作及成员共享不可变环境与专属网络连接；接回不替换环境，完成后继续可用新环境，工作区与数据实例保持原归属。

## 图形行为与设置

菜单栏面板显示真实 Engine 状态及启停动作，工作列表仍表达各项工作的事实。“停止 Magic Engine…”展示影响清单并默认取消；“退出 Magic Code”只退出图形 App，未保存的设置草稿仍按原规则处理。

长期窗口可见时，`LongLivedWindows` 将 App 切换为 `.regular`，提供 Dock 与 Cmd+Tab；全部关闭后返回菜单栏 `.accessory`。瞬时菜单面板不改变此策略。已有工作展示／复制固定工作区与数据实例的 `magic resume ID`，不自动开终端或继续工作；新草稿通过 Terminal.app 启动真实 TUI。

配置读取、校验和保存通过共享 TS 配置动作完成，不依赖 Engine、不打开业务记录库。保存结果与运行采用分别呈现。实例切换在旧 Engine 内核实无责任并关闭准入，再停止、移除旧任务、提交选择；原先已停止则保持停止，提交后新启动失败保留新选择。

Engine 保存提醒事项与未读事实，只有在线 App 投递系统通知。每次连接的首次快照只建立水位，不补发离线事项；断连取消尚未提交的合并批次。提醒偏好、系统权限、TUI 绑定抑制和送达／已读分离仍生效。

## 隔离系统验证

普通 Debug 与 Release 均使用产品身份。真实系统验证使用独立 `com.magiccode.validation.<UUID>.dev` 副本，Info.plist 固定 `/private/tmp/magic-system-test-*` 根。隔离参数仅 Debug 可用；Release 拒绝使用验证身份控制或启动，避免回落到用户实例。

```sh
python3 -B scripts/macos/engine-system.py --prepare '/path/to/Debug/Magic Code.app'
# 获得当前任务的系统操作授权后：
python3 -B scripts/macos/engine-system.py --run /private/tmp/magic-system-test-...
python3 -B scripts/macos/verify.py '/path/to/Debug/Magic Code.app'
```

`engine-system.py` 检查并发 CLI 启动、异常恢复、旧代请求、非默认实例与可识别启动错误；`verify.py` 检查 App 退出／强杀不停止 Engine、重开复用同代，以及明确停止。`idle-probe.py` 检查真实 App 与独立 Engine 的空闲活动。

`verify-terminal.py --prepare/--run` 检查新草稿的真实 Terminal.app 链路与已有工作的接回命令。`system-test.py` 是使用受控工作事实的通知／登录集成装置，不能作为真实 Engine 托管证据；其系统写操作须有对应授权，步骤见 [SYSTEM_TEST_PLAN.md](SYSTEM_TEST_PLAN.md)。历史验收记录见 [VALIDATION.md](VALIDATION.md)，不代表当前分支已通过系统验收。

## Wire

TS 权威定义在 `packages/contracts/src/native.ts`；Swift 与 TS 共用 `tests/fixtures/native-wire/*.json`。合法样本保持形状，非法字段及未知变体拒绝。当前 family 为 `NativeRequest`、`NativeResponse`、`HostDiscovery`、`SettingsRequest`、`SettingsResult`；不保留旧 App 宿主生命协议。
