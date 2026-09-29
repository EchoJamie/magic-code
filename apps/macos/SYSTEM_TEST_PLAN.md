# 系统交互验收申请方案

状态：**装置已刷新，尚未授权执行通知/登录项变更**。基于f0172b00d5e489a1217c704bb95875624a209f30已实际build/check/verify/DMG搬移/Terminal两例通过。两份固定身份重签且manifest一致；旧c78 Enter目标红原件保留，新cold副本由CLI实测16/16通过，原Session Enter草稿正确；当前主线接唯一新UI批。本会话不自行请求权限、不发送系统通知、不注册登录项，不占Cua。

## 系统通知：一次有界验收

> **2026-09-29 改版（U102，按设计正文·通知节的收敛版）**：设置里是**两格、两件事**——
> ① **「提醒我」＝我们的偏好**：一个开关，**默认开**；下面一行写死分寸（「只在需要你、失败或结果可查看时提醒；你在看的时候不打扰。」）。
> ② **系统那一格不进常驻**：授权「已允许」是没有新增信息的一格；**只在受阻时出现**——被拒 →「系统里还没允许通知 → 去系统设置允许」；静默送达 →「只进通知中心，不弹横幅 → 改提醒样式」；偏好关着则那一行不出现。
> 请求由 App **就地发起**：偏好开而系统未问过 ⇒ **第一次真要提醒时**才请求（**不是首次启动**）；系统框只在第一次调用时出现。
> 装置读数：`system-state.json` 里 `notificationPreference`（我们的偏好，新身份为 true）、`notificationAuthorizationStatus`（系统原始枚举：0 未问过 / 1 拒绝 / 2 已允许 / 3 静默送达）、`notificationAuthorization`（人读文案）、`appActive`（判横幅时排「发送方在前台」这一条用）。
> 另：**换签名（CDHash 变）会让已获授权作废**（实测同一身份从「已允许」变「已拒绝」），重签后按实际状态重新走授权。

### 对象和执行入口

已经生成独立 Debug 验收 App 副本，名称 `Magic Code 系统验收`，bundle ID `com.magiccode.validation.1c90fc61d76d4e2a860e322ca83fcf2e.dev`，固定根 `/private/tmp/magic-system-test-lwdifnbs`，App 路径 `.artifacts/macos/system-test-ready/Magic Code 系统验收.app`。由命令级 Xcode 构建、重新签名，保留产物和原始日志；确切当前哈希见同目录 `current-identity.json`，历史实际 UI 对应 `native-seams-identity.json`。日常 App 的通知设置不更改。

系统通知权限以真实系统用户和 bundle ID 为边界，**改 HOME 并不能隔离通知授权**。因此测试身份必须独立；不运行 `tccutil reset`，不改系统通知数据库，不重置现有 App 授权。首次启动先核对设置状态，不假定 ad-hoc 身份一定能获系统通知能力；若身份不足或系统拒绝投递，报告阻塞，不切换到无身份脚本发送冒充 App 通过。

独立测试副本须在 Debug 启动入口固定本轮 validation root，使通知点击启动/重启时不依赖命令行参数，也不会落到真实 `~/Library/Application Support/Magic Code Dev` 或真实 `~/.magic`。默认自动验证仍禁止系统集成；只有独立副本的显式测试开关允许设置页使用生产 `setNotifications`、NotificationCoordinator 与 UNUserNotificationCenter。开关已实现为固定临时根内、绑定 bundle ID 的 capability 文件；默认不存在。装置只读启动已证明两个写能力均为 false。授权后才允许驱动写该文件；准备装置本身不等于获得系统动作授权。

具体操作由测试人员打开这个独立 App 的设置页，通过“启用系统通知”→用途说明→继续调用生产权限入口。合成事实仅含下表标题/项目和无敏感信息的状态，通过受控 helper 的投影进入生产通知合并器；不直接从脚本调用通知 API 绕过 App。

### 次数、内容与判据

