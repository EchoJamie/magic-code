import XCTest
import AppKit
import Combine
import SwiftUI
import UserNotifications

final class NativeTests: XCTestCase {
    private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
    override func setUpWithError() throws {
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".artifacts/macos/seams"), withIntermediateDirectories: true)
    }
    private func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("native-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func fixture(_ name: String) throws -> Data {
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("tests/fixtures/native-wire/\(name).json"))) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: raw["message"]!)
    }
    private func work() throws -> NativeWork {
        if case .welcome(_, let projection) = try JSONDecoder().decode(NativeResponse.self, from: fixture("welcome")) { return try XCTUnwrap(projection.works.first) }
        throw WireError.invalid("fixture 没有工作")
    }
    private func changed(_ work: NativeWork, _ changes: [String: Any]) throws -> NativeWork {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(work)) as? [String: Any])
        changes.forEach { object[$0.key] = $0.value }
        return try JSONDecoder().decode(NativeWork.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testSharedFixturesDecodeAndRoundTrip() throws {
        let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("tests/fixtures/native-wire"), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        XCTAssertGreaterThanOrEqual(files.count, 37)
        for file in files {
            let row = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            let data = try JSONSerialization.data(withJSONObject: row["message"]!)
            let roundTrip: () throws -> Data = {
                func recode<T: Codable>(_ type: T.Type) throws -> Data { try JSONEncoder().encode(JSONDecoder().decode(type, from: data)) }
                switch row["family"] as! String {
                case "NativeRequest": return try recode(NativeRequest.self)
                case "NativeResponse": return try recode(NativeResponse.self)
                case "HostRequest": return try recode(HostRequest.self)
                case "HostResponse": return try recode(HostResponse.self)
                case "HostDiscovery": return try recode(HostDiscovery.self)
                default: throw WireError.invalid("未知 fixture family")
                }
            }
            if row["valid"] as! Bool {
                XCTAssertEqual(try JSONSerialization.jsonObject(with: roundTrip()) as? NSDictionary, row["message"] as? NSDictionary, file.lastPathComponent)
            } else { XCTAssertThrowsError(try roundTrip(), file.lastPathComponent) }
        }
    }
    func testJSONLinesPartialUTF8AndMultipleFrames() throws {
        let payload = Data("{\"t\":\"native.error\",\"reason\":\"中文\"}\n{\"t\":\"native.refresh\"}\n".utf8)
        var reader = JSONLines(); var lines: [Data] = []
        for byte in payload { lines += try reader.append(Data([byte])) }
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(try JSONDecoder().decode(NativeResponse.self, from: lines[0]), .error(reason: "中文"))
    }
    func testPublicationLockPrivacyAndGenerationRemoval() throws {
        let directory = try temp().appendingPathComponent("runtime")
        let first = HostPublication(directory: directory); try first.acquire()
        let second = HostPublication(directory: directory); XCTAssertThrowsError(try second.acquire())
        let discovery = try JSONDecoder().decode(HostDiscovery.self, from: fixture("discovery"))
        try first.publish(discovery)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: first.file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        first.remove(host: "some-other-host"); XCTAssertTrue(FileManager.default.fileExists(atPath: first.file.path))
        first.remove(host: discovery.hostInstance, service: discovery.serviceInstance)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.file.path))
    }
    func testStableGroupsAndRecentTen() throws {
        let initial = try work(); var list = WorkList()
        let recent = try (0..<14).map { try changed(initial, ["session": "r\($0)", "state": "idle", "affected": false, "notices": [], "since": $0]) }
        list.update([initial] + recent, interacting: false)
        XCTAssertEqual(list.rows(.recent, works: [initial] + recent).count, 10)
        let updated = try changed(initial, ["state": "running", "since": 999, "notices": []])
        list.update([updated] + recent, interacting: true)
        XCTAssertEqual(list.rows(.needsYou, works: [updated] + recent).first?.state, .running)
        list.update([updated] + recent, interacting: false)
        XCTAssertTrue(list.rows(.needsYou, works: [updated] + recent).isEmpty)
        XCTAssertEqual(list.rows(.running, works: [updated] + recent).first?.id, initial.id)
    }
    func testNotificationCoalescingPriorityAndStableIDs() throws {
        let first = try work(); let notice = try XCTUnwrap(first.notices.first)
        var batch = NoticeBatch(); batch.add(work: first, notice: notice); batch.add(work: first, notice: notice)
        let deliveries = batch.take(dataDir: "/tmp/data")
        XCTAssertEqual(deliveries.count, 1); XCTAssertEqual(deliveries[0].ids, [notice.id])
        XCTAssertTrue(deliveries[0].body.contains("答复")); XCTAssertFalse(deliveries[0].body.contains(notice.detail!))
        XCTAssertTrue(batch.pending.isEmpty)
        let done = AttentionItem(id: "done-one", session: first.session, kind: .done, at: 1, detail: nil, unread: true, delivered: false, fact: "event:1")
        let second = try changed(first, ["session": "second"])
        let done2 = AttentionItem(id: "done-two", session: second.session, kind: .done, at: 2, detail: nil, unread: true, delivered: false, fact: "event:2")
        batch.add(work: first, notice: done); batch.add(work: second, notice: done2)
        let summary = batch.take(dataDir: "/tmp/data")
        XCTAssertEqual(summary.count, 1); XCTAssertEqual(summary[0].routes.count, 2); XCTAssertEqual(Set(summary[0].ids), [done.id, done2.id])
    }
    func testCommandPreservesArgumentsAndWorkspace() throws {
        let room = try temp(); let workspace = room.appendingPathComponent("项目 ' $() 空格")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let helper = room.appendingPathComponent("helper ' name")
        try PrivateFiles.write(Data("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$MAGIC_HOME\" \"$@\"\n".utf8), to: helper, mode: 0o700)
        let session = "session '; echo injected; #"
        let command = TerminalCommand.make(helper: helper, workspace: workspace, base: room, session: session, request: "open-id")
        let process = Process(); let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh"); process.arguments = ["-c", command]; process.standardOutput = output
        try process.run(); process.waitUntilExit()
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(text.split(separator: "\n").map(String.init), [workspace.path, room.path, "--session", session, "--open-request", "open-id"])
    }
    @MainActor func testTerminalNeedsMatchingAttachmentAndDeduplicates() throws {
        let root = try temp(); let launcher = TerminalLauncher(directory: root.appendingPathComponent("terminal"))
        var opened: [URL] = []; launcher.openFile = { url, completion in opened.append(url); completion(nil) }
        for _ in 0..<2 { launcher.open(helper: root.appendingPathComponent("helper"), workspace: root, base: root, session: "session-one") }
        XCTAssertEqual(opened.count, 1)
        let pending = try XCTUnwrap(launcher.pending["session-one"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: pending.file.path))
        launcher.attached(request: pending.request, session: "wrong"); XCTAssertEqual(launcher.pending.count, 1)
        launcher.attached(request: pending.request, session: pending.session)
        XCTAssertTrue(launcher.pending.isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: pending.file.path))
        launcher.open(helper: root.appendingPathComponent("helper"), workspace: root, base: root, session: "session-one")
        XCTAssertEqual(opened.count, 2)
    }
    @MainActor func testTerminalValidationCommandIsolatesHomeAndKeepsTTY() throws {
        let room = try temp(); let launcher = TerminalLauncher(directory: room.appendingPathComponent("commands"))
        launcher.validationHome = room
        let helper = room.appendingPathComponent("helper")
        let received = room.appendingPathComponent("received")
        let script = "#!/bin/zsh -f\n[[ -t 0 ]] || exit 4\n[[ -z \"$FAKE_SECRET\" ]] || exit 5\nprintf '%s\\n' \"$HOME\" \"$MAGIC_HOME\" \"$PWD\" \"$@\" > \(TerminalCommand.quote(received.path))\n"
        try PrivateFiles.write(Data(script.utf8), to: helper, mode: 0o700)
        var file: URL?; launcher.openFile = { url, done in file = url; done(nil) }
        launcher.open(helper: helper, workspace: room, base: room, session: "isolated-session")
        let pending = try XCTUnwrap(launcher.pending.values.first)
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/script")
        process.arguments = ["-q", room.appendingPathComponent("outer-tty.log").path, "/bin/zsh", "-f", try XCTUnwrap(file).path]
        process.environment = ["HOME": "/does-not-contain-user-data", "MAGIC_HOME": "/wrong-base", "FAKE_SECRET": "must-not-propagate", "PATH": "/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit(); XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(try String(contentsOf: received, encoding: .utf8).split(separator: "\n").map(String.init),
                       [room.path, room.path, room.path, "--session", "isolated-session", "--open-request", pending.request])
        XCTAssertEqual(try String(contentsOf: room.appendingPathComponent("terminal-evidence/\(pending.request)/exit-code"), encoding: .utf8), "0\n")
        XCTAssertTrue(launcher.attached(request: pending.request, session: "isolated-session"))
    }
    func testCLIConflictAndOwnedRemoval() throws {
        let root = try temp(); let helper = root.appendingPathComponent("App.app/Contents/Helpers/magic-runtime"); let link = root.appendingPathComponent("bin/magic")
        try CLIInstallation.install(helper: helper, at: link, app: root.appendingPathComponent("App.app"))
        try CLIInstallation.install(helper: helper, at: link, app: root.appendingPathComponent("App.app"))
        XCTAssertThrowsError(try CLIInstallation.install(helper: root.appendingPathComponent("other"), at: link, app: root.appendingPathComponent("Other.app")))
        try CLIInstallation.remove(link: link, helper: root.appendingPathComponent("other")); XCTAssertTrue(try CLIInstallation.belongs(link, helper: helper))
        try CLIInstallation.remove(link: link, helper: helper); XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: link.path))
        XCTAssertThrowsError(try CLIInstallation.install(helper: helper, at: link, app: URL(fileURLWithPath: "/Volumes/Magic Code/App.app")))
    }
    @MainActor func testSignedHelperNativeHandshakeInspectAndShutdown() async throws { try await hostRoundTrip(eof: false) }
    @MainActor private func controlledModel(options: [String: Any], timeout: TimeInterval = 15) throws -> (AppModel, URL) {
        let room = try temp(); let app = room.appendingPathComponent("Controlled.app")
        let helper = app.appendingPathComponent("Contents/Helpers/magic-runtime")
        try PrivateFiles.write(Data(contentsOf: root.appendingPathComponent("apps/macos/MagicCodeTests/Fixtures/controlled-helper.py")), to: helper, mode: 0o700)
        let plist: [String: Any] = ["CFBundleIdentifier": "com.magiccode.controlled.dev", "CFBundleShortVersionString": "0.0.0", "CFBundleExecutable": "unused", "CFBundlePackageType": "APPL", "MagicProtocolVersion": 1]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        try JSONSerialization.data(withJSONObject: options).write(to: room.appendingPathComponent("control.json"))
        let model = AppModel(appURL: app, validationRoot: room, notificationPort: NotificationCoordinator(send: { _ in XCTFail("不得发系统通知") }), shutdownTimeout: timeout)
        return (model, room)
    }
    @MainActor private func eventually(_ condition: () -> Bool, seconds: Double = 5, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "没有观察到所需事实", file: file, line: line)
    }
    private func traces(_ room: URL) -> [[String: Any]] {
        guard let text = try? String(contentsOf: room.appendingPathComponent("trace.jsonl"), encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
    private func observerCommand(_ room: URL, _ command: [String: Any]) throws {
        try JSONSerialization.data(withJSONObject: command).write(to: room.appendingPathComponent("observer-command.json"), options: .atomic)
    }
    @MainActor private func welcomeBarrier(_ model: AppModel, _ room: URL) throws {
        // This pending Terminal collector request is only a FIFO receive barrier;
        // no actual CLI/session is created by the controlled helper.
        model.terminal.open(helper: model.helperURL, workspace: room, base: room, session: "welcome-barrier")
        let request = try XCTUnwrap(model.terminal.pending["welcome-barrier"])
        try JSONSerialization.data(withJSONObject: ["request": request.request, "session": "welcome-barrier"])
            .write(to: room.appendingPathComponent("welcome-barrier.json"), options: .atomic)
    }
    @MainActor func testAppModelSameRevisionWelcomeRecoversWithoutNewHost() async throws {
        let (model, room) = try controlledModel(options: ["revision": 7, "notice": true, "observerControl": true])
        var states: [String] = []; let token = model.$phase.sink { states.append(String(describing: $0)) }; defer { token.cancel() }
        model.terminal.openFile = { _, completion in completion(nil) }
        model.start(); try await eventually { model.isCurrent }
        let identity = try XCTUnwrap(model.identity); let original = model.projection
        try welcomeBarrier(model, room)
        model.refreshAfterWake(); XCTAssertEqual(model.phase, .starting)
        try await eventually { model.terminal.pending["welcome-barrier"] == nil }
        XCTAssertEqual(model.phase, .ready, "同连接 welcome 后的匹配 attached 已被 AppModel 处理，应恢复 ready")
        XCTAssertEqual(model.projection, original)
        try welcomeBarrier(model, room)
        try observerCommand(room, ["disconnect": true])
        try await eventually { if case .fault = model.phase { return true }; return false }
        model.notifications.openRoutes?([NoticeRoute(dataDir: identity.dataDir, session: "session-completed", ids: ["notice-completed"], facts: ["event:1"])])
        try await eventually { model.terminal.pending["welcome-barrier"] == nil }
        XCTAssertEqual(model.phase, .ready, "故障自动重连的 welcome 后匹配 attached 已处理，应恢复 ready")
        if model.isCurrent { try await eventually { model.terminal.pending["session-completed"] != nil } }
        try welcomeBarrier(model, room)
        try observerCommand(room, ["disconnect": true])
        try await eventually { if case .fault = model.phase { return true }; return false }
        model.retry()
        try await eventually { model.terminal.pending["welcome-barrier"] == nil }
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.identity, identity); XCTAssertEqual(model.projection, original)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "cmd" })
        var finished = false; model.requestQuit { finished = true }; if model.showQuitConfirmation { model.confirmQuit() }; try await eventually { finished }
        try JSONSerialization.data(withJSONObject: ["states": states, "trace": traces(room)], options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/reconnect.json"))
    }
    @MainActor func testAppModelWelcomeKeepsNewerProjectionAndRejectsWrongService() async throws {
        let (model, room) = try controlledModel(options: ["revision": 7, "observerControl": true])
        model.start(); try await eventually { model.isCurrent }
        let identity = try XCTUnwrap(model.identity)
        try observerCommand(room, ["message": ["t": "native.projection", "projection": ["serviceInstance": identity.serviceInstance, "revision": 9, "accepting": false, "works": []]]])
        try await eventually { model.phase == .stopping }
        model.terminal.openFile = { _, completion in completion(nil) }
        try welcomeBarrier(model, room); model.refreshAfterWake()
        try await eventually { model.terminal.pending["welcome-barrier"] == nil }
        XCTAssertEqual(model.phase, .stopping)
        XCTAssertEqual(model.projection?.revision, 9); XCTAssertEqual(model.projection?.accepting, false)
        let encodedIdentity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(identity))
        try observerCommand(room, ["message": ["t": "native.welcome", "identity": encodedIdentity, "projection": ["serviceInstance": "another-service", "revision": 10, "accepting": true, "works": []]]])
        try await eventually { if case .fault = model.phase { return true }; return false }
        XCTAssertFalse(model.isCurrent); XCTAssertEqual(model.projection?.revision, 9)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        var finished = false; model.requestQuit { finished = true }; if model.showQuitConfirmation { model.confirmQuit() }; try await eventually { finished }
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/reconnect-negative.json"))
    }
    @MainActor func testPlainInspectDoesNotAcknowledgeUnpresentedNotices() async throws {
        let base = try work()
        func item(_ id: String, kind: NoticeKind) -> AttentionItem {
            AttentionItem(id: id, session: base.session, kind: kind, at: 1, detail: nil, unread: true, delivered: false, fact: "event:\(id)")
        }
        let historical = [item("historic-empty-answer", kind: .done), item("historic-failure", kind: .failed)]
        let arrived = item("arrived-after-inspect", kind: .done)
        let initial = try changed(base, ["state": "idle", "affected": false, "gen": NSNull(), "notices": JSONSerialization.jsonObject(with: JSONEncoder().encode(historical))])
        let returned = try changed(initial, ["notices": JSONSerialization.jsonObject(with: JSONEncoder().encode(historical + [arrived]))])
        let raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(initial))
        let response = try JSONSerialization.jsonObject(with: JSONEncoder().encode(returned))
        let (model, room) = try controlledModel(options: ["works": [raw], "inspectGate": true, "inspectWork": response])
        model.terminal.openFile = { _, completion in completion(nil) }
        model.start(); try await eventually { model.isCurrent }
        model.inspect(initial)
        try await eventually { self.traces(room).contains { $0["event"] as? String == "inspect-waiting" } }
        XCTAssertEqual(model.works.first?.notices.count, 2)
        try Data().write(to: room.appendingPathComponent("allow-inspect"))
        try await eventually { model.selected == initial.id }
        try await Task.sleep(for: .milliseconds(100))
        let reads = traces(room).compactMap { $0["message"] as? [String: Any] }.filter { $0["t"] as? String == "native.read" }
        try JSONSerialization.data(withJSONObject: ["trace": traces(room), "readRequests": reads], options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/plain-inspect-read.json"))
        XCTAssertTrue(reads.isEmpty, "普通详情没有逐项呈现历史事项，不能批量确认旧事项或回复前竞入事项")
        model.inspect(initial, open: true)
        try await eventually { model.terminal.pending[initial.session] != nil }
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.read" }, "终端尚未 attached 不能批量已读")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }
    @MainActor func testSpecificNoticeAcknowledgesOnlyRequestedIDAcrossRace() async throws {
        let base = try work()
        func item(_ id: String, session: String, detail: String?) -> AttentionItem {
            AttentionItem(id: id, session: session, kind: .done, at: 1, detail: detail, unread: true, delivered: false, fact: "event:\(id)")
        }
        let chosen = item("chosen-empty-answer", session: base.session, detail: "")
        let old = item("unopened-old-answer", session: base.session, detail: "旧答复")
        let arrived = item("arrived-after-request", session: base.session, detail: "新答复")
        func row(_ notices: [AttentionItem], session: String) throws -> NativeWork {
            try changed(base, ["session": session, "state": "idle", "affected": false, "gen": NSNull(), "notices": JSONSerialization.jsonObject(with: JSONEncoder().encode(notices))])
        }
        let initial = try row([chosen, old], session: base.session)
        let returned = try row([chosen, old, arrived], session: base.session)
        let other = try row([item("other-work-unread", session: "other-work", detail: "另一个工作")], session: "other-work")
        let works = try [initial, other].map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        let (model, room) = try controlledModel(options: ["systemTest": true, "works": works, "inspectGate": true, "inspectWork": JSONSerialization.jsonObject(with: JSONEncoder().encode(returned))])
        model.start(); try await eventually { model.isCurrent }
        model.panelVisibility(true)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.read" })
        model.inspect(initial, notice: chosen.id)
        try await eventually { self.traces(room).contains { $0["event"] as? String == "inspect-waiting" } }
        try Data().write(to: room.appendingPathComponent("allow-inspect"))
        try await eventually { model.works.first?.notices.first?.unread == false }
        XCTAssertEqual(model.selectedNotice?.id, chosen.id)
        XCTAssertEqual(Set(model.works.flatMap(\.notices).filter(\.unread).map(\.id)), [old.id, arrived.id, "other-work-unread"])
        let reads = traces(room).compactMap { $0["message"] as? [String: Any] }.filter { $0["t"] as? String == "native.read" }
        XCTAssertEqual(reads.count, 1); XCTAssertEqual(reads.first?["ids"] as? [String], [chosen.id])
        try JSONSerialization.data(withJSONObject: ["trace": traces(room), "persistentControl": JSONSerialization.jsonObject(with: Data(contentsOf: room.appendingPathComponent("control.json")))], options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/specific-notice-race.json"))
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }
    @MainActor func testSpecificNoticeRejectsMismatchedReturnedTarget() async throws {
        let base = try work(); let item = try XCTUnwrap(base.notices.first)
        for mismatch in ["work", "missing-notice", "notice-session"] {
            var changes: [String: Any] = [:]
            if mismatch == "work" { changes["session"] = "other-work" }
            if mismatch == "missing-notice" { changes["notices"] = [] }
            if mismatch == "notice-session" {
                var wrong = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(item)) as? [String: Any]); wrong["session"] = "other-work"; changes["notices"] = [wrong]
            }
            let response = try changed(base, changes)
            let (model, room) = try controlledModel(options: ["works": [JSONSerialization.jsonObject(with: JSONEncoder().encode(base))], "inspectGate": true, "uncheckedInspect": true, "inspectWork": JSONSerialization.jsonObject(with: JSONEncoder().encode(response))])
            try Data().write(to: room.appendingPathComponent("allow-inspect"))
            model.start(); try await eventually { model.isCurrent }
            model.inspect(base, notice: item.id)
            try await eventually { model.actionMessage != nil }
            XCTAssertNil(model.selectedNotice)
            XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.read" })
            var finished = false; model.requestQuit { finished = true }; if model.showQuitConfirmation { model.confirmQuit() }; try await eventually { finished }
            try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/notice-reject-\(mismatch).json"))
        }
    }
    @MainActor func testConfirmedHostExitRetriesOnlyFailedIntegrationRemoval() async throws {
        let (model, room) = try controlledModel(options: [:])
        let link = URL(fileURLWithPath: model.cliDirectory).appendingPathComponent("magic")
        try CLIInstallation.install(helper: model.helperURL, at: link, app: model.appURL)
        var attempts = 0; var finished = 0
        model.removeCLILink = { owned, helper in
            attempts += 1; print("integration-removal-attempt=\(attempts)")
            XCTAssertEqual(owned, link); XCTAssertEqual(helper, model.helperURL)
            if attempts == 1 { throw CocoaError(.fileWriteNoPermission) }
            try CLIInstallation.remove(link: owned, helper: helper)
        }
        model.start(); try await eventually { model.isCurrent }
        model.uninstallIntegration(onQuitRequest: { model.requestQuit { finished += 1 } })
        try await eventually { if case .fault(let text) = model.phase { return text.contains("系统集成移除失败") }; return false }
        XCTAssertEqual(attempts, 1); XCTAssertEqual(finished, 0); XCTAssertTrue(try CLIInstallation.belongs(link, helper: model.helperURL))
        model.retry(); XCTAssertEqual(attempts, 2); XCTAssertEqual(finished, 1)
        XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: link.path))
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "shutdown" }.count, 1)
        try JSONSerialization.data(withJSONObject: ["attempts": attempts, "cleanExitCallbacks": finished, "trace": traces(room)], options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/integration-removal-retry.json"))
    }
    @MainActor func testStoppedAcknowledgementWithExitOneNeverCompletesQuit() async throws {
        let (model, room) = try controlledModel(options: ["stop": "ack-crash"])
        var unconfirmed = 0; var finished = 0; model.onUnconfirmedShutdown = { unconfirmed += 1 }
        model.start(); try await eventually { model.isCurrent }
        model.requestQuit { finished += 1 }; try await eventually { unconfirmed > 0 }
        model.retry(); model.requestQuit { finished += 1 }
        XCTAssertEqual(finished, 0); XCTAssertFalse(model.isCurrent)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/stop-ack-exit-one.json"))
    }
    @MainActor func testAppModelRetriesSameStopAfterHostError() async throws { try await retryStop(reason: "error") }
    @MainActor func testAppModelRetriesSameStopAfterTimeout() async throws { try await retryStop(reason: "timeout") }
    @MainActor private func retryStop(reason: String) async throws {
        let (model, room) = try controlledModel(options: ["stop": reason, "gateExit": true], timeout: 0.15)
        var unconfirmed = 0; model.onUnconfirmedShutdown = { unconfirmed += 1 }
        model.start(); try await eventually { model.isCurrent }
        let identity = try XCTUnwrap(model.identity)
        var finished = 0
        model.requestQuit { finished += 1 }
        try await eventually { if case .fault = model.phase { return true }; return false }
        XCTAssertEqual(finished, 0); XCTAssertEqual(model.projection?.accepting, false); XCTAssertGreaterThan(unconfirmed, 0)
        model.refreshAfterWake()
        if case .fault = model.phase {} else { XCTFail("收尾责任未完成，唤醒不可重开准入") }
        if reason == "timeout" { model.requestQuit { finished += 1 } } else { model.retry() }
        try await eventually { self.traces(room).contains { $0["event"] as? String == "stopped-sent" } }
        XCTAssertEqual(finished, 0, "host.stopped 但进程未退出，不能报告退出完成")
        XCTAssertEqual(model.identity, identity); XCTAssertEqual(model.projection?.accepting, false)
        let requests = traces(room).filter { $0["event"] as? String == "shutdown" }.compactMap { ($0["message"] as? [String: Any])?["request"] as? String }
        XCTAssertEqual(requests.count, 2); XCTAssertEqual(Set(requests).count, 1)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        try Data().write(to: room.appendingPathComponent("allow-exit"))
        try await eventually { finished == 1 }
        XCTAssertFalse(FileManager.default.fileExists(atPath: model.publication.file.path))
        let evidence = root.appendingPathComponent(".artifacts/macos/appmodel-stop-\(reason).json")
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: evidence)
    }
    @MainActor func testUnconfirmedHostExitNeverBecomesCleanExit() async throws {
        let (model, room) = try controlledModel(options: ["stop": "crash"])
        var unconfirmed = 0; var finished = 0
        model.onUnconfirmedShutdown = { unconfirmed += 1 }
        model.start(); try await eventually { model.isCurrent }
        model.requestQuit { finished += 1 }
        try await eventually { unconfirmed > 0 }
        model.retry()
        model.systemQuit { finished += 1 }
        XCTAssertEqual(finished, 0)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        if case .fault = model.phase {} else { XCTFail("缺核销确认不可退出或重启") }
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/appmodel-stop-crash.json"))
    }
    @MainActor func testAppModelDefersNotificationThenInspectsProcessedItem() async throws {
        let (model, room) = try controlledModel(options: ["notice": true])
        var opened = 0; model.terminal.openFile = { _, completion in opened += 1; completion(nil) }
        model.notifications.openRoutes?([NoticeRoute(dataDir: room.appendingPathComponent("data").path, session: "session-completed", ids: ["notice-completed"], facts: ["event:1"])])
        XCTAssertNil(model.actionMessage); XCTAssertEqual(opened, 0)
        model.start(); try await eventually { opened == 1 }
        XCTAssertEqual(model.selected, "session-completed"); XCTAssertEqual(model.works.first?.state, .idle)
        let inspect = traces(room).filter { ($0["message"] as? [String: Any])?["t"] as? String == "native.inspect" }
        XCTAssertEqual(inspect.count, 1)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.stop" })
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/appmodel-notice-processed.json"))
    }
    @MainActor func testAppModelCrossInstanceNotificationNeverSwitchesOrOpens() async throws {
        let (model, room) = try controlledModel(options: ["notice": true])
        var opened = 0; model.terminal.openFile = { _, completion in opened += 1; completion(nil) }
        let route = NoticeRoute(dataDir: "/tmp/another-instance", session: "session-completed", ids: ["notice-completed"], facts: ["event:1"])
        model.openNotification(route)
        XCTAssertNil(model.actionMessage)
        model.start(); try await eventually { model.actionMessage?.contains("另一数据位置") == true }
        XCTAssertEqual(opened, 0); XCTAssertEqual(model.selectedBase, room)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.inspect" })
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/appmodel-notice-cross-instance.json"))
    }
    @MainActor func testAppModelRecoversCoreOnlyOnceWithoutReplayingWork() async throws {
        let (model, room) = try controlledModel(options: ["crash": true])
        model.start()
        try await eventually { if case .fault(let text) = model.phase { return text.contains("恢复失败") }; return false }
        let launches = traces(room).filter { $0["event"] as? String == "started" }
        XCTAssertEqual(launches.count, 2)
        let instances = launches.compactMap { ($0["identity"] as? [String: Any])?["hostInstance"] as? String }
        XCTAssertEqual(Set(instances).count, 2)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "cmd" })
    }
    @MainActor func testNotificationReconcilesSystemDeliveryAcrossRestart() async throws {
        let work = try work(); let notice = try XCTUnwrap(work.notices.first)
        let identity = ServiceIdentity(protocol: 1, version: "0.0.0", source: "/tmp/helper", hostInstance: "h", serviceInstance: "s", dataDir: "/tmp/data")
        var sent = 0; var delivered: [String] = []
        let notifications = NotificationCoordinator(send: { _ in sent += 1 }, existing: { [notice.id] })
        notifications.enabled = true; notifications.enabledSince = 0; notifications.delivered = { delivered += $0 }
        notifications.prepare(dataDir: identity.dataDir)
        await notifications.reconcile()
        notifications.observe(NativeProjection(serviceInstance: "s", revision: 1, accepting: true, works: [work]), identity: identity)
        try await Task.sleep(for: .milliseconds(2100))
        XCTAssertEqual(sent, 0); XCTAssertEqual(delivered, [notice.id])
    }
    @MainActor func testNativeFramesLightDarkBusyIdleAndFailure() async throws {
        _ = NSApplication.shared
        let first = try work()
        let busy = try [first,
            changed(first, ["session": "running", "state": "running", "action": "正在运行测试", "workspace": ["/tmp/另一个同名项目/项目"], "notices": []]),
            changed(first, ["session": "unknown", "state": "unknown", "action": "等待核对实际状态", "gen": NSNull(), "notices": []]),
            changed(first, ["session": "result", "state": "idle", "action": "结果可查看", "gen": NSNull(), "affected": false, "notices": []])]
        let raw = try busy.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        let (model, _) = try controlledModel(options: ["works": raw])
        model.start(); try await eventually { model.isCurrent }
        let directory = root.appendingPathComponent(".artifacts/macos/frames")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        func save(_ window: NSWindow, name: String) async throws {
            XCTAssertFalse(window.isVisible, "原生帧必须离屏，不弹出真实窗口")
            let view = try XCTUnwrap(window.contentView)
            try await Task.sleep(for: .milliseconds(250))
            view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: directory.appendingPathComponent(name + ".png"))
            XCTAssertGreaterThan(png.count, 2000)
            window.close()
        }
        func capture<V: View>(_ content: V, name: String, size: NSSize, appearance: NSAppearance.Name, exercise: ((NSWindow) async throws -> Void)? = nil) async throws {
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: appearance); window.isReleasedWhenClosed = false
            let controller = NSHostingController(rootView: content)
            controller.view.frame = NSRect(origin: .zero, size: size); window.contentViewController = controller
            try await Task.sleep(for: .milliseconds(250))
            if let exercise {
                window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
                window.orderBack(nil)
                defer { window.orderOut(nil) }
                XCTAssertLessThan(window.frame.maxX, 0, "访问测试窗口不得移到用户桌面")
                try await Task.sleep(for: .milliseconds(250))
                try await exercise(window)
            }
            try await save(window, name: name)
        }
        func scrollViews(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews)
        }
        func scrollBottom(_ window: NSWindow) throws -> NSScrollView {
            let scroll = try XCTUnwrap(scrollViews(try XCTUnwrap(window.contentView)).first { ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height })
            let height = try XCTUnwrap(scroll.documentView).bounds.height
            scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, height - scroll.contentView.bounds.height)))
            scroll.reflectScrolledClipView(scroll.contentView)
            return scroll
        }
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .light), name: "busy-light", size: NSSize(width: 360, height: 650), appearance: .aqua)
        model.selected = first.id
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .dark), name: "detail-dark", size: NSSize(width: 360, height: 650), appearance: .darkAqua)
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .dark), name: "detail-bottom-dark", size: NSSize(width: 360, height: 650), appearance: .darkAqua) { window in
            let scroll = try scrollBottom(window)
            try await Task.sleep(for: .milliseconds(100))
            let document = try XCTUnwrap(scroll.documentView)
            XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 1)
            try JSONSerialization.data(withJSONObject: ["scrollY": scroll.contentView.bounds.origin.y, "viewportBottom": scroll.contentView.bounds.maxY, "documentBottom": document.bounds.maxY, "evidence": "offscreen geometry only; real App AX and keyboard recorded separately"], options: [.prettyPrinted, .sortedKeys]).write(to: directory.deletingLastPathComponent().appendingPathComponent("scroll-status.json"))
        }
        let quitAlert = model.makeQuitAlert()
        XCTAssertEqual(quitAlert.buttons.map(\.title), ["取消", "停止并退出"])
        XCTAssertEqual(quitAlert.buttons.first?.keyEquivalent, "\r")
        XCTAssertEqual(quitAlert.buttons.last?.keyEquivalent, "")
        try await capture(QuitImpactList(affected: model.affected)
            .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .light),
            name: "quit-impact-list", size: NSSize(width: 360, height: 300), appearance: .aqua)
        model.notificationRoutes = busy.filter { $0.state != .unknown }.map {
            NoticeRoute(dataDir: model.identity!.dataDir, session: $0.session, ids: ["frame-\($0.session)"], facts: ["event:frame"])
        }
        try await capture(NoticeWindow(model: model).environment(\.colorScheme, .light), name: "notice-selection", size: NSSize(width: 420, height: 470), appearance: .aqua)
        model.phase = .fault("连接已断开，重试后核对当前状态。")
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .light), name: "failure", size: NSSize(width: 360, height: 540), appearance: .aqua)
        model.phase = .ready
        // The controlled helper owns no real work; use the normal stop responsibility.
        var finished = false; model.requestQuit { finished = true }; model.confirmQuit(); try await eventually { finished }
        let (idle, _) = try controlledModel(options: [:]); idle.start(); try await eventually { idle.isCurrent }
        try await capture(StatusPanel(model: idle).environment(\.colorScheme, .light), name: "idle", size: NSSize(width: 360, height: 260), appearance: .aqua)
        idle.cliDirectory = idle.userHome.appendingPathComponent("这是一个用于验证完整显示与复制的很长命令安装目录/还有一层中文目录/bin").path
        try await capture(SettingsView(model: idle).environment(\.colorScheme, .dark), name: "settings-dark", size: NSSize(width: 580, height: 680), appearance: .darkAqua)
        try await capture(SettingsView(model: idle).environment(\.colorScheme, .dark), name: "settings-bottom-dark", size: NSSize(width: 580, height: 680), appearance: .darkAqua) { window in
            let scroll = try scrollBottom(window)
            try await Task.sleep(for: .milliseconds(100))
            let document = try XCTUnwrap(scroll.documentView)
            XCTAssertEqual(scroll.contentView.bounds.maxY, document.bounds.maxY, accuracy: 1)
            var copied: String?; idle.terminal.copyText = { copied = $0 }
            idle.terminal.copy(idle.cliDirectory); XCTAssertEqual(copied, idle.cliDirectory)
            try JSONSerialization.data(withJSONObject: ["scrollY": scroll.contentView.bounds.origin.y, "viewportBottom": scroll.contentView.bounds.maxY, "documentBottom": document.bounds.maxY, "copiedPath": copied ?? "", "evidence": "offscreen geometry and copy port; real App AX recorded separately"], options: [.prettyPrinted, .sortedKeys]).write(to: directory.deletingLastPathComponent().appendingPathComponent("scroll-settings.json"))
        }
        var idleFinished = false; idle.requestQuit { idleFinished = true }; try await eventually { idleFinished }
    }
    /// 状态栏那一枚：三态判据只取投影事实与相位；深浅两张帧验品牌符号的 template 反色。
    @MainActor func testMenuBarMarkThreeStatesAndBothAppearances() async throws {
        _ = NSApplication.shared
        let first = try work()
        let (idle, _) = try controlledModel(options: [:])
        idle.start(); try await eventually { idle.isCurrent }
        XCTAssertEqual(idle.menuBarState, .idle, "没有工作就是空闲静态")

        let running = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            try changed(first, ["session": "running", "state": "running", "action": "正在运行测试", "notices": []])))
        let (active, _) = try controlledModel(options: ["works": [running]])
        active.start(); try await eventually { active.isCurrent }
        XCTAssertEqual(active.menuBarState, .active, "有受影响的工作就是执行中")

        let waiting = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try changed(first, ["notices": []])))
        let (attention, _) = try controlledModel(options: ["works": [waiting]])
        attention.start(); try await eventually { attention.isCurrent }
        XCTAssertEqual(attention.menuBarState, .attention, "等答复就是需要你")
        attention.phase = .fault("连接已断开，重试后核对当前状态。")
        XCTAssertEqual(attention.menuBarState, .attention, "异常也是注意标记，不新增第四态")

        // 硬要求：三态同画布宽。菜单栏项宽跟着图宽走，三态不同宽就会把相邻图标推来推去。
        let widths = Set([MenuBarState.idle, .active, .attention].map { MenuBarMark.image(for: $0).size.width })
        XCTAssertEqual(widths.count, 1, "三态必须同宽，实际 \(widths.sorted())")
        XCTAssertEqual(MenuBarMark.image(for: .idle).size.width, MenuBarMark.width)

        // 下面这套帧走的是跟产品同一条取图路径（`Bundle(for:)` 取的同一支 Assets.xcassets，
        // 测试 target 也挂着它）。别改回「测试自己从仓库注入一支文件」——那跟产品不是同一条路，
        // U103 那版「真机什么都不画」的缺陷就是这么被离屏帧放过去的。
        let directory = root.appendingPathComponent(".artifacts/macos/frames")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let states: [(MenuBarState, String)] = [(.idle, "空闲静态"), (.active, "有执行"), (.attention, "需要你或异常")]
        func row(_ appearance: NSAppearance.Name, name: String) async throws {
            let dark = appearance == .darkAqua
            let content = HStack(spacing: 30) {
                ForEach(Array(states.enumerated()), id: \.offset) { _, entry in
                    HStack(spacing: 6) {
                        MenuBarMark(state: entry.0)
                        Text(entry.1).font(.system(size: 12)).foregroundStyle(.primary)
                    }
                }
            }
            .padding(.horizontal, 16).frame(height: 24)
            .background(Color(white: dark ? 0.13 : 0.91))
            .environment(\.colorScheme, dark ? .dark : .light)
            let size = NSSize(width: 380, height: 24)
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: appearance); window.isReleasedWhenClosed = false
            let controller = NSHostingController(rootView: content)
            controller.view.frame = NSRect(origin: .zero, size: size); window.contentViewController = controller
            try await Task.sleep(for: .milliseconds(250))
            XCTAssertFalse(window.isVisible, "原生帧必须离屏，不弹出真实窗口")
            let view = try XCTUnwrap(window.contentView)
            view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: directory.appendingPathComponent(name + ".png"))
            XCTAssertGreaterThan(png.count, 2000)
            window.close()
        }
        try await row(.aqua, name: "u103-menu-bar-light")
        try await row(.darkAqua, name: "u103-menu-bar-dark")
    }
    @MainActor func testNotificationCollectorTwoSecondsAndReadCancellation() async throws {
        let first = try work()
        let identity = ServiceIdentity(protocol: 1, version: "0.0.0", source: "/tmp/helper", hostInstance: "h", serviceInstance: "s", dataDir: "/tmp/data")
        let now = Date().timeIntervalSince1970 * 1000
        func row(id: String, unread: Bool = true) throws -> NativeWork {
            let notice = AttentionItem(id: id, session: first.session, kind: .needsYou, at: now, detail: nil, unread: unread, delivered: false, fact: "event:\(id)")
            return try changed(first, ["notices": [JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))]])
        }
        var sent: [NoticeDelivery] = []; var acknowledged: [String] = []
        let notifications = NotificationCoordinator(send: { sent.append($0) })
        notifications.delivered = { acknowledged += $0 }
        notifications.observe(NativeProjection(serviceInstance: "s", revision: 1, accepting: true, works: [try row(id: "disabled")]), identity: identity)
        XCTAssertTrue(sent.isEmpty); XCTAssertTrue(acknowledged.isEmpty)
        notifications.enabled = true
        notifications.observe(NativeProjection(serviceInstance: "s", revision: 2, accepting: true, works: [try row(id: "first")]), identity: identity)
        try await Task.sleep(for: .seconds(1))
        XCTAssertTrue(sent.isEmpty, "两秒合并窗内不得提前投递")
        notifications.observe(NativeProjection(serviceInstance: "s", revision: 3, accepting: true, works: [try row(id: "first", unread: false)]), identity: identity)
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertTrue(sent.isEmpty, "明确已读应撤销尚未发出的提醒")
        notifications.observe(NativeProjection(serviceInstance: "s", revision: 4, accepting: true, works: [try row(id: "second")]), identity: identity)
        try await Task.sleep(for: .milliseconds(2100))
        XCTAssertEqual(sent.count, 1); XCTAssertEqual(acknowledged, ["second"])
        notifications.observe(NativeProjection(serviceInstance: "s", revision: 5, accepting: true, works: [try row(id: "second")]), identity: identity)
        XCTAssertEqual(sent.count, 1, "投递事实去重，不调用业务已读")
    }
    @MainActor func testLifetimeEOFNotHeldByOtherChild() async throws { try await hostRoundTrip(eof: true) }

    // MARK: U102 · 三条发现的判据（只调用修前已存在的 API，红必须是行为红）

    /// 系统验收身份下的模型：bundle 前缀/固定根/capability 都齐，两个开关才是可用的。
    @MainActor private func systemTestModel(allow: [String] = ["notifications", "login"],
                                            status: @escaping () async -> UNAuthorizationStatus,
                                            request: @escaping () async throws -> Bool = { true },
                                            options: [String: Any] = [:], legacyPreference: Bool? = nil,
                                            send: @escaping (NoticeDelivery) -> Void = { _ in }) throws -> (AppModel, URL) {
        let room = URL(fileURLWithPath: "/private/tmp/magic-system-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: room, withIntermediateDirectories: true)
        addTeardownBlock {
            // 偏好现在落在 room 里（见 `AppModel` 里 `defaults` 的构造），随房间一起删。
            // **这里不再去动真实 `~/Library/Preferences`**：U106 之前那两行是在跟 cfprefsd 的
            // **异步刷盘**赛跑——`removePersistentDomain` 加删文件都做了，守护进程照样在进程退出后
            // 把域名刷回来（实测跑一次 `check.sh` 仍漏 3 条）。改到根上：压根不在那儿建域。
            try? FileManager.default.removeItem(at: room)
        }
        let bundle = "com.magiccode.validation." + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() + ".dev"
        let app = room.appendingPathComponent("Magic Code 系统验收.app")
        let helper = app.appendingPathComponent("Contents/Helpers/magic-runtime")
        try PrivateFiles.write(Data(contentsOf: root.appendingPathComponent("apps/macos/MagicCodeTests/Fixtures/controlled-helper.py")), to: helper, mode: 0o700)
        let plist: [String: Any] = ["CFBundleIdentifier": bundle, "CFBundleShortVersionString": "0.0.0", "CFBundleExecutable": "unused",
                                    "CFBundlePackageType": "APPL", "MagicProtocolVersion": 1, "MagicSystemTestRoot": room.path]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        var control: [String: Any] = ["systemTest": true, "source": helper.path, "works": []]
        options.forEach { control[$0.key] = $0.value }
        try JSONSerialization.data(withJSONObject: control).write(to: room.appendingPathComponent("control.json"))
        try JSONSerialization.data(withJSONObject: ["bundle": bundle, "allow": allow]).write(to: room.appendingPathComponent("system-authorization.json"))
        // 旧版本才会存这份「App 自己的开没开」；本轮起 App 不许再读它。
        if let legacyPreference { UserDefaults(suiteName: "MagicCode.Validation.\(room.lastPathComponent)")?.set(legacyPreference, forKey: "notificationsEnabled") }
        let port = NotificationCoordinator(send: { delivery in send(delivery) }, status: status, request: request)
        return (AppModel(appURL: app, validationRoot: room, notificationPort: port, shutdownTimeout: 15), room)
    }

    /// 一条「刚发生」的未读事实（`at` 取当前时刻，才过得了启用时刻那道门）。
    @MainActor private func freshNoticeRow(_ id: String) throws -> [String: Any] {
        let notice = AttentionItem(id: id, session: "s-\(id)", kind: .done, at: Date().timeIntervalSince1970 * 1000, detail: nil,
                                   unread: true, delivered: false, fact: "event:\(id)")
        let work = try changed(try work(), ["session": "s-\(id)", "state": "idle", "affected": false,
                                             "notices": [JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))]])
        return try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(work)) as? [String: Any])
    }

    @MainActor private func pushWorks(_ works: [NativeWork], to room: URL) throws {
        let helper = room.appendingPathComponent("Magic Code 系统验收.app/Contents/Helpers/magic-runtime")
        let raw = try works.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        try JSONSerialization.data(withJSONObject: ["systemTest": true, "source": helper.path, "works": raw]).write(to: room.appendingPathComponent("control.json"))
    }

    @MainActor private func hostView<V: View>(_ content: V, size: NSSize, appearance: NSAppearance.Name) async throws -> NSWindow {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance); window.isReleasedWhenClosed = false
        let controller = NSHostingController(rootView: content)
        controller.view.frame = NSRect(origin: .zero, size: size); window.contentViewController = controller
        try await Task.sleep(for: .milliseconds(400))
        return window
    }

    private func switches(in window: NSWindow) -> [NSControl] {
        var found: [NSControl] = []
        func walk(_ view: NSView) {
            if let control = view as? NSControl, String(describing: type(of: control)).contains("Switch") { found.append(control) }
            view.subviews.forEach(walk)
        }
        if let content = window.contentView { walk(content) }
        return found
    }

    @MainActor private func saveFrame(_ window: NSWindow, name: String) async throws {
        let directory = root.appendingPathComponent(".artifacts/macos/frames")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let view = try XCTUnwrap(window.contentView)
        // 控件（开关）的新状态要等窗口被 order 进来才与平台视图同步；窗口始终停在屏幕外。
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
        window.orderBack(nil)
        defer { window.orderOut(nil) }
        XCTAssertLessThan(window.frame.maxX, 0, "验收窗口不得移到用户桌面")
        try await Task.sleep(for: .milliseconds(350))
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: directory.appendingPathComponent(name + ".png"))
        XCTAssertGreaterThan(png.count, 2000)
    }

    /// 五态表（设计正文·通知节）：偏好默认开；系统那一格**只在受阻时出现**，各带一条路。
    /// 表里「那一行出不出」只能看帧（harness 数不出 SwiftUI 子视图）；这里钉住可程序化的那半边。
    @MainActor func testPreferenceDefaultsOnAndSystemRowOnlyWhenBlocked() async throws {
        _ = NSApplication.shared
        var status: UNAuthorizationStatus = .notDetermined
        let (model, _) = try systemTestModel(status: { status })
        model.start(); try await eventually { model.isCurrent }
        XCTAssertTrue(model.notificationsEnabled, "「提醒我」默认开：没说不要就是要")
        let window = try await hostView(SettingsView(model: model), size: NSSize(width: 580, height: 680), appearance: .aqua)
        defer { window.close() }
        XCTAssertEqual(switches(in: window).count, 2, "两个开关：登录项与「提醒我」")
        // 五态各留一帧（表的五行）
        try await saveFrame(window, name: "u102-五态-开-未问过")
        status = .authorized; await model.notifications.refreshAuthorization(); try await Task.sleep(for: .milliseconds(250))
        try await saveFrame(window, name: "u102-五态-开-已允许")
        status = .denied; await model.notifications.refreshAuthorization(); try await Task.sleep(for: .milliseconds(250))
        try await saveFrame(window, name: "u102-五态-开-已拒绝")
        status = .provisional; await model.notifications.refreshAuthorization(); try await Task.sleep(for: .milliseconds(250))
        try await saveFrame(window, name: "u102-五态-开-静默送达")
        await model.setNotifications(false); try await Task.sleep(for: .milliseconds(250))
        try await saveFrame(window, name: "u102-五态-关-任意")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// 请求时机：偏好开、系统未问过 ⇒ **第一次真要提醒时**才请求（不是首次启动、也不是拨开关时必弹）。
    @MainActor func testFirstRealReminderAsksOnTheSpot() async throws {
        _ = NSApplication.shared
        var status: UNAuthorizationStatus = .notDetermined
        var requested = 0
        var sent: [NoticeDelivery] = []
        let (model, _) = try systemTestModel(status: { status }, request: { requested += 1; status = .authorized; return true },
                                             options: ["works": [try freshNoticeRow("first")]], send: { sent.append($0) })
        model.start(); try await eventually { model.isCurrent }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(requested, 0, "首次打开不弹权限框")
        try await Task.sleep(for: .seconds(2.4))
        XCTAssertEqual(requested, 1, "第一次真要提醒时就地请求一次（系统框只在第一次调用时出现）")
        XCTAssertEqual(sent.count, 1, "允许了就投出去")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// U105：**拨开「提醒我」而系统还没问过 ⇒ 就地请求**（设计正文·通知节总纲那一句）。
    /// 修前 `setNotifications` 只 `refreshAuthorization()`（读状态），从没调 `requester()`——
    /// 于是拨开关根本不请求。这条用例钉的就是这一下。
    @MainActor func testTurningTheReminderOnAsksTheSystemWhenItHasNotAsked() async throws {
        _ = NSApplication.shared
        var status: UNAuthorizationStatus = .notDetermined
        var requested = 0
        let (model, _) = try systemTestModel(status: { status }, request: { requested += 1; status = .authorized; return true })
        model.start(); try await eventually { model.isCurrent }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(requested, 0, "启动本身不许弹框（不是首次启动）")
        await model.setNotifications(true)
        XCTAssertEqual(requested, 1, "拨开而系统没问过 ⇒ 就地请求一次")
        await model.setNotifications(true)
        XCTAssertEqual(requested, 1, "系统已经问过 ⇒ 不重复弹框")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// U106 守门：**验证身份的偏好不许落到真实 `~/Library/Preferences`。**
    ///
    /// 修前（suite 名只用房间名）这条会红：pref 写到真实偏好目录里的
    /// `MagicCode.Validation.<房间名>.plist`，而读回用的新 suite 一个字也读不到。
    /// 修后（suite 名是「房间路径/MagicCode.Validation」）两边都对上。
    /// **两条断言要成对看**：只断言「真实偏好里没有文件」是**空过**（没写也会通过），
    /// 所以必须同时断言「值确实写在房间里那个 suite 上」。
    @MainActor func testValidationPreferencesStayInsideTheirRoom() async throws {
        _ = NSApplication.shared
        let (model, room) = try systemTestModel(status: { .authorized })
        model.start(); try await eventually { model.isCurrent }
        await model.setNotifications(false)          // 真写一次，别让这条断言空过
        let inRoom = UserDefaults(suiteName: "\(room.path)/MagicCode.Validation")!
        XCTAssertEqual(inRoom.object(forKey: "notificationsEnabled") as? Bool, false,
                       "偏好必须写在「房间路径/MagicCode.Validation」这个 suite 上")
        let leaked = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Preferences/MagicCode.Validation.\(room.lastPathComponent).plist")
        XCTAssertFalse(FileManager.default.fileExists(atPath: leaked.path),
                       "验证身份不许往真实偏好目录落文件：\(leaked.lastPathComponent)")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// 现场那一层：你正在看 ⇒ 不打断，且**不记 seen**（等你不看了它还在候选里）。
    @MainActor func testLookingAtTheAppSuppressesThenReleasesTheReminder() async throws {
        _ = NSApplication.shared
        var sent: [NoticeDelivery] = []
        let (model, room) = try systemTestModel(status: { .authorized }, send: { sent.append($0) })
        model.start(); try await eventually { model.isCurrent }
        model.notifications.userLooking = { true }
        try JSONSerialization.data(withJSONObject: ["systemTest": true, "works": [try freshNoticeRow("watched")]])
            .write(to: room.appendingPathComponent("control.json"))
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertTrue(sent.isEmpty, "你在看这一屏时不打断")
        model.notifications.userLooking = { false }
        try JSONSerialization.data(withJSONObject: ["systemTest": true, "works": [try freshNoticeRow("watched")]])
            .write(to: room.appendingPathComponent("control.json"))
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertEqual(sent.count, 1, "你不看了，它还在候选里")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// 偏好关 ⇒ 系统允许也不投（两个条件各归各的主）；拨开才开始投。
    @MainActor func testOurPreferenceOffMeansNoDeliveryEvenWhenSystemAllows() async throws {
        _ = NSApplication.shared
        var sent: [NoticeDelivery] = []
        let (model, room) = try systemTestModel(status: { .authorized }, send: { sent.append($0) })
        model.start(); try await eventually { model.isCurrent }
        await model.setNotifications(false)
        try JSONSerialization.data(withJSONObject: ["systemTest": true, "works": [try freshNoticeRow("off")]])
            .write(to: room.appendingPathComponent("control.json"))
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertTrue(sent.isEmpty, "我们没打算提醒：系统允许也不投")
        await model.setNotifications(true)
        try JSONSerialization.data(withJSONObject: ["systemTest": true, "works": [try freshNoticeRow("on")]])
            .write(to: room.appendingPathComponent("control.json"))
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertEqual(sent.count, 1, "拨开才投")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// 用户在系统设置里改了：投递门与界面都该自己跟上，不需要他回来再点一次。
    @MainActor func testForegroundRefreshFollowsSystemStatusWithoutAClick() async throws {
        _ = NSApplication.shared
        var status: UNAuthorizationStatus = .denied
        var sent: [NoticeDelivery] = []
        let (model, room) = try systemTestModel(status: { status }, send: { sent.append($0) })
        model.start(); try await eventually { model.isCurrent }
        await model.setNotifications(true)   // 我们这边是要提醒的（偏好开），只等系统放行
        status = .authorized
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await eventually { model.notifications.enabled }
        let notice = AttentionItem(id: "after-allow", session: "s-after", kind: .done, at: Date().timeIntervalSince1970 * 1000, detail: nil, unread: true, delivered: false, fact: "event:after-allow")
        let row = try changed(try work(), ["session": "s-after", "state": "idle", "affected": false,
                                           "notices": [JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))]])
        try pushWorks([row], to: room)
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertEqual(sent.count, 1, "系统一允许，新事实就该能送达，不需要用户再点")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// 守门：系统权限变化不得把此前积压的旧未读补发一遍（不是「一变就自动跟」）。
    @MainActor func testAllowingNotificationsNeverReplaysOlderUnreadNotices() async throws {
        _ = NSApplication.shared
        var status: UNAuthorizationStatus = .denied
        var sent: [NoticeDelivery] = []
        let old = AttentionItem(id: "before-allow", session: "s-old", kind: .done, at: Date().timeIntervalSince1970 * 1000, detail: nil, unread: true, delivered: false, fact: "event:before-allow")
        let row = try changed(try work(), ["session": "s-old", "state": "idle", "affected": false,
                                           "notices": [JSONSerialization.jsonObject(with: JSONEncoder().encode(old))]])
        let raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(row)) as? [String: Any] ?? [:]
        let (model, _) = try systemTestModel(status: { status }, options: ["works": [raw]], send: { sent.append($0) })
        model.start(); try await eventually { model.isCurrent }
        try await Task.sleep(for: .milliseconds(700))
        status = .authorized
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertTrue(sent.isEmpty, "系统允许那一刻之前的旧未读，不得被补发")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    /// 发现三：静默送达（provisional）与正常允许必须是两句不同的话——修前两者都是「系统已允许」。
    @MainActor func testAuthorizationTextDistinguishesQuietDelivery() async throws {
        _ = NSApplication.shared
        var status: UNAuthorizationStatus = .authorized
        let (model, _) = try systemTestModel(status: { status })
        model.start(); try await eventually { model.isCurrent }
        await model.notifications.refreshAuthorization()
        XCTAssertEqual(model.notifications.authorizationStatus, .authorized)
        let allowed = model.notifications.authorization
        let window = try await hostView(SettingsView(model: model), size: NSSize(width: 580, height: 680), appearance: .aqua)
        try await saveFrame(window, name: "u102-authorization-authorized")
        status = .provisional
        await model.notifications.refreshAuthorization()
        XCTAssertEqual(model.notifications.authorizationStatus, .provisional)
        let quiet = model.notifications.authorization
        XCTAssertNotEqual(quiet, allowed, "静默送达与正常允许不得显示成同一句")
        XCTAssertTrue(quiet.contains("静默"), "静默送达要说明只进通知中心、不弹横幅")
        try await saveFrame(window, name: "u102-authorization-provisional")
        window.close()
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    @MainActor private func hostRoundTrip(eof: Bool) async throws {
        let app = root.appendingPathComponent(".artifacts/macos/Magic Code.app"); let helper = app.appendingPathComponent("Contents/Helpers/magic-runtime")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: helper.path), "先运行 scripts/macos/build.sh")
        let room = try temp(); let process = HostProcess(); let observer = ObserverConnection()
        let ready = expectation(description: "host.ready"); let welcome = expectation(description: "native.welcome")
        let inspected = expectation(description: "read-only missing record"); let stopped = expectation(description: "host.stopped")
        let exited = expectation(description: "manager process exited"); let instance = UUID().uuidString
        var receivedReady = false; var receivedStopped = false
        process.received = { response in
            switch response {
            case .ready(let identity, let socket, let base, let config):
                XCTAssertEqual(identity.hostInstance, instance)
                XCTAssertEqual(URL(fileURLWithPath: identity.source).resolvingSymlinksInPath(), helper.resolvingSymlinksInPath())
                XCTAssertTrue(base.hasPrefix(room.path)); XCTAssertTrue(config.hasPrefix(room.path))
                receivedReady = true; ready.fulfill(); observer.connect(path: socket, identity: identity)
            case .stopped(let request):
                XCTAssertEqual(request, eof ? nil : "shutdown-test"); receivedStopped = true; stopped.fulfill()
            case .error(let reason): XCTFail(reason)
            }
        }
        observer.receive = { response in
            switch response {
            case .welcome(_, let projection):
                XCTAssertTrue(projection.works.isEmpty); XCTAssertTrue(projection.accepting); welcome.fulfill()
                observer.send(.inspect(request: "inspect-test", session: "absent", notice: nil))
            case .inspected(let request, let work, let error):
                XCTAssertEqual(request, "inspect-test"); XCTAssertNil(work); XCTAssertNotNil(error); inspected.fulfill()
            default: break
            }
        }
        process.exited = { code in XCTAssertEqual(code, 0); XCTAssertTrue(receivedStopped); exited.fulfill() }
        try process.start(helper: helper, app: app, instance: instance, base: room, home: room,
                          environment: ["HOME": room.path, "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"])
        defer { observer.close(); process.closeLifetime(); if process.process.isRunning { process.process.terminate() } }
        await fulfillment(of: [ready, welcome, inspected], timeout: 12); XCTAssertTrue(receivedReady)
        let unrelated = Process(); unrelated.executableURL = URL(fileURLWithPath: "/bin/sleep"); unrelated.arguments = ["10"]
        if eof { try unrelated.run() }
        defer { if unrelated.isRunning { unrelated.terminate(); unrelated.waitUntilExit() } }
        if eof { process.closeLifetime() } else { process.shutdown(request: "shutdown-test") }
        await fulfillment(of: [stopped, exited], timeout: 5)
        if eof { XCTAssertTrue(unrelated.isRunning, "另一个后代还活着，但不能持有宿主生命写端") }
        XCTAssertFalse(process.process.isRunning)
    }

    /// 记录真实策略调用序列的替身：`current` 回放最后一次，`apply` 追加一次。
    @MainActor private final class PolicySpy {
        private(set) var log: [NSApplication.ActivationPolicy] = []
        func install(_ policy: LongLivedWindows) {
            policy.current = { [weak self] in self?.log.last ?? .accessory }
            policy.apply = { [weak self] in self?.log.append($0) }
        }
    }
    @MainActor private func offscreenWindow(titled: String) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 220, height: 120),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = titled; window.isReleasedWhenClosed = false
        return window
    }

    /// 长期窗口在前台存在 ⇒ `.regular`（Dock 有图标、Cmd+Tab 切得到）；全部关掉 ⇒ 回 `.accessory`。
    /// 策略没变就不该再调一次——重复结算不是一次切换。
    @MainActor func testLongLivedWindowDrivesActivationPolicyBothWays() async throws {
        _ = NSApplication.shared
        let policy = LongLivedWindows(observing: false), spy = PolicySpy(); spy.install(policy)
        let window = offscreenWindow(titled: "设置")
        defer { window.orderOut(nil) }
        policy.register(window)
        XCTAssertTrue(spy.log.isEmpty, "只登记还不算「在前台存在」")
        window.orderBack(nil)
        policy.settle(reason: "appear")
        XCTAssertEqual(spy.log, [.regular], "长期窗口出现 ⇒ Dock 图标与 Cmd+Tab")
        policy.settle(reason: "again"); policy.settle(reason: "and-again")
        XCTAssertEqual(spy.log.count, 1, "策略已经对了就不再切（幂等）")
        window.close()
        policy.settle(reason: "close")
        XCTAssertEqual(spy.log, [.regular, .accessory], "长期窗口全部关掉 ⇒ 回菜单栏形态")
        XCTAssertEqual(policy.presentCount, 0)
    }

    /// 关掉设置窗口走的是 **order out**，不是 close：AppKit 不为它发通知，只有 `isVisible` 会变。
    /// 真出现、真 order out（台账里就该一条 regular、一条 accessory）。
    @MainActor func testOrderingOutTheSettingsWindowReturnsToAccessory() async throws {
        _ = NSApplication.shared
        let policy = LongLivedWindows.shared, spy = PolicySpy()
        let real = (policy.current, policy.apply); spy.install(policy)
        addTeardownBlock { policy.current = real.0; policy.apply = real.1 }
        let window = offscreenWindow(titled: "设置")
        window.contentViewController = NSHostingController(rootView: Color.clear.frame(width: 10, height: 10).background(LongLivedWindowMarker()))
        window.orderBack(nil)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(spy.log.last, .regular, "窗口出现 ⇒ Dock 图标与 Cmd+Tab")
        window.orderOut(nil)          // SwiftUI 的 Settings 窗口「关掉」就是这个
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(spy.log.last, .accessory, "窗口不在了 ⇒ 回菜单栏形态：图标不能留在 Dock 里")
        XCTAssertEqual(policy.presentCount, 0)
    }

    /// 反向判据：没有长期窗口时，一扇**没登记**的窗口出现（菜单栏那块瞬时面板就是这种口径）不该改策略。
    /// 面板每点一次就切一次，正是「Dock 图标闪一下」的来源。
    @MainActor func testUnregisteredTransientWindowLeavesPolicyAlone() async throws {
        _ = NSApplication.shared
        let policy = LongLivedWindows(observing: false), spy = PolicySpy(); spy.install(policy)
        let panel = offscreenWindow(titled: "菜单栏面板")
        defer { panel.orderOut(nil) }
        panel.orderBack(nil)
        for reason in ["didBecomeKeyNotification", "didBecomeMainNotification", "didChangeOcclusionStateNotification"] { policy.settle(reason: reason) }
        XCTAssertTrue(spy.log.isEmpty, "瞬时面板不是长期窗口：不为它切策略")
        XCTAssertEqual(policy.presentCount, 0)
    }

    /// 设置窗口那一侧的接线：内容里挂 `LongLivedWindowMarker` 的窗口，出现即登记 ⇒ 切 `.regular`。
    /// 真窗口 ＋ 真托管视图；策略闭包换成替身，不动测试进程自己的策略。
    @MainActor func testSettingsMarkerRegistersItsWindow() async throws {
        _ = NSApplication.shared
        let policy = LongLivedWindows.shared, spy = PolicySpy()
        let real = (policy.current, policy.apply); spy.install(policy)
        addTeardownBlock { policy.current = real.0; policy.apply = real.1 }
        let window = offscreenWindow(titled: "设置")
        window.contentViewController = NSHostingController(rootView: Color.clear.frame(width: 10, height: 10).background(LongLivedWindowMarker()))
        XCTAssertEqual(policy.presentCount, 0, "窗口还没出现")
        window.orderBack(nil)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(spy.log.last, .regular, "设置窗口出现 ⇒ Dock 图标与 Cmd+Tab")
        window.close()
        policy.settle(reason: "close")
        XCTAssertEqual(spy.log.last, .accessory, "关掉设置窗口 ⇒ 回菜单栏形态")
        window.orderOut(nil)
    }
}
