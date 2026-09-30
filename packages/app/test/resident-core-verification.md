# 常驻宿主运行核心验证

日期：2026-09-26。分支：`feat/resident-macos-app`。权威：Magic Code/设计/常驻App与状态栏.md 及本次冻结契约。

范围：run-manager / executor / resume / stop / owned / facts / wire / runs，必要夹具及 U86/U98 证据装置。保留他人已修改的 run-executor hello 身份和 manager 常驻判据。不改生产、run-terminal、root 新测试、records、Swift、contracts；不提交或合并。

## 静态旧判据与修订依据

| 位置 | 旧判据 | 目标判据及保留保护 |
| --- | --- | --- |
| run-executor / run-runs / run-stop | session.open / list 会起执行者 | 观察只读；需要执行者时先选会话，再明确 input.submit；mock launcher 不触发真实模型 |
| run-executor | 空闲 watcher 保持执行者；随后 manager 空闲退出 | 空闲执行资源释放，逻辑 Session 保留；manager 等宿主退出；下一次明确输入沿同 Session 起新代 |
| run-executor | 以 session.list 验旧代次拒绝 | 用实际执行输入验旧代次拒绝，不把只读目录当作执行指令 |
| run-resume | 完成后窗口开着仍保留 1 个执行者 | 在途时恰好 1 个；完成后 0 个；历史查看不重跑，模型调用数不增 |
| run-stop | 窗口连接即抑制通知且不留未读 | TUI 无可靠焦点证据默认不抑制；保留不向对话广播通知、每事实去重、默认静默 |
| run-stop | hello 汇总一次即标已读 | 重连和汇总仍有相同未读；仅具体事项确认标读，投递与已读独立 |
| run-stop / frames-u86-tui / u98-evidence | 读 notices.json 与 RunPaths.notices | 通过 RecordsStore.attention.list 导出事实；不扫描/迁移旧 JSON |
| run-wire / mocks | wire types 从实现模块取 | 类型权威使用 @magic/contracts；连接器提供 hello 身份 |

保留：真实进程唯一性、故障隔离、停止受理与核销分离、TERM/KILL、PID 身份、断线续跑、快照缓冲水位与去重、审批只执行一次。不删失败用例，不加超时掩盖失败。U100 是另一独立需求，本责任不等待、不吸收。

## 执行记录

原始日志保留在 `/tmp/magic-resident-core-evidence/`。按主线最新授权，本责任已另行复制到规划库 `Magic Code/验证/常驻App与状态栏/core-tests/`；完整源路径、归档路径、大小和 SHA256 见该目录的 `manifest.json` / `manifest.tsv`，入口为 `README.md`。原件不删除。运行产生的隔离 HOME/数据与已确认归属的进程由测试清理，证据保留。

- 初始 stable 基线：manager / wire / owned / facts，35 pass / 0 fail，`baseline-stable.log`。
- mock 初轮：22 pass / 3 fail，`mock-first.log`。真实失败为回收重试；另外两项为夹具同步问题：通知先于合并投影推送，以及只读 id=0 投影混入持久事件。修订成等待对应投影、精确验证持久事件 `[early, later]`，未降低断言。
- 回收重试聚焦：1 pass，`reclaim-retry.log`；覆盖陌生组不误杀、首次退出不完成、组由创建者清理后重试真核销、旧备注消失。
- 跨进程时间反向证据：`owned-cross-process-before.log`，同一真实 PID 两进程解析相差 8 小时；主线修复后整组该例通过。
- 第三轮核心七套件：71 pass / 1 fail，`core-third.log`。唯一失败为后台回合 `turn.end` 与 `agent.state(waiting)` 的中间 action；等待屏障改为明确后台 action 后，`executor-switch-retest.log` 1 pass。
- 新增 facts 判据：后台责任非零仍 running、归零 idle；执行者已退但回收中 stopping / 回收失败 unknown / 核销后 stopped，holds 与 refresh 后状态一致。
- 新增 `run-host-active.test.ts` 补 root 空闲宿主测试未覆盖的有责生命链：受控模型产生真实待答后，分别 `host.shutdown` 与 stdin EOF；两例通过，核对真实 executor PID、manager PID、客户端断开、socket 删除及 `host.stopped`，见 `host-active.log`。该文件不修改 root 的 host-runtime/resident-manager 测试。
- 真后台自然完成：模型首轮结束仍 running；命令结束通知按既有业务进入同 Session，第三次模型调用处理结束回执，然后资源实际释放。此调用与历史查看重跑严格区分。
- 真 PTY resume 初轮：0 pass / 3 fail，`resume-first.log`。额外空白执行者为生产缺口；纯读观察适配落地后，`resume-retest.log` 3 pass / 0 fail / 20 断言。总 spawn 次数与实际模型请求数均精确验证，不能误起空白代后回收假绿。每轮帧与宿主日志保留于日志打印的 `magic-u49-*-runs-*` 目录。
- U98 真宿主证据装置通过：`u98-first.log` 和 `u98/`。failed attention 由记录端口导出，270 次进程取样未见通知外发，宿主 `host.stopped` 与 0 退出码成立。未执行 `--expect some` 历史代码反向场景。
- U86 初轮主要呈现/事项判据已过，最终 B 窗异常退出后残留待答卡，装置失败；`u86-first.log` 和 `u86/` 保留真实红证据。主线 detached / finishExecution 修复后全流程通过；新增明确撤卡断言后再验通过，最终 `u86-final.log` 与 `u86-final/00-B异常退出撤销待答.txt` 记录卡片失效、未执行及三个窗口自主退出。
- 全量类型检查最终通过：`typecheck-final-retest.log`，`bun run typecheck` / `tsc --noEmit`，退出码 0。共享源码中间态失败日志保留，未修改其他责任文件。责任范围 `git diff --check` 通过。
- 核心八套件最终复跑：`core-final-retest.log` **74 pass / 0 fail / 289 断言**，34.58 秒，包含 manager / executor / stop / owned / facts / wire / runs / host-active。前一轮 `core-final.log` 的 73 pass / 1 fail 保留：后台工具轮与后续文本轮各有一条 `turn.end`，原等待把第一条当作整次输入完成；修订为等两条 settled，仍精确断言后台在途时 2 次模型调用，后台结束回执处理后 3 次、实际 PID 退出。依据现有 conversation/loop 用例和运行事件，不以重跑偶绿结案。