一次执行控制在 **最多 1 次首次系统权限弹框、5 次系统通知 add 请求、最多 5 条可见横幅、2 次通知点击到生产 TerminalLauncher 的 collector 回执（不新开终端）**。不设重试循环；失败保留证据后停止。权限入口申请 alert/sound/badge 能力，但发送内容不设置 sound、不写 badge 数值；预期无声。N7 未单独批准则最多4次 add，不改专注模式。

| 步骤 | 实际动作与内容 | 上限/判据 |
| --- | --- | --- |
| N0 默认关闭 | 启动后推入一条“通知验收：默认关闭”合成事实 | 0 次请求权限、0 次 add；状态栏仍可查看 |
| N1 拒绝 | 设置中显式启用；若系统尚未决定，测试人员选择“不允许”。再次点启用只查看拒绝状态 | 系统弹框最多 1 次；不反复申请，不发送通知 |
| N2 允许 | 测试人员在系统设置中只将本次测试 bundle 改为允许，再返回 App 启用 | 不新弹权限框；记录前后 authorizationStatus |
| N3 需要答复 | 两秒内同工作两条合成事实；标题“通知验收 A：需要答复”，项目“原生验收”，正文“需要你的答复，请在终端查看” | 合并为 1 次 add。送达后仍 unread；点击只核对应具体 ID，返回 work 含该事项才 read 该一个，另一条仍未读，并产生隔离 TerminalLauncher collector 回执 |
| N4 失败 | 标题“通知验收 B：失败”，正文“工作遇到问题，请查看当前状态” | 1 次 add；不含命令、日志或审批正文 |
| N5 多结果 | 两秒内 C、D 两项完成；标题“2 项工作有新结果”，副标题“Magic Code”，正文“打开查看工作与结果” | 1 次 add；点击进入真实多通知选择窗口，选择一项只产生一条对应的 TerminalLauncher collector 回执 |
| N6 恢复/单结果 | 标题“通知验收 E：结果”，正文“结果已可查看”；送达后重启同一 App、重放同一投影 | 首次 1 次 add；恢复和重放 0 次追加，delivered/read 分离 |
| N7 勿扰 | 测试人员先记录当前专注模式，经本次授权短暂开启勿扰；标题“通知验收 F：勿扰”，正文“结果已可查看” | 1 次 add；横幅是否抑制由系统实测记录。恢复原专注模式后 App 不主动补弹历史；系统自身延期显示另记 |

累计 add 上限 5（A、B、C/D 摘要、E、F）。需要答复与失败的合并优先级、已读取消、未 ready/已处理/跨实例分支已有受控状态机测试；本轮不额外发送真实通知凑覆盖。N6 冷启动点击如需重复投递，必须占用上述既有通知，不提高次数。

### 桌面影响与恢复

- 最多出现上述系统权限框和 5 个无声横幅。操作通知中心、系统设置、点击通知会短暂占用桌面；由批准的执行时段进行。
- 单通知点击可能激活验收 App，摘要点击会显示自己的选择窗口；此通知装置不启动 Terminal，点击落到生产 AppModel/observer 后由 TerminalLauncher collector 留证；真正 Terminal→包内 CLI→attached 由下节独立装置完成。
- N7 会短暂改变本用户的专注模式，只有本方案明确包含此项授权时才执行；未批准则标“勿扰实测未验”，其余步骤可独立进行。
- 结束时从测试 App 关闭通知开关，仅按本轮 request identifier 删除它的 pending/delivered 通知；恢复原专注模式。由测试人员把该测试 App 的系统“允许通知”关闭，然后正常停止测试宿主和自己打开的 TUI。
- 独立 bundle 的系统授权记录可能在移除 App 后继续保留，不能承诺恢复为从未申请状态；保留测试身份记录，不删除系统数据库。App/日志留 worktree，临时业务数据只含合成内容。

证据包括：签名/bundle/临时根、权限前后状态、每次 add 的 request ID/合并事项、系统 delivered/pending 查询、业务 delivered/read 前后、受控点击回执、App/helper/Terminal 进程归属。真实横幅与权限框在授权时单独截图；只截本次测试界面，不采集其他应用内容。

