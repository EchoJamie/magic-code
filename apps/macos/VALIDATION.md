# 原生 App 验证记录

更新：2026-09-29。分支 `feat/resident-macos-app`，工作树 `/Users/jamie/namespace/github/magic-code-resident-app`。未改TS、根package.json/.gitignore或他人测试，未stage/commit/push/merge，保留分支与工作树。

## 当前同版出口

基于 **f0172b00d5e489a1217c704bb95875624a209f30**（父c78）已实际重建helper/App/DMG，`build.sh → check.sh → verify.sh`、真实Terminal两例均exit0；**27 Swift / 0失败、41共享wire fixtures**、DMG搬移运行通过。c78→f017的219个生产构建输入仅 `packages/app/src/run/manager.ts` 变化，原生生产源未改；证据 `seams/f017-source-delta.json`。本次重验限新helper同版链，没有重做Cua/外观、90秒空闲或系统集成。

可运行本地ad-hoc hardened runtime开发包：`.artifacts/macos/Magic Code.app`、`Magic Code.dmg`。**不是已公证公开发行，也不提前宣布整单完成。** c78冷Ctrl+R后Enter写入新Session的红反例保留；f017为主线最小修复提交，新冷副本已明确核准交resident-cli，先实测同原Session再由主线唯一新UI批验取消/退出。CLI已归口回报新包冷Ctrl+R **16/16绿**：原Session df0fcabb-1670-4fe9-9c59-cd757628b96c，Enter草稿user2564仍落同Session，无自动工作，同批已清零。主线随后完成f017同包真实退出UI补验 **15/15通过**，详下节。原生未操作或读取活App/root；冷重开交接时点快照仍保留在seams/f017-cli-handoff-result.json，UI最终结论以root-review/ui-f017-final原件及本次文档补记为准。

当前原生源码与二进制已停止写入；只更新证据文档与归档。两副本固定bundle/root不变，cold本轮未由原生负责人启动，交接后不再读取/写入该副本或占Cua。ready见 `seams/cli-ready-f017.md`；通知/login/勿扰仍未授权，未grant、未申请、未发送、未register/unregister。

## 构建来源与产物

macOS26.6.2 arm64、Xcode26.6/17F113、Bun1.4.2。DEVELOPER_DIR仅命令级设置。build-info记录f017、dirty=true；219输入在构建前后集合与SHA一致，manager源码对应该core。输入清单涵盖根配置、build脚本、scheme、分包manifest和全部实际src；没有TSX文件，不把旧扩展过滤推断写成已发生缺陷。

- build-inputs文件SHA256：`3e6a08755a76f0f08fa88468a63dcca1e538087fb92aac239c3f0bbca630d02a`。
- source input digest（sorted compact JSON inputs-map SHA256）：`be2696e6bf071a84af49500ef9f7f94e6666c0b7897627e74c2cac38f3cb26be`。
- App native SHA256：`5ebfad46155a110342e337f8281547d922a79c6749b9a48698f5618c4b073031`。
- helper SHA256：`df91d0c045c784fdae4f09a0a2e131a3ded0498e9d92a30a5267593aed2180c8`。
- DMG SHA256：`2574be58e03edc2e1bca514e4d773ae4f4ffe89612c571bed6fbbc4ab8563e2c`。

`final-artifacts.json`和最新xcresult `NativeTests-20260929-003601.xcresult`标明本轮来源；不是只改metadata。c78三个App完整身份、DMG及原日志已保留 `core-c78a3d3-preserved/`；旧479/201输入、b434及原生修前失败仍在各before目录。c78规划归档 `native/20260929-c78a3d3/` 不覆盖，记录当时产品红事实。

## Swift与真实受控helper

`f017-check.log`、`xcode-test.log` 与对应 `.xcresult` 为27项全绿原件，当前通过包以 `final-artifacts.json` 指定为准。共享 `tests/fixtures/native-wire/**` 共41JSON，family为 NativeRequest、NativeResponse、HostRequest、HostResponse、HostDiscovery，TS可复用同一corpus。测试验证合法roundtrip、必需字段/变体/null拒绝、UTF-8 JSONL分片、0600发现/单实例/按代删除、投影稳定分组/最近10、Terminal引用及attached匹配、临时自有CLI链接冲突/移除、通知两秒合并与delivered/read分离、一次核心恢复、真实签名helper/Pipe EOF和后代不继承写端。