真实执行者始终使用 loopback HTTP/SSE 模型、合成 key、隔离 HOME/base/data/workspace。核心与宿主待答夹具不批准 chmod；多窗审批用例仅在隔离工作区执行 `chmod 755 . && echo u49-只跑一次`；后台夹具只执行自有 sleep。`resident-host-fixture.ts` 共用 CLI 负责人的 `publishHostDiscovery`，持有专用 stdin；输出宿主诊断、PID、就绪/退出消息并保留 evidence。额外记录 manager spawn 次数，防止误起执行者随后回收造成零进程假绿。

快照过滤最终仅排除 `id=0` 瞬时投影，不按事件种类排除持久事件；`snapshot-final.log` 聚焦通过，精确序列 `[early]` → `[early, later]` 保留。

## 生产缺口与复验

通过主线 Codex 线程报告，未操作 Herdr。生产修复由主线/相应负责人完成。

| 缺口 | 定位与证据 | 当前复验 |
| --- | --- | --- |
| 回收成功未清旧备注，退出只查旧备注 | manager.performReclaim/shutdown；`mock-first.log` | 已修，`reclaim-retry.log` 通过 |
| 真后台跨进程身份时间错 8 小时 | execution/groups.startTimeOf 的本地时区解析；`owned-cross-process-before.log`、`background-unconfirmed-runs.json` | 已修；跨进程及自然后台完成通过，切会话后台清理聚焦通过 |
| `/resume` 输入触发 skills.list 误起空白执行者 | shell.askSkills → manager 通用 spawn 路由；`resume-first.log` | 已修；`resume-retest.log` 三项通过，零瞬时执行者断言保留 |
| 执行者异常退出仍残留有效审批卡 | client detached 只清 gen/输出 line，B 窗仍 `y / n`；`u86-first.log` | 已修；U86 全流程复验通过，并补明确撤卡帧判据 |

## 清理与证据

首次回收失败的测试已按原超时失败并退出，未停止测试来提前回报。跨时区失败留下的 sleep 先用 PID/PGID/启动时间及 lsof cwd 确认归属：前轮 48836 已自然退出，本轮 53231 由本责任 TERM 清理；`background-owned-cleanup.json` 记实际结果。首次 mock 与 switch 失败沙地按 manager.json 中本次测试 PID（46730/52848）核对，确认进程不存在且 lsof 无占用后删除；原始 runs 复制至证据目录，见 `failed-sandbox-cleanup.json`。未操作别人的测试或用户进程。

最终 `host-cleanup-audit.json` 逐份核对 16 份宿主证据：均为退出码 0、已收到 `host.stopped`，对应 PID 不存在，实际隔离数据目录与 socket 均已清理。证据目录内的数据库为装置复制的留证快照，予以保留。最终进程筛查未见本责任命名的执行进程残留；未按名称扫杀任何进程。