## 长期窗口的 Dock 与 Cmd+Tab（U104，2026-09-29）

有长期窗口（设置窗口、通知/事项定位窗口）在屏上 ⇒ App 切 `.regular`（Dock 有图标、Cmd+Tab 切得到）；长期窗口全部关掉 ⇒ 回 `.accessory`；**菜单栏那块瞬时面板不算长期窗口**，不为它切策略。

装置 `scripts/macos/dock-cmdtab-probe.swift`（需辅助功能授权，真点子项/真点按钮/真按 Cmd+Tab/真移鼠标让 Dock 浮出来）：

```sh
xcrun swiftc -O scripts/macos/dock-cmdtab-probe.swift -o /tmp/dock-cmdtab-probe
/tmp/dock-cmdtab-probe --app ".artifacts/macos/Magic Code Dev.app" --root /private/tmp/u104-accept --out .artifacts/macos/u104
```

App 以 `--validation-root` 隔离启动，装置自己起、自己收（不给 `--pid` 时）。四态各留真帧：无窗口（Dock 无图标＋Cmd+Tab 走遍一圈都到不了它）、面板（Dock 无图标＋一条策略切换都没多）、设置窗口（Dock 有图标＋Cmd+Tab 走到它）、关掉（回 accessory，Dock 与 Cmd+Tab 里都没了）。读数 `<root>/activation-policy.json`（`policy`／`presentWindows`／**只记真切换的** `changes`）由 App 每 0.5 秒写一次，供装置核对；`system-state.json` 在系统验收身份下同样带这三项。

两条读数口径（实测，别再踩）：`NSRunningApplication.activationPolicy` 是**启动时的快照**，切了策略它不变，不能拿它判；`NSWindow` 的「被 order out」没有通知，只能盯 `isVisible`（KVO）。

## Terminal：f017同版包已实测

生产 TerminalLauncher 有 Debug 限定的隔离录制装置：NSWorkspace 仍打开实际私有 `.command`，CLI 始终是当前 App 的 `Contents/Helpers/magic-runtime`。validation root 来自参数或独立测试 bundle 的固定根，清空继承环境，设置相同临时 HOME/ZDOTDIR、MAGIC_HOME、最小 PATH；用系统 `script` 留本次 PTY 输出。不能只设 MAGIC_HOME，因为 CLI 的固定 host.json 发现根来自 `os.homedir()`。

f017包已跑通2例：新草稿（仅 open request、session=null）和一条 loopback 模型生成的已完成会话（session+open request），原件 `terminal-core-f0172b0/`。均等待生产 App observer 收到匹配 `native.attached` 并清掉 Pending；NSWorkspace 回调或 CLI 进程存在都不是成功。helper/native/source-input的确切hash见 `final-artifacts.json`、独立副本 `current-identity.json`。

NSWorkspace 配置 `createsNewApplicationInstance=true`、`activates=false`、不加入最近项目。记录现有 Terminal PID 集和之前前台 App PID；若 LaunchServices 复用旧实例则判失败，不发送键盘或窗口操作。若新实例抢焦点，仅在前台仍是该新实例时恢复原应用；用户自行切换后的焦点不回抢。

TUI 退出只给已核对本轮 open-request、helper 路径和进程祖先的 CLI PID 发 SIGHUP，走生产 TUI 挂断路径；记录 exit code/PTY 输出并证明 App 管理者仍活。两例的目标均未运行工具，不能用它证明挂断中的执行工作绝不被 interrupt；TUI脱离修正已在c78，其真实多PTY执行中验证由CLI/root另报。不会 killall、不会 AppleScript 控制 Terminal、不会要求新增辅助功能或自动化授权、不会操作现有窗口。结束窗口依 Terminal 当前偏好保留，不修改偏好。