| 接缝 | 精确正反判据 | 原始证据 |
| --- | --- | --- |
| 同revision重握手 | welcome认证恢复连接就绪与投影去重分开；同连接welcome后匹配attached已处理才直接断言ready。wake/自动重连/retry均同宿主同投影；较新accepting=false仍停止，错服务拒绝 | seams/reconnect.json、reconnect-negative.json；独立旧原生源码副本before-barrier.xcresult/log三条直接状态断言红，不用等待ready超时冒充反例 |
| 普通详情不批量已读 | notice=nil只选择/详情/在场；列表、分组、整窗出现0ack；普通终端打开尚未attached也0ack | seams/plain-inspect-read.json |
| 明确单项已读 | 详情内逐事项入口；返回work/session且包含原noticeID才read该一个；空答/旧答、新竞入、同组其他work保留；三种错目标返回0read | seams/specific-notice-race.json、27项中的错work/缺notice/错notice-session断言 |
| 停止责任重试 | host.error/超时复用同shutdown request，保持准入关闭、不重启；stopped但进程活着仍不完成，exit1不能伪成功 | appmodel-stop-error/timeout/crash.json及相关测试 |
| 已停后的集成移除重试 | 复用hostStopped在host=nil后表达stopped+exit0；临时自有链接第一次IO抛错、第二次成功，1宿主/1shutdown/1完成回调；clean-exit仅清理成功后记录 | seams/integration-removal-retry.json；日志attempt1→attempt2→clean-exit，无真实SM API |
| 未ready通知点击 | 保留点击意图，ready后核dataDir与具体事项；已处理不复活，真跨目录拒绝 | appmodel-notice-processed/cross-instance.json |

helper为实际子进程、模型为生产AppModel/HostProcess/ObserverConnection，故障由受控Pythonfixture提供；不是重写一套状态机，也不冒充真实TS已触发这些故障。更早before-behavior含timeout仅为初始反例，before的编译错误不算产品反例。

## 实际原生UI与键盘

`system-test-ready`固定身份、临时根、无capability，用生产AppModel和受控helper验证：普通展开4项均未读/read=0；明确点ui-chosen-result，正文实际可见，只有该ID一次read，另两历史项和同组另一work仍未读。`specific-notice-ui/`保存前后control、trace、实际App状态。随后同App固定revision7，刷新连接及真实socket断线后ready→fault→ready，最后两welcome投影相同、host/service不变、仅1次started、无新工作。证据 `same-revision-ui/`、`native-seams-ui-evidence.json`。这是受控断线/调用唤醒处理函数，不是实际机器睡眠。

退出UI已按减法裁定使用 **NSAlert原生取消/停止按钮，SwiftUI仅影响清单**。Return默认取消，标准Tab循环/Space激活；实测NSAlert默认按钮下Escape未路由到响应链中的cancelOperation，故只在当前alert.runModal存活期间、event.window严格等于该alert.window且无command/control/option的Escape monitor调用已有取消按钮，defer移除。无自制QuitPanel/无效QuitAlertController、英文Cancel试验、SwiftUI焦点/按键补丁、原始Return拦截或临时诊断残留。

同一实际App：Escape→取消；Tab到停止后Return→取消；鼠标取消→取消，三次后同宿主且0shutdown；再Tab明确停止，Space→1次shutdown→stopped→exit0→clean-exit。原件 `system-test-ready/quit-keyboard/green-*`；**真实窗口PNG/AX**为 `actual-nsalert-stop-focused.png`、`.ax.txt`。原code53/响应链反例及旧窗口取消失败保留在同目录和root-review/quit-live.json。曾Space后Cua状态读取重新打开同一隔离App，已留原件并正常清理；之后不以Cua读取已退出App，避免重开。

实际截图包含1项影响；多项列表内容由投影/测试覆盖，不能冒称当前已实拍多项NSAlert布局。实际UI局部帧的native/hash见同目录identity，发生在最终factory文件位置调整之前；最终原生包的完整源码/hash另见构建manifest。没有用离屏帧冒充真实流程或VoiceOver发声。