## 验证边界

本责任最终通过：八套核心 74 项、resume 真 PTY 3 项、U86/U98 证据装置；全部已报生产缺口均经主线修复后复验。U53 / run-terminal 由 CLI 负责人验证与交接，本责任未修改该文件。

本责任的单元、真实核心子进程与受控模型/PTY 证据分别记录。它们不等于签名 App、系统通知、登录项或发行验收。


## 追加责任：工具中间轮与完成事项

本段为主线新增 `turn.end.continues?: true` 后的独立追加，不改变前轮原始证据。新增授权范围包括 conversation/test 的独立预期、app/test/smoke.test.ts、allow-all-wire.test.ts，以及后续 UI 驱动设施。生产文件始终由主线修改。

- `run-executor` 新增真实链路：loopback HTTP/SSE 模型 → 真执行者 → 真 `exec echo resident-continues-tool-output` → 真 manager → RecordsStore.attention。工具实际返回一次且第二次模型请求收到结果；中间 `{ reason: settled, continues: true }` 到达时事项精确为空，最终 `{ reason: settled }` 后恰有一条 done，fact 精确等于最终事件 id，未读且未投递。最终真实 PID 退出。
- 通知端口替换为本测试内数组，实际通知调用为零；数组只用于验证最终一次、工具中间轮零次。`run-stop` 保留 needs-you / failed 与同事实重放去重原判据，并在中间工具轮明确断言仍只有 needs-you。纯协议 hello / 订阅不会标读。
- `conversation/test/loop.test.ts` 精确枚举中间与最终两个负载；中断、错误精确断言不带 continues。全套初轮 206 pass / 1 fail 是已确认纯读目录导出导致的旧 public-face 清单，补精确两项且保留内部实现不可导出的限制后，`continues-conversation-final.log` **207 pass / 0 fail / 697 断言**。
- 核心与真 PTY 九套件：`continues-core-final.log` **78 pass / 0 fail / 326 断言**，包括新增真实事项用例；`continues-typecheck.log` 全量类型检查通过。
- 根全量派回的旧预期：smoke 首工具轮加精确 continues:true；U73 明确 input.submit 才发车，hello 后零次、输入后恰一次，allowAll/switch 精确值保留。假 launcher 在收尾真实调用已登记的 onExit，不等一个无生命连接的假进程；不延长 5000ms 原超时。`continues-smoke-u73.log` **6 pass / 0 fail / 69 断言**。根全量时点仍由主线统一负责。

### 相反判据与现场

`continues-counterexample-preload.ts` 只在独立 bun test 进程的模块加载内存中，把 manager 的 `settled && !continues` 改为仅 settled；不写回生产文件，也不进入子执行者环境。同一真实模型/工具用例在 `continues-counterexample-final.log` 明确红在“中间事项应为空”，实际出现 `done:19`。失败由错误事项事实触发，不是超时；finally 仍核销并删除本轮隔离数据。加载源路径/hash 与精确变体记在 `continues-counterexample-source.json`。最初 CLI 参数放置导致 preload 未加载的运行单独存为 `continues-counterexample-launch-miss.log`，不作为反证。

正向现场例：`magic-continues-evidence-hAIOOK/trace.json` 中工具轮 id=19、continues=true、attention=[]；最终 id=33、无 continues、唯一 done 的 fact=33。相反现场 `magic-continues-evidence-P7g7IM/trace.json` 工具轮 id=19 就出现 done。目录的绝对路径均在对应原始日志，cleanup.json 记录沙地/socket/PID 均已清理。

### U86 自动已读反向证据

并行主线曾临时接入 render 自动 ack，`continues-u86/attention.json` 实测 done/needs-you/failed 的 unread 为 **false / false / true**，原三类汇总强断言失败，见 `continues-u86.log`。依规划纠正撤销自动 ack 后，本装置恢复并加强原判据：完成/待答/失败精确三项且全部 unread=true，新窗 hello/汇总后仍全未读；不广播正文、不跨会话收事项、异常后撤卡和正常退出保护保留。`continues-u86-no-ack.log` 与同名目录复验通过。本责任没有把 render 回调当可靠焦点证据，也未将这一真实失败直接改绿。

## 追加责任：UI 驱动的测试宿主

`ui/driver.ts` 的默认真实 CLI 场景复用 resident-host-fixture 持有专用 stdin 宿主，自证 command 探针不创建 App。驱动仅登记自己创建的宿主引用，同一外借沙地的并发窗口共用一份；最后一扇窗口关闭才核销。已有明确外部 owner 发布的发现记录时只连接，由真实 CLI 核对身份/存活，不替 owner 停止或覆盖记录。发布仍共用 CLI 的 publishHostDiscovery，没有新增第二个发现发布器。