另有 `cold-reopen-ready/manifest.json` 独立身份供主线/CLI跑旧TUI的 ctrl+r→生产 open App 冷启动。此副本无 controlled fixture，固定另一临时根、使用 compiled helper 与真实 Terminal；不与本方案正式通知身份混用。无 argv 冷启动/无效根拒绝/两种系统禁写已局部验证，CLI/root已证明冷重开保留历史草稿、零自动模型；随后Enter却写入新Session，是明确产品红。c78副本已完整保留到core-c78a3d3-preserved；固定路径当前已实际刷新f017，由CLI复验，不提前称整包最终完成。

## 可选登录项：方案单列，尚不操作

静态事实：默认没有任何 register 调用；启动只读 `SMAppService.mainApp.status`，设置开关读取系统状态，没有另存一个可能过期的 enabled 布尔值。App 恢复前台时刷新状态；validation 模式默认禁止 register/unregister，只有固定隔离身份的明确 login capability 可放开。首次默认关闭可在独立未注册 App 身份只读检查；原身份若历史上已注册，不能冒充“首次默认”结论。

若规划侧授权实际开关测试：使用上文已有 `Magic Code 系统验收` 的确切 bundle/路径/根，不另造“登录验收”身份，也不暗中迁移安装路径；先截图记录其 status（目前3/notFound）。设置中开一次（register 1 次），读取 enabled/requiresApproval；如 macOS 要求用户批准，仅由测试人员在“登录项与扩展”操作该单一测试项。关一次（unregister 1 次），证明当前 App/管理者不因此退出。若当前路径或签名不满足注册要求，报告实际错误，由主线决定后续路径/身份，不绕开限制。

再开一次（register 第 2 次），测试人员在系统设置撤销该测试项；返回 App，开关应读取真实状态。若 requiresApproval，不显示伪成功。最后 unregister 清理（至多第 2 次），读回 notRegistered，保留清理证据。**不注销、不重启机器**；真正登录后启动另需独立时段，因此这一轮只能证明注册/撤销与状态反映，不能宣称登录启动已实测。

可能出现 macOS 登录项后台提醒、系统设置审批页；不会修改用户其他登录项。若注册失败或需要正式签名身份，记录错误并停，不创建额外 LaunchAgent 绕过。恢复目标是本次测试项 notRegistered、用户原登录项完全不变。

## 已落地的可执行装置（2026-09-26）

固定入口：`python3 -B scripts/macos/system-test.py <action> --output .artifacts/macos/system-test-ready`。签名副本、bundle ID、临时根见该目录 `manifest.json`；不可更换其根来复用系统授权。`prepare` 只复制/签名 Debug App、内嵌受控 helper，`read-only` 冷启动不带 validation 参数，证明包内固定根有效；`launch --show-status` 打开本轮界面窗口，`status` 读取状态，`quit` 清空本轮合成投影后正常退出。包内根无效直接 exit 78，不回落用户 HOME。

通知/登录项均默认禁写。当前 `read-only-state.json`：通知尚未申请、偏好关闭、notificationWritesAllowed=false、loginWritesAllowed=false。登录项系统状态实际为 **3 / notFound**，不是 notRegistered；它证明只读状态反映和默认不开启，不能证明注册/撤销成功。独立身份位于 worktree，正式身份/安装路径是否满足系统注册要求须在批准时实测。

授权后才可执行 `grant --allow notifications --authorization '<明确授权记录>'`；登录项另选 `--allow login`，勿扰 N7 另选 `--allow n7`（可重复 allow 参数）。这只启用相应生产设置入口，不自动请求权限、发送通知或 register。批准执行者在该 App 设置中点击相关开关；合成投影由 `case --case A|B|CD|E|F` 推入。N0 用 `case --case default-off`。N7 驱动也不改变专注模式，实际切换仅由已批准执行者完成。

恢复：`restore-notifications` 关闭本 App 通知偏好并只清本轮 request IDs；`restore-login` 仅调用此独立身份的关闭入口。两者也要求对应授权。读取 `status` 并核恢复后，`revoke` 删除本轮 capability 文件（仅检查本轮授权的能力：通知授权要求偏好关闭；登录授权要求 notRegistered 或 notFound；仅通知测试不约束原登录状态，也不调用 unregister），最后 `quit`。系统通知权限本身由批准执行者在系统设置关闭；无 tccutil/数据库修改，无注销重启。保留整个副本和日志。