有效离屏帧 **9张**：busy-light、detail-dark、detail-bottom-dark、idle、failure、settings-dark、settings-bottom-dark、notice-selection、quit-impact-list。主线已逐张实看通过；viewport末尾几何断言与实际键盘/AX补足路径/末行可达。quit-impact-list仅为三项SwiftUI附件清单，测试显式设Aqua/light背景后标题、当前原因、路径均完整可辨，不冒充完整NSAlert实拍。旧list PNG为黑字透明底（394388/432000像素全透明），不是无文字；其黑底查看不可读反例保留在 `seams/quit-impact-list-offscreen-invalid.png`，像素依据见root-review/quit-impact-list-pixels.json。完整NSAlert离屏cacheDisplay缺层，已删除该无效捕获；原件 `seams/nsalert-offscreen-invalid.png` 不计通过，完整退出框只用上节真实PNG/AX。旧SwiftUI退出帧只留历史目录。离屏设置16.0来自XCTest Bundle.main，不是产品版本；真实App设置此前AX显示0.0.0。

旧实际键盘/AX证据 `system-test-ready/actual-access-evidence.json`：Tab/Down至第10行、Return明确session接回collector；长路径完整AX和复制collector一致，Tab至末端移除入口但不执行。键盘/AX可达不等于VoiceOver实际朗读。

## f017同包真实退出UI补验

主线/CLI归口报告：`ui-exit-1790614104334` 实际Cua点击取消后，工具ticks从204继续到210；随后明确确认退出，App自行exit0。原result **15/15、无failure、signals=[]、remaining=[]**；原观察窗口3066ms、22个样本中没有自动重开，模型请求保持2，旧TUI完整保留history和draft。确认之后没有再次通过Cua读取App。

主线另逐一核对**全部全局样本**中的登记PID/start和完整所属tool PGID，独立于进程祖先过滤：47个全局样本、5436ms窗口内只有原TUI，core及toolGroup始终为空，模型请求始终2，无harness signals；最终全部已知自有资源为0。该全局审计与原3秒/22样本观察分别留证，不混成同一组采样。原件位于 `.artifacts/macos/root-review/ui-f017-final/`：12条原Cua事件、实际退出框截图、frame-source及 `global-resource-check.json`。原生仅消费文件与归口结论，没有复跑App或后读Cua。

上一批 `ui-exit-1790613629232` 保持原始红：实际点击正常，但root审计晚到，5秒装置等待门先进入finally；离线补证单独保留，**不改写原failure为绿**。本次授权补验把产品观察与审计解耦，生产源码及包未变。CLI继续归档其正反原件，最终归口路径由其交主线。

`final-artifacts.json`、包、identity与原归档manifest保持冻结；其中UI pending是交接时点快照，本段和规划归档的UI补验说明承接后到结论，不回写构建metadata、不要求重跑门。

## f017真实App、Terminal和DMG

`f017-build.log`、`f017-check.log`、`f017-verify.log`均exit0。签名standalone不依赖全局Bun/源码，loopback合成模型/工具闭环通过。正常App22832/manager22835，强杀22851/22854；有工作manager22860、工具22865/22867，关闭客户端工作保留、强杀App后manager/工具回收。DMG校验、只读挂载、搬移至临时Applications、卸载后运行通过（正常22955/22956，强杀22958/22959）。原件 `native-lifecycle.json`、`hosted-model-tool.json`、`hosted-*`、`app-*`、`relocated/` 与dmg日志。

`terminal-core-f0172b0/summary.json`：生产TerminalLauncher→private .command→新Terminal.app→同包CLI→匹配observer attached。新草稿App23009/manager23010/Terminal23024/CLI23067，session=null；已有会话App23101/manager23102/Terminal23112/CLI23128，session=b08414de-2d1b-4e49-b2ec-900450c833c0。均reused=false、restoredFocus=false；只向本次已核身份CLI发SIGHUP，退出0且App/manager仍活，再App EOF收尾。保留PTY/context/ancestry/exit-code，不碰用户现有窗口，终端结束窗口依原偏好保留。

这两例验证新Terminal主动打开，不替代旧TUI冷Ctrl+R后的原Session输入回归。f017未重跑长期空闲：c78的91.15秒、9采样单manager零executor、第二App拒绝证据仍在 `idle-duplicate-c78/`，不把旧采样冒充新helper运行。

## 两份固定系统装置