启动失败与正常收尾都先退出自己的 CLI/核销宿主，再停自己模型服务、留档和清理自有沙地；外借沙地/模型由借出方管理。host.json / host.stderr.log 与 UI 的原始字节、帧、数据库快照一并保留。新增并发共享、外部 owner 不代关、宿主启动失败清理三个真实用例均通过，`ui-host-ownership.log` 3 pass / 23 断言；原按键与清理聚焦 `ui-host-focus.log` 2 pass。最终 `ui-host-suite.log` **40 pass / 0 fail / 331 断言**；显式宿主 `ui-host-resume.log` **3 pass / 0 fail / 20 断言**。TS 冻结后最后只读类型检查 `freeze-typecheck.log` 退出码 0。

## 冻结文件清单与验收出口

本责任最终为以下 **19 个文件（18 个 TS、1 个验证文档）**。TS 在 UI / resume 局部绿后冻结；本次仅续写文档和复制原证据，不做 Git 操作。已有他人改动保留；本清单不宣称独占其中此前由主线落下的改动。

```text
packages/app/test/allow-all-wire.test.ts
packages/app/test/frames-u86-tui.ts
packages/app/test/resident-attention-fixture.ts
packages/app/test/resident-core-verification.md
packages/app/test/resident-host-fixture.ts
packages/app/test/run-executor.test.ts
packages/app/test/run-facts.test.ts
packages/app/test/run-host-active.test.ts
packages/app/test/run-owned.test.ts
packages/app/test/run-resume.test.ts
packages/app/test/run-runs.test.ts
packages/app/test/run-stop.test.ts
packages/app/test/run-wire.test.ts
packages/app/test/smoke.test.ts
packages/app/test/u98-evidence.ts
packages/app/test/ui.test.ts
packages/app/test/ui/driver.ts
packages/conversation/test/loop.test.ts
packages/conversation/test/public-face.test.ts
```

`resident-cli-fixture.ts` 的 `publishHostDiscovery` 是只读共享依赖，归 CLI 负责人；未在本责任改写。`run-terminal.test.ts`、root 新宿主测试、生产和原生文件均不在此清单。

本责任验收出口：核心与 resume 九套 78 项、conversation 207 项、smoke/U73 6 项、UI 40 项、UI 改造后 resume 再验 3 项及 U86 原三类未读强判据均通过；这些批次存在覆盖重叠，不累加成根全量数字。U98 默认静默的原始过程也已归档。根全量、暂存快照质量门、提交及给 w3A:p3 的发布由主线统一处理。本责任没有宣称根全量通过，也不写全局矩阵、root `core/`、CLI 或 native 归档。

归档分布：`logs-and-direct/` 保留原始局部日志、直接 U86/U98 现场及红绿反例；`pty-and-host/` 保留日志明确指向的临时现场；`ui-runs/` 仅复制本轮 UI 聚焦/整套对应的真实 PTY 现场；`source-snapshot/` 是上述 19 个文件的冻结副本。原始帧、raw.bin、字节水位、模型请求、事项事实、host.ready / host.stopped / 退出码均按原样复制，不改写历史失败。归档清单逐文件验证源与目标 SHA256 相等。

最终只读清理核对 `freeze-cleanup-audit.json`：**64 份宿主记录中 62 份正常 host.stopped / 退出码 0，另 2 份是用例故意缺失入口造成的启动失败**；所有记录 PID 均不在进程表，实际隔离目录/socket 均已消失。82 份 UI 运行的实际 HOME 全部不存在；按本责任隔离沙地路径匹配的存活进程为 0。五份 continues 现场及各自 cleanup.json 一并留证；早期一份反例未记录 PID，最终补齐 PID 的反例已独立验证退出。该次核查未发送信号、未删除任何文件。证据内数据库是复制快照，原件与归档均保留。

真实测试边界：宿主 fixture 是 **测试 owner 持有 stdin 生命管道 + 同来源发布 helper**，启动真实 Bun manager/executor，验证回收、退出确认、发现记录与纯读连接规则。PTY 是本机真实终端通道，模型是隔离 loopback HTTP/SSE 装置；没有向外部正式模型请求，也没有发送正式系统通知。它们不代表原生 Swift App 窗口/菜单栏、原生通知呈现、签名、登录项或发行包已经验收。UI 自证中有意触发的失败现场仍按原样保留，不能把 artifact 的 `failed` 字段脱离对应通过的反向用例来解释。