新增证据清单：manifest/signature、read-only-state、launch.stdout/stderr、固定根 system-state.json、system-notification-requests.json（默认不存在）、control.json 中 delivered/read 前后、authorization-record.json（未授权时不存在）、恢复后状态、实际系统框/横幅截图（尚未执行）。通知装置用受控 host，不冒充最新 TS manager；同版真实核心与 Terminal 的证据在独立联验目录。

### 恢复与撤权的逐条命令

以下均从当前 worktree 执行；`restore-*` **只有本轮对应能力已明确授权且执行过相关动作时才使用**。通知单独授权不运行 restore-login，不为满足断言改变原 notFound。当前未授权，所以只运行过 status/read-only/quit。

```sh
python3 -B scripts/macos/system-test.py restore-notifications --output .artifacts/macos/system-test-ready
python3 -B scripts/macos/system-test.py status --output .artifacts/macos/system-test-ready
# 等 system-command.json 被活着的 App 消费，新状态 notificationPreference=false，且本轮 request IDs 已清理。
# 系统“允许通知”由批准执行者仅关闭此 bundle；N7 若执行过，由批准执行者恢复原专注状态。

python3 -B scripts/macos/system-test.py restore-login --output .artifacts/macos/system-test-ready
python3 -B scripts/macos/system-test.py status --output .artifacts/macos/system-test-ready
# 仅 login 授权时执行上面两行；核命令已消费且 loginStatus 为0或3。
# 原为3且从未成功注册，仍只能记notFound，不能记注册/注销通过。

python3 -B scripts/macos/system-test.py revoke --output .artifacts/macos/system-test-ready
python3 -B scripts/macos/system-test.py status --output .artifacts/macos/system-test-ready
# 等两个 writesAllowed 均false；未运行App时无需仅为撤权再冷启动。
python3 -B scripts/macos/system-test.py quit --output .artifacts/macos/system-test-ready
```

命令写入成功不等于恢复成功：观察 App 消费 command、状态文件更新及对应生产回执后才 revoke。quit 后核 host.stopped+进程exit0+app.clean-exit，保留原件；没有活着的 App 时不为了 quit 再启动。全部恢复仅限本轮通知 IDs/独立登录项；不 reset TCC、不改系统数据库、不注销、不重启。

### 当前两份身份及边界

正式系统通知/登录验收只使用本文件既有 `system-test-ready` 身份，当前native SHA256 `3ed89219b36b1f3dbbcd97625c81a5a1a07ef2f2b67a186fd938cd7524eaaf13`；包内helper SHA256 `df91d0c045c784fdae4f09a0a2e131a3ded0498e9d92a30a5267593aed2180c8` 来自f017，实际host为包内controlled-helper.py，Terminal为collector。最新read-only-state两个writes=false、通知偏好false、尚未申请，login3/notFound；没有授权/通知请求文件。当前仍不运行任何grant/restore系统动作。

`cold-reopen-ready` 为另一独立bundle/root，不含fixture，实际compiled host/真实Terminal；明确交给CLI/root做冷Ctrl+R和退出联合验证，不能复用它获取正式通知授权。准确副本hash/签名/输入证据及启动控制见 `seams/cli-ready-f017.md`。原生UI出现Cua会话访问许可只授权访问这个隔离App，不等于系统通知/login能力授权。

装置刷新核验补记（2026-09-29）：受控fixture曾因手工刷新复制后为0644启动失败，read-only超时原件已保存before-fixture-mode-fix；恢复既有prepare要求的0700后deep/strict签名通过，二进制hash不变，最新只读冷启动已ready→stopped→exit0→clean-exit。该失败只属system-test-ready，不涉及无fixture的cold-reopen-ready；未执行任何系统写动作。

f017本轮仅运行正式系统装置的默认禁写read-only（正常确认收尾），没有启动cold副本，也没有执行grant/restore/system写动作。两份bundle/root保持不变，当前同版材料快照见f017-ready-records，cold已交CLI后原生停止触碰。