正式系统验收：`system-test-ready/Magic Code 系统验收.app`，bundle `com.magiccode.validation.1c90fc61d76d4e2a860e322ca83fcf2e.dev`，root `/private/tmp/magic-system-test-lwdifnbs`；native SHA256 `3ed89219b36b1f3dbbcd97625c81a5a1a07ef2f2b67a186fd938cd7524eaaf13`，包内helper同f017，但实际host为受控fixture（SHA256 `a404240ab0bb221aa9119f921fa3917b418dfbc508e5555015eed6d1306af405`、0700），Terminal collector。已重签deep/strict通过；最新read-only为ready→stopped→exit0→clean-exit，两writes=false、通知尚未申请/偏好false、login3/notFound，无capability/通知请求。此前c78手工刷新曾使fixture0644而超时，原件在before-fixture-mode-fix；没有生产修补，本次准备即保持0700。

冷重开：`cold-reopen-ready/Magic Code 重连验收.app`，bundle `com.magiccode.validation.reopen.21c88f6d455847e68265c33f3353ba01.dev`，root `/private/tmp/magic-system-test-reopen-iwkgqq70`；native SHA256 `4d2cd202d733a29b002f3c6d905cff8d066aa772472379bb011e128371c30260`，helper SHA256 `df91d0c045c784fdae4f09a0a2e131a3ded0498e9d92a30a5267593aed2180c8`。无fixture、真实compiled manager/Terminal；固定根/无效根拒绝/默认禁系统写逻辑未改。manifest顶层helperCoreCommit旧479已修为f017并与current-identity/sourceBuildInfo一致；旧错误manifest保留。仅签名身份改变导致副本native hash不同于产品包，不能声称逐字节相同。

本轮没有启动cold App；其旧c78 read-only-state仅历史状态，不当作f017运行验证。归档用交接前静态快照 `f017-ready-records/`，交接后不碰CLI持有目录/Cua。系统正式通知身份与cold不混用。

通知/login方案、次数/桌面影响和restore/revoke/quit逐条命令在 `SYSTEM_TEST_PLAN.md`，身份与manifest一致。恢复只针对本次实际授权能力，通知单独不要求login notFound变化、不调用未授权unregister；命令入队不算恢复成功。真正登录启动不注销/重启，所以未验；DeveloperID/公证/Gatekeeper/CI runner、VoiceOver发声、真实睡眠、多屏/小屏仍未验。

## 对照设计验收边界

| 设计项 | 实测与未验 |
| --- | --- |
| 空闲/重复App | c78的91秒/单manager/零executor/重复拒绝通过；f017未重跑长期采样 |
| Terminal | f017新草稿与已有会话两例attached通过；CLI归口冷Ctrl+R/Enter原Session 16/16通过，原生不冒充自行操作 |
| 客户端离开与宿主寿命 | f017客户端关后工具保留、App EOF回收manager/工具；Pipe写端不继承测试通过 |
| 退出/影响名单 | 生产AppModel强判据/重试27测试通过；原生NSAlert键盘实际证据及9帧此前主线通过；f017同包主线真实取消继续、明确退出15/15及独立全局资源核销通过 |
| 已读/通知 | 具体ID/普通0ack/竞入保留、两秒合并/恢复已验；真实系统权限、横幅、通知中心点击、勿扰待授权 |
| 登录项 | f017默认禁写、真实状态3/notFound只读已验；开关/系统撤销未授权，真实登录启动未验 |
| 设置/安装 | 长路径AX/复制/末端键盘可达；临时自有CLI链接安装/冲突/移除已验；未操作真实用户目录切换/卸载 |
| 外观/无障碍 | 9离屏+真实NSAlert此前主线通过、生产UI源码无变；键盘/AX不冒充VoiceOver发声 |
| 分发 | f017 arm64 ad-hoc包、DMG搬移运行通过；正式签名/公证/Gatekeeper及CI runner未验 |

## 原件与保留

f017归档位于规划库 `Magic Code/验证/常驻App与状态栏/native/20260929-f0172b0/`；逐SHA复制必要日志/JSON/PTY/xcresult/输入与身份材料，不覆盖c78或native-review。二进制/App/DMG保留worktree，以manifest绝对路径/hash指向，不把数GB中间产物复制至规划库。

本轮Bun暂存 `.a83d3e4a0c67a7d4-00000000.bun-build` 与已知Bun runtime临时文件SHA相同，核无构建在途/lsof占用后只清本轮文件，证据 `f017-bun-build-cleanup.json`。旧清理记录和所有失败反例继续保留。没有stage/commit/push/merge，不清工作树，不增加U100依赖。
