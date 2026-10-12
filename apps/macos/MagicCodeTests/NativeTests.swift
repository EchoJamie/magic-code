import XCTest
import AppKit
import Combine
import SwiftUI
import UserNotifications

final class NativeTests: XCTestCase {
    private func u126Snapshot() -> SettingsSnapshot {
        SettingsSnapshot(preview: .object([:]), configPath: "/fixture/config.json", base: "/fixture", stamp: "before",
            configuration: .object([
                "providers": .object([
                    "official": .object(["vendor": .string("fixture"), "name": .string("官方测试连接")]),
                    "locked": .object(["vendor": .string("fixture"), "protocol": .string("messages")]),
                    "local": .object(["baseURL": .string("http://localhost:8000/custom/v1"), "protocol": .string("responses"), "auth": .string("bearer")])
                ]),
                "models": .object(["default": .object(["provider": .string("official"), "model": .string("exact-model")])])
            ]), catalog: [], vendors: [.object([
                "vendor": .string("fixture"), "label": .string("测试供应商"),
                "regions": .array([.object(["id": .string("test"), "label": .string("测试区域"), "baseURL": .string("https://official.invalid/private-path")])]),
                "protocols": .array([
                    .object(["id": .string("chat-completions"), "label": .string("Chat Completions"), "models": .strings(["exact-model"])]),
                    .object(["id": .string("responses"), "label": .string("Responses"), "models": .strings(["exact-model"])]),
                    .object(["id": .string("messages"), "label": .string("Anthropic Messages"), "models": .strings(["other-model"])])
                ])
            ])], sources: [], grants: [], grantStamp: nil, grantProblem: nil)
    }

    @MainActor func testU126OfficialAutomaticProtocolSurvivesCredentialEditsAndReset() throws {
        let snapshot = u126Snapshot()
        let draft = SettingsDraft(providerFormValue(id: "official", snapshot: snapshot), stamp: snapshot.stamp)
        draft.put("name", .string("改名")); draft.put("apiKey", .string("fixture-secret"))
        let action = providerFormAction(draft.value)
        XCTAssertNil(action.object["protocol"], "改名或改密钥不得锁定自动协议")
        XCTAssertNil(action.object["baseURL"]); XCTAssertNil(action.object["auth"])
        XCTAssertTrue(action.validSettingsAction)
        draft.put("keyAction", .string("keep"))
        XCTAssertNil(providerFormAction(draft.value).object["keyAction"])
        XCTAssertEqual(modelProtocolName(provider: draft.value, model: "exact-model", vendors: snapshot.vendors), "Responses")
        XCTAssertEqual(modelProtocolName(provider: draft.value, model: "other-model", vendors: snapshot.vendors), "Anthropic Messages")
        XCTAssertTrue(modelProtocolName(provider: draft.value, model: "unknown-model", vendors: snapshot.vendors).hasPrefix("未知"))
        XCTAssertEqual(providerProtocolOptions(snapshot.vendors[0]).map { $0["id"].text }, ["responses", "messages", "chat-completions"])
        draft.put("protocol", .string("messages"))
        XCTAssertTrue(providerFormProblem(draft.value, snapshot: snapshot)?.contains("exact-model") == true)
        draft.put("protocol", .null, preserveNull: true)
        XCTAssertEqual(providerFormAction(draft.value).object["protocol"], .null)
        XCTAssertNil(providerFormProblem(draft.value, snapshot: snapshot))
        let data = try JSONEncoder().encode(providerFormAction(draft.value))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"protocol\":null"))
        XCTAssertEqual(providerFormValue(id: "locked", snapshot: snapshot)["protocol"], .string("messages"))
    }

    @MainActor func testU126CustomAuthenticationAddressAndWireValidation() {
        let snapshot = u126Snapshot()
        let draft = SettingsDraft(providerFormValue(id: "local", snapshot: snapshot), stamp: snapshot.stamp)
        XCTAssertEqual(draft.value["protocol"], .string("responses"))
        XCTAssertNil(providerFormAction(draft.value).object["vendor"])
        XCTAssertNil(providerFormAction(draft.value).object["region"])
        XCTAssertNil(providerFormProblem(draft.value, snapshot: snapshot))
        draft.put("baseURL", .string("http://192.168.1.10:9000/deployment/v2"))
        XCTAssertNotNil(providerFormProblem(draft.value, snapshot: snapshot))
        draft.put("apiKey", .string("new-service-secret"))
        XCTAssertNil(providerFormProblem(draft.value, snapshot: snapshot))
        draft.put("auth", .string("none"))
        XCTAssertNil(providerFormAction(draft.value).object["apiKey"])
        XCTAssertNil(providerFormProblem(draft.value, snapshot: snapshot))
        XCTAssertEqual(providerFormAction(draft.value)["baseURL"], draft.value["baseURL"])
        for protocolID in ["responses", "messages", "chat-completions"] {
            for auth in ["none", "bearer", "api-key"] {
                draft.put("protocol", .string(protocolID)); draft.put("auth", .string(auth))
                XCTAssertTrue(providerFormAction(draft.value).validSettingsAction)
            }
        }
        XCTAssertEqual(providerDefaultAuth("responses"), "bearer")
        XCTAssertEqual(providerDefaultAuth("messages"), "api-key")
        XCTAssertEqual(providerDefaultAuth("chat-completions"), "bearer")
        draft.put("protocol", .string("completions")); XCTAssertFalse(draft.value.validSettingsAction)
        draft.put("protocol", .null, preserveNull: true); draft.put("auth", .string("unknown")); XCTAssertFalse(draft.value.validSettingsAction)
        draft.put("baseURL", .string("file:///tmp/model")); XCTAssertNotNil(providerFormProblem(draft.value, snapshot: snapshot))
    }

    @MainActor func testU126ModelInformationPreservesUnknownAndDraftAcrossConflicts() {
        let drafts = SettingsDrafts(), initial: SettingsValue = .object([:])
        let draft = drafts.draft("override-local-原始型号", initial, stamp: "before")
        XCTAssertNil(modelInformationProblem(draft.value))
        draft.put("capabilities", .object(["image": .bool(false), "tools": .bool(true)]))
        draft.put("limits", .object(["maxInputTokens": .number(12000), "maxOutputTokens": .number(8000), "maxContextTokens": .number(16000)]))
        draft.put("reasoningSupport", .object(["disable": .bool(true), "levels": .strings(["low", "high"]), "budget": .object([:])]))
        XCTAssertNil(modelInformationProblem(draft.value), "输入与输出上限不相加推断联合窗口")
        let reopened = drafts.draft("override-local-原始型号", .object(["limits": .object(["maxInputTokens": .number(999)])]), stamp: "other-write")
        XCTAssertTrue(reopened === draft); XCTAssertEqual(reopened.stamp, "before")
        XCTAssertEqual(reopened.value["capabilities"]["image"], .bool(false))
        XCTAssertEqual(reopened.value["capabilities"]["tools"], .bool(true))
        XCTAssertEqual(reopened.value["capabilities"]["chat"], .null)
        XCTAssertEqual(reopened.value["reasoningSupport"]["budget"], .object([:]))
        for invalid: SettingsValue in [.number(0), .number(-1), .number(1.5), .string("abc"), .number(.infinity)] {
            draft.put("limits", .object(["maxInputTokens": invalid])); XCTAssertNotNil(modelInformationProblem(draft.value))
        }
        draft.put("limits", .null)
        draft.put("reasoningSupport", .object(["budget": .object(["minTokens": .number(200), "maxTokens": .number(100)])]))
        XCTAssertNotNil(modelInformationProblem(draft.value))
        draft.put("reasoningSupport", .null); XCTAssertNil(modelInformationProblem(draft.value))
        XCTAssertEqual(draft.value["limits"], .null)
        let action = SettingsValue.object(["type": .string("model.override"), "provider": .string("local"), "model": .string("原始型号/Case-Sensitive"), "override": draft.value])
        XCTAssertTrue(action.validSettingsAction); XCTAssertEqual(action["model"].text, "原始型号/Case-Sensitive")
    }

    @MainActor func testU126NativeEditorsRenderWithoutModelCalls() async throws {
        _ = NSApplication.shared
        let room = try temp(), snapshot = u126Snapshot(), drafts = SettingsDrafts()
        let model = AppModel(appURL: room.appendingPathComponent("NoHelper.app"), validationRoot: room,
                             notificationPort: NotificationCoordinator(send: { _ in XCTFail("设置不发送通知") }))
        func allViews(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(allViews) }
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for id in ["official", "local", ""] {
                let draft = SettingsDraft(providerFormValue(id: id, snapshot: snapshot), stamp: snapshot.stamp)
                if id == "local" { draft.put("auth", .string("none")) }
                let editor = ProviderEditor(model: model, snapshot: snapshot, drafts: drafts, draft: draft, id: id, close: {})
                let window = try await hostView(editor, size: NSSize(width: 580, height: 680), appearance: appearance)
                defer { window.close() }
                let view = try XCTUnwrap(window.contentView)
                view.layoutSubtreeIfNeeded()
                let fields = allViews(view).compactMap { $0 as? NSTextField }
                XCTAssertFalse(fields.contains { $0.stringValue.contains("official.invalid") })
                XCTAssertEqual(fields.contains { $0 is NSSecureTextField }, id.isEmpty, "新密钥使用隐藏输入，保留密钥及无需认证时不显示输入")
                if id == "local" { XCTAssertTrue(fields.contains { $0.stringValue == "http://localhost:8000/custom/v1" }) }
                let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
                view.cacheDisplay(in: view.bounds, to: bitmap)
                XCTAssertGreaterThan(try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).count, 2000)
                XCTAssertFalse(model.settingsBusy); XCTAssertNil(model.settingsError)
                XCTAssertTrue(model.works.isEmpty)
            }
        }
        let draft = SettingsDraft(.object(["capabilities": .object(["tools": .bool(true)])]), stamp: snapshot.stamp)
        let window = try await hostView(OverrideForm(model: model, snapshot: snapshot, drafts: drafts, draft: draft, provider: "local", selected: String(repeating: "很长的精确中文型号/", count: 10), close: {}, reselect: {}), size: NSSize(width: 580, height: 680), appearance: .darkAqua)
        defer { window.close() }
        let content = try XCTUnwrap(window.contentView)
        XCTAssertEqual(content.bounds.width, 580)
        XCTAssertGreaterThanOrEqual(allViews(content).compactMap { $0 as? NSTextField }.count, 3, "展开后可编辑三个独立容量")
        let scroll = try XCTUnwrap(allViews(content).compactMap { $0 as? NSScrollView }.first { ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height })
        let bottom = try XCTUnwrap(scroll.documentView).bounds.height
        scroll.contentView.scroll(to: NSPoint(x: 0, y: bottom - scroll.contentView.bounds.height)); scroll.reflectScrolledClipView(scroll.contentView)
        XCTAssertEqual(scroll.contentView.bounds.maxY, bottom, accuracy: 1)
        let identifier = String(repeating: "原始中文型号/", count: 10) + "Case-Sensitive"
        let choice = SettingsDraft(.object(["type": .string("model.configure"), "choice": .string("default"), "provider": .string("local"), "model": .string(identifier), "initialize": .bool(true)]), stamp: snapshot.stamp)
        let choiceWindow = try await hostView(ModelChoiceEditor(model: model, snapshot: snapshot, draft: choice, drafts: drafts, choice: "default", close: {}), size: NSSize(width: 580, height: 680), appearance: .aqua)
        defer { choiceWindow.close() }
        XCTAssertTrue(allViews(choiceWindow.contentView!).compactMap { $0 as? NSTextField }.contains { $0.stringValue == identifier })
        XCTAssertEqual(choice.value["model"].text, identifier)
        XCTAssertTrue(choice.value["initialize"].flag)
        XCTAssertFalse(model.settingsBusy); XCTAssertNil(model.settingsError)
    }

    func testPlatformLifecycleSerializesStartsAndPreservesSwitchResult() throws {
        let room = try temp(), fixture = try EnginePlatformFixture(root: room)
        let arguments = ["start", "--validation-root", room.path]
        let finished = expectation(description: "concurrent starts"); finished.expectedFulfillmentCount = 2
        for _ in 0..<2 {
            DispatchQueue.global().async {
                do {
                    let result = try EngineControl.perform(arguments, bundle: fixture.bundle, execute: fixture.execute)
                    XCTAssertEqual(result.state, "ready")
                } catch { XCTFail(String(describing: error)) }
                finished.fulfill()
            }
        }
        wait(for: [finished], timeout: 5)
        XCTAssertEqual(fixture.bootstraps, 1)
        let plist = try XCTUnwrap(fixture.definition)
        XCTAssertEqual(plist["Label"] as? String, "com.magiccode.platformtest.engine")
        XCTAssertEqual((plist["KeepAlive"] as? [String: Bool])?["SuccessfulExit"], false)
        XCTAssertEqual(plist["RunAtLoad"] as? Bool, true)
        XCTAssertEqual(plist["WorkingDirectory"] as? String, room.path)
        XCTAssertNil(plist["EnvironmentVariables"])
        let program = try XCTUnwrap(plist["ProgramArguments"] as? [String])
        XCTAssertEqual(program[1], "--internal-engine")
        XCTAssertTrue(program.contains("--lifecycle"))

        let next = room.appendingPathComponent("next")
        fixture.busy = true
        let blocked = try EngineControl.perform(["switch", "--parent", next.path, "--validation-root", room.path], bundle: fixture.bundle, execute: fixture.execute)
        XCTAssertEqual(blocked.state, "failed"); XCTAssertEqual(blocked.base, room.appendingPathComponent(".magic").path)
        XCTAssertEqual(fixture.bootstraps, 1)
        fixture.busy = false; fixture.failBootstrap = true
        let failed = try EngineControl.perform(["switch", "--parent", next.path, "--validation-root", room.path], bundle: fixture.bundle, execute: fixture.execute)
        XCTAssertEqual(failed.state, "failed"); XCTAssertEqual(failed.base, next.appendingPathComponent(".magic").path)
        let queried = try EngineControl.perform(["status", "--validation-root", room.path], bundle: fixture.bundle, execute: fixture.execute)
        XCTAssertEqual(queried.base, failed.base); XCTAssertEqual(fixture.bootstraps, 2)
        fixture.failBootstrap = false
        let restarted = try EngineControl.perform(arguments, bundle: fixture.bundle, execute: fixture.execute)
        XCTAssertEqual(restarted.state, "ready"); XCTAssertEqual(restarted.base, failed.base)
        let stopped = try EngineControl.perform(["stop", "--validation-root", room.path], bundle: fixture.bundle, execute: fixture.execute)
        XCTAssertEqual(stopped.state, "stopped")
        let last = room.appendingPathComponent("last")
        let offline = try EngineControl.perform(["switch", "--parent", last.path, "--validation-root", room.path], bundle: fixture.bundle, execute: fixture.execute)
        XCTAssertEqual(offline.state, "stopped"); XCTAssertEqual(fixture.bootstraps, 3)
        XCTAssertThrowsError(try EngineControl.perform(["start", "--base", room.appendingPathComponent(".magic").path, "--validation-root", room.path], bundle: fixture.bundle, execute: fixture.execute))
        XCTAssertEqual(fixture.bootstraps, 3)
    }

    func testDiagnosticsArgumentsAndWireAreIndependentOfBuildMode() throws {
        XCTAssertEqual(try Diagnostics.arguments(["--debug", "--log-level", "trace"]), ["--debug", "--log-level", "trace"])
        XCTAssertThrowsError(try Diagnostics.arguments(["--debug", "--no-debug"]))
        XCTAssertThrowsError(try Diagnostics.arguments(["--log-level"]))
        XCTAssertThrowsError(try Diagnostics.arguments(["--log-level", "verbose"]))

    }
    @MainActor func testDebugSurfaceIgnoresLateMenuDisappearance() throws {
        let (model, _) = try controlledModel(options: [:])
        model.setDebugWindowVisible(true)
        model.inspect(try work())
        let selected = model.selected
        model.panelVisibility(false, surface: .menu)
        XCTAssertEqual(model.selected, selected)
        model.panelVisibility(false, surface: .debug)
        XCTAssertNil(model.selected)
        model.setDebugWindowVisible(false)
        XCTAssertFalse(model.debugWindowVisible)
    }
    func testDiagnosticFileThresholdAndPrivatePermissions() throws {
        let room = try temp(), log = DiagnosticFileLog()
        let configured = expectation(description: "configure"), closed = expectation(description: "close")
        log.configure(dataDir: room.path, level: .error) { problem in XCTAssertNil(problem); configured.fulfill() }
        wait(for: [configured], timeout: 5)
        log.write(.debug, "hidden.event"); log.write(.error, "host.failed")
        log.close { closed.fulfill() }; wait(for: [closed], timeout: 5)
        let closedAgain = expectation(description: "close again")
        log.write(.error, "after.close")
        log.close { closedAgain.fulfill() }; wait(for: [closedAgain], timeout: 5)
        let directory = room.appendingPathComponent("logs")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        let text = try String(contentsOf: files[0], encoding: .utf8)
        XCTAssertTrue(text.contains("host.failed")); XCTAssertFalse(text.contains("hidden.event")); XCTAssertFalse(text.contains("after.close"))
        let attributes = try FileManager.default.attributesOfItem(atPath: files[0].path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    private var helperApp: URL { ProcessInfo.processInfo.environment["MAGIC_NATIVE_TEST_APP"].map { URL(fileURLWithPath: $0) } ?? root.appendingPathComponent(".artifacts/macos/Magic Code.app") }
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
        changes.forEach { if $0.key == "currentNotice", $0.value is NSNull { object.removeValue(forKey: $0.key) } else { object[$0.key] = $0.value } }
        return try JSONDecoder().decode(NativeWork.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testWorkPresentationKeepsIdleHistorySeparateAndDisambiguatesPaths() throws {
        let base = try work()
        let idle = try changed(base, ["state": "idle", "action": "", "reason": "", "affected": false, "currentNotice": NSNull()])
        XCTAssertEqual(idle.statusText, "当前空闲")
        let historic = try changed(base, ["state": "running", "currentNotice": ["id": "old", "session": base.session, "kind": "failed", "at": 1, "unread": true, "delivered": false, "fact": "old"]])
        XCTAssertEqual(WorkGroup.of(historic), .running, "历史未读失败不能取代当前运行事实")
        let paths = ["/Users/甲/客户/project", "/Users/乙/客户/project"]
        XCTAssertEqual(WorkList.shortPath(paths[0], among: paths), "…/甲/客户/project")
        XCTAssertEqual(WorkList.shortPath(paths[1], among: paths), "…/乙/客户/project")
    }

    @MainActor func testRemovedTargetAndStaleStopDoNotChangeWorkIdentity() async throws {
        let base = try work()
        let (model, room) = try controlledModel(options: ["works": [JSONSerialization.jsonObject(with: JSONEncoder().encode(base))], "observerControl": true])
        defer { model.systemQuit {} }
        model.start(); try await eventually { model.isCurrent }
        model.panelVisibility(true); model.inspect(base)
        model.prepareStop(base)
        let newer = try changed(base, ["gen": (base.gen ?? 1) + 1])
        let service = try XCTUnwrap(model.identity).serviceInstance
        try observerCommand(room, ["message": ["t": "native.projection", "projection": ["serviceInstance": service, "revision": 10, "accepting": true, "works": [JSONSerialization.jsonObject(with: JSONEncoder().encode(newer))]]]])
        try await eventually { model.projection?.revision == 10 }
        model.confirmStop()
        XCTAssertNotNil(model.actionMessage)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.stop" })
        try observerCommand(room, ["message": ["t": "native.projection", "projection": ["serviceInstance": service, "revision": 11, "accepting": true, "works": []]]])
        try await eventually { model.projection?.revision == 11 }
        XCTAssertNil(model.selected, "移除后返回列表，由视图保留相邻焦点")
        XCTAssertNil(model.sessions.route)
        model.leaveDetail(); XCTAssertNil(model.selected)
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/u117-stale-stop-removal.json"))
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    func testBackgroundCountPresentation() throws {
        let base = try work()
        XCTAssertEqual(base.backgroundText, "后台命令数量待确认")
        XCTAssertNil(try changed(base, ["background": 0]).backgroundText)
        XCTAssertEqual(try changed(base, ["background": 3]).backgroundText, "3 个后台命令运行中")
        XCTAssertThrowsError(try changed(base, ["background": -1]))
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
                case "SettingsRequest":
                    let value = try JSONDecoder().decode(SettingsValue.self, from: data)
                    guard value.validSettingsRequest else { throw WireError.invalid("设置请求无效") }
                    return try JSONEncoder().encode(value)
                case "SettingsResult":
                    let value = try JSONDecoder().decode(SettingsCallResult.self, from: data)
                    guard value.request != nil, value.base != nil, value.configPath != nil, value.snapshot != nil || value.error != nil else { throw WireError.invalid("设置结果无效") }
                    return data
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
    func testPrivateAtomicFileWrite() throws {
        let file = try temp().appendingPathComponent("runtime/state.json")
        try PrivateFiles.write(Data("one".utf8), to: file)
        try PrivateFiles.write(Data("two".utf8), to: file)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "two")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testStableGroupsAndAllOpenedWork() throws {
        let initial = try work(); var list = WorkList()
        let recent = try (0..<14).map { try changed(initial, ["session": "r\($0)", "state": "idle", "affected": false, "currentNotice": NSNull(), "since": $0]) }
        list.update([initial] + recent, interacting: false)
        XCTAssertEqual(list.rows(.recent, works: [initial] + recent).count, 14)
        let updated = try changed(initial, ["state": "running", "since": 999, "currentNotice": NSNull()])
        list.update([updated] + recent, interacting: true)
        XCTAssertEqual(list.rows(.needsYou, works: [updated] + recent).first?.state, .running)
        list.update([updated] + recent, interacting: false)
        XCTAssertTrue(list.rows(.needsYou, works: [updated] + recent).isEmpty)
        XCTAssertEqual(list.rows(.running, works: [updated] + recent).first?.id, initial.id)
    }

    func testCommandPreservesArgumentsAndWorkspace() throws {
        let room = try temp(); let workspace = room.appendingPathComponent("项目 ' \" $() 空格")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        let helper = room.appendingPathComponent("magic ' 中文")
        try PrivateFiles.write(Data("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"${MAGIC_HOME-unset}\" \"$@\"\n".utf8), to: helper, mode: 0o700)
        let session = "session '; echo injected; #"
        for base in [room.appendingPathComponent("实例 ' \" $(echo injected) 空格"), room] {
            let command = TerminalCommand.make(helper: helper, workspace: workspace, base: base, session: session, request: nil)
            let process = Process(); let output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh"); process.arguments = ["-f", "-c", command]; process.standardOutput = output
            process.environment = ["MAGIC_HOME": "/wrong-instance", "PATH": "/usr/bin:/bin"]
            process.currentDirectoryURL = URL(fileURLWithPath: "/")
            try process.run(); process.waitUntilExit()
            let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            XCTAssertEqual(process.terminationStatus, 0)
            XCTAssertEqual(text.split(separator: "\n").map(String.init), [workspace.path, base.path, "resume", session])
        }
    }
    func testDefaultInstalledResumeCommandKeepsOnlyRequiredLocation() {
        let command = TerminalCommand.make(helper: URL(fileURLWithPath: "/Users/example/.local/bin/magic"),
            workspace: URL(fileURLWithPath: "/Users/example/project"), base: URL(fileURLWithPath: "/Users/example"), session: "session-one", request: nil)
        XCTAssertEqual(command, "cd -- '/Users/example/project' && MAGIC_HOME='/Users/example' '/Users/example/.local/bin/magic' resume 'session-one'")
    }
    @MainActor func testTerminalNeedsMatchingAttachmentAndDeduplicates() throws {
        let root = try temp(); let launcher = TerminalLauncher(directory: root.appendingPathComponent("terminal"))
        var opened: [URL] = []; launcher.openFile = { url, completion in opened.append(url); completion(nil) }
        for _ in 0..<2 { launcher.open(helper: root.appendingPathComponent("helper"), workspace: root, base: root) }
        XCTAssertEqual(opened.count, 1)
        let pending = try XCTUnwrap(launcher.pending["new-draft"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: pending.file.path))
        launcher.attached(request: pending.request, session: "wrong"); XCTAssertEqual(launcher.pending.count, 1)
        launcher.attached(request: pending.request, session: pending.session)
        XCTAssertTrue(launcher.pending.isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: pending.file.path))
        launcher.open(helper: root.appendingPathComponent("helper"), workspace: root, base: root)
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
        launcher.open(helper: helper, workspace: room, base: room)
        let pending = try XCTUnwrap(launcher.pending.values.first)
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/script")
        process.arguments = ["-q", room.appendingPathComponent("outer-tty.log").path, "/bin/zsh", "-f", try XCTUnwrap(file).path]
        process.environment = ["HOME": "/does-not-contain-user-data", "MAGIC_HOME": "/wrong-base", "FAKE_SECRET": "must-not-propagate", "PATH": "/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit(); XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(try String(contentsOf: received, encoding: .utf8).split(separator: "\n").map(String.init),
                       [room.path, room.path, room.path, "--open-request", pending.request])
        XCTAssertEqual(try String(contentsOf: room.appendingPathComponent("terminal-evidence/\(pending.request)/exit-code"), encoding: .utf8), "0\n")
        XCTAssertTrue(launcher.attached(request: pending.request, session: nil))
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
    @MainActor func testSignedHelperNativeHandshakeInspectAndShutdown() async throws { try await hostRoundTrip() }
    @MainActor private func controlledModel(options: [String: Any], notifications: NotificationCoordinator? = nil) throws -> (AppModel, URL) {
        let room = try temp(); let app = room.appendingPathComponent("Controlled.app")
        let helper = app.appendingPathComponent("Contents/Helpers/magic-runtime")
        try PrivateFiles.write(Data(contentsOf: root.appendingPathComponent("apps/macos/MagicCodeTests/Fixtures/controlled-helper.py")), to: helper, mode: 0o700)
        let controller = app.appendingPathComponent("Contents/MacOS/control")
        try PrivateFiles.write(Data(contentsOf: helper), to: controller, mode: 0o700)
        addTeardownBlock {
            _ = try? EngineControl.execute(controller, ["--internal-engine-control", "stop", "--validation-root", room.path, "--request", UUID().uuidString])
        }
        let plist: [String: Any] = ["CFBundleIdentifier": "com.magiccode.controlled.dev", "CFBundleShortVersionString": "0.0.0", "CFBundleExecutable": "control", "CFBundlePackageType": "APPL", "MagicProtocolVersion": 1]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        try JSONSerialization.data(withJSONObject: options).write(to: room.appendingPathComponent("control.json"))
        let model = AppModel(appURL: app, validationRoot: room, notificationPort: notifications ?? NotificationCoordinator(send: { _ in XCTFail("不得发系统通知") }))
        model.terminal.copyText = { _ in }
        model.terminal.openFile = { _, completion in completion(nil) }
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
        model.terminal.open(helper: model.helperURL, workspace: room, base: room)
        let request = try XCTUnwrap(model.terminal.pending["new-draft"])
        try JSONSerialization.data(withJSONObject: ["request": request.request, "session": NSNull()])
            .write(to: room.appendingPathComponent("welcome-barrier.json"), options: .atomic)
    }
    @MainActor func testAppModelSameRevisionWelcomeRecoversWithoutNewHost() async throws {
        let (model, room) = try controlledModel(options: ["revision": 7, "notice": true, "observerControl": true])
        var states: [String] = []; let token = model.$phase.sink { states.append(String(describing: $0)) }; defer { token.cancel() }
        model.terminal.openFile = { _, completion in completion(nil) }
        model.start(); try await eventually { model.isCurrent }
        let identity = try XCTUnwrap(model.identity); let original = model.projection
        try welcomeBarrier(model, room)
        model.refreshAfterWake()
        try await eventually { model.terminal.pending["new-draft"] == nil }
        XCTAssertEqual(model.phase, .ready, "同连接 welcome 后的匹配 attached 已被 AppModel 处理，应恢复 ready")
        XCTAssertEqual(model.projection, original)
        try welcomeBarrier(model, room)
        try observerCommand(room, ["disconnect": true])
        try await eventually { model.phase == .unreachable }
        try await eventually { model.terminal.pending["new-draft"] == nil }
        XCTAssertEqual(model.phase, .ready, "故障自动重连的 welcome 后匹配 attached 已处理，应恢复 ready")
        try welcomeBarrier(model, room)
        try observerCommand(room, ["disconnect": true])
        try await eventually { model.phase == .unreachable }
        model.retry()
        try await eventually { model.terminal.pending["new-draft"] == nil }
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.identity, identity); XCTAssertEqual(model.projection, original)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "cmd" })
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
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
        try await eventually { model.terminal.pending["new-draft"] == nil }
        XCTAssertEqual(model.phase, .stopping)
        XCTAssertEqual(model.projection?.revision, 9); XCTAssertEqual(model.projection?.accepting, false)
        let encodedIdentity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(identity))
        try observerCommand(room, ["message": ["t": "native.welcome", "identity": encodedIdentity, "projection": ["serviceInstance": "another-service", "revision": 10, "accepting": true, "works": []]]])
        try await eventually { model.phase == .fault("连接的核心身份已改变") }
        XCTAssertFalse(model.isCurrent); XCTAssertEqual(model.projection?.revision, 9)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
        try JSONSerialization.data(withJSONObject: traces(room), options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/reconnect-negative.json"))
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
        model.retry(); try await eventually { finished == 1 }; XCTAssertEqual(attempts, 2); XCTAssertEqual(finished, 1)
        XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: link.path))
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "shutdown" }.count, 1)
        try JSONSerialization.data(withJSONObject: ["attempts": attempts, "cleanExitCallbacks": finished, "trace": traces(room)], options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/seams/integration-removal-retry.json"))
    }
    @MainActor func testAppExitLeavesEngineAndNewAppReusesIt() async throws {
        let (model, room) = try controlledModel(options: [:])
        model.start(); try await eventually { model.isCurrent }
        let identity = model.identity
        var finished = false
        model.requestQuit { finished = true }; try await eventually { finished }
        let result = try await EngineControl.run(app: model.appURL, action: "status", home: room)
        XCTAssertEqual(result.state, "ready"); XCTAssertEqual(result.record?.identity, identity)
        XCTAssertFalse(traces(room).contains { $0["event"] as? String == "shutdown" })
        let second = AppModel(appURL: model.appURL, validationRoot: room, notificationPort: NotificationCoordinator(send: { _ in }))
        second.start(); try await eventually { second.isCurrent }
        XCTAssertEqual(second.identity, identity)
        second.confirmEngineStop(); try await eventually { second.phase == .stopped }
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        second.requestQuit {}
    }
    @MainActor func testExplicitStopCanRetryAfterFailure() async throws {
        let (model, room) = try controlledModel(options: ["stop": "error"])
        model.start(); try await eventually { model.isCurrent }
        model.confirmEngineStop()
        try await eventually { if case .fault = model.phase { return true }; return false }
        XCTAssertFalse(model.engineBusy)
        model.confirmEngineStop(); try await eventually { model.phase == .stopped }
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "shutdown" }.count, 1)
        model.requestQuit {}
    }

    @MainActor func testD55ResponsibilityRefusesBaseChange() async throws {
        let busy = try changed(work(), ["state": "running", "affected": true])
        let (model, room) = try controlledModel(options: ["works": [JSONSerialization.jsonObject(with: JSONEncoder().encode(busy))]])
        defer { model.systemQuit {} }
        model.start(); try await eventually { model.isCurrent }
        let identity = model.identity
        model.changeBase(room.appendingPathComponent("another"))
        try await eventually { !model.engineBusy }
        XCTAssertEqual(model.identity, identity); XCTAssertEqual(model.selectedBase, room)
        XCTAssertTrue(model.actionMessage?.contains("无法切换基础路径") == true)
        XCTAssertFalse(traces(room).contains { $0["event"] as? String == "shutdown" })
        var finished = false; model.systemQuit { finished = true }; try await eventually { finished }
    }
    @MainActor func testPassiveRefreshDoesNotRestartStoppedEngine() async throws {
        let (model, room) = try controlledModel(options: [:])
        model.start(); try await eventually { model.isCurrent }
        _ = try await EngineControl.run(app: model.appURL, action: "stop", home: room)
        model.refreshAfterWake(); try await eventually { model.phase == .stopped }
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        model.requestQuit {}
    }
    @MainActor func testWorkResumeOnlyCopiesAndKeepsInstanceAndWorkspace() async throws {
        let (model, room) = try controlledModel(options: ["notice": true])
        defer { model.systemQuit {} }
        var opened = 0; var copies: [String] = []
        model.terminal.openFile = { _, done in opened += 1; done(nil) }
        model.terminal.copyText = { copies.append($0) }
        model.start(); try await eventually { model.isCurrent }
        let item = try changed(XCTUnwrap(model.works.first), ["workspace": [room.appendingPathComponent("中文 空格 ' \" $()").path]])
        model.inspect(item)
        for _ in 0..<2 { model.copyCommand(item) }
        let command = model.resumeCommand(item)
        XCTAssertEqual(copies, [command, command]); XCTAssertEqual(model.actionMessage, "已复制")
        XCTAssertTrue(command.contains(" resume 'session-completed'"))
        XCTAssertTrue(command.contains(TerminalCommand.quote(item.workspace[0])))
        XCTAssertTrue(command.contains("MAGIC_HOME=\(TerminalCommand.quote(room.path))"))
        XCTAssertFalse(command.contains("--open-request")); XCTAssertEqual(opened, 0)
        XCTAssertTrue(model.terminal.pending.isEmpty)
        XCTAssertFalse(traces(room).contains { ($0["message"] as? [String: Any])?["t"] as? String == "native.inspect" })
        let link = URL(fileURLWithPath: model.cliDirectory).appendingPathComponent("magic")
        try CLIInstallation.install(helper: model.helperURL, at: link, app: model.appURL)
        let installed = model.resumeCommand(item)
        XCTAssertTrue(installed.contains("\(TerminalCommand.quote(link.path)) resume "))
        XCTAssertFalse(installed.contains("Contents/Helpers/magic-runtime"))
    }

    @MainActor func testStatusPanelNaturalWindowKeepsRecentWorkVisible() async throws {
        _ = NSApplication.shared
        let (model, _) = try controlledModel(options: ["notice": true])
        defer { model.systemQuit {} }
        model.start(); try await eventually { model.isCurrent }
        XCTAssertEqual(model.works.count, 1)
        XCTAssertEqual(model.list.rows(.recent, works: model.works).count, 1)
        let controller = NSHostingController(rootView: StatusPanel(model: model))
        // 菜单栏按内容的自然尺寸开窗；固定 650 高的截图会掩盖滚动区塌陷。
        let size = controller.view.fittingSize
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(250))
        controller.view.layoutSubtreeIfNeeded()
        func scrollViews(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrollViews)
        }
        let scroll = try XCTUnwrap(scrollViews(controller.view).first)
        let evidence: [String: Any] = ["windowHeight": window.contentLayoutRect.height,
            "listViewportHeight": scroll.contentView.bounds.height, "recentCount": model.list.rows(.recent, works: model.works).count]
        try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
            .write(to: root.appendingPathComponent(".artifacts/macos/panel-natural-size.json"))
        let bitmap = try XCTUnwrap(controller.view.bitmapImageRepForCachingDisplay(in: controller.view.bounds))
        controller.view.cacheDisplay(in: controller.view.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: root.appendingPathComponent(".artifacts/macos/panel-natural-size.png"))
        XCTAssertGreaterThanOrEqual(scroll.contentView.bounds.height, 44, "自然尺寸必须保留可操作的完整工作行")
        XCTAssertEqual(scroll.contentView.bounds.height, try XCTUnwrap(scroll.documentView).bounds.height, accuracy: 1,
                       "单行列表按内容自然取高，不留旧的固定最小高度，也不截断行内容")
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    @MainActor func testNativeFramesLightDarkBusyIdleAndFailure() async throws {
        _ = NSApplication.shared
        let base = try work()
        let first = try changed(base, ["currentNotice": ["id": "notice-one", "session": base.session, "kind": "needs-you", "at": 1, "unread": true, "delivered": false, "fact": "event:42",
            "detail": String(repeating: "需要确认写入工作区外的完整路径，以及此次操作的影响范围。长说明必须能完整查看，不能把主要接回动作挤出面板。\n\n", count: 12)]])
        let busy = try [first,
            changed(first, ["session": "running", "state": "running", "action": "正在运行测试", "workspace": ["/tmp/另一个同名项目/项目"], "currentNotice": NSNull()]),
            changed(first, ["session": "unknown", "state": "unknown", "action": "等待核对实际状态", "gen": NSNull(), "currentNotice": NSNull()]),
            changed(first, ["session": "result", "state": "idle", "action": "结果可查看", "gen": NSNull(), "affected": false, "currentNotice": NSNull()])]
        let raw = try busy.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        let (model, _) = try controlledModel(options: ["works": raw])
        model.start(); try await eventually { model.isCurrent }
        let directory = root.appendingPathComponent(".artifacts/macos/frames")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var frameMetadata: [[String: Any]] = []
        func save(_ window: NSWindow, name: String) async throws {
            XCTAssertFalse(window.isVisible, "原生帧必须离屏，不弹出真实窗口")
            let view = try XCTUnwrap(window.contentView)
            try await Task.sleep(for: .milliseconds(250))
            view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: directory.appendingPathComponent(name + ".png"))
            frameMetadata.append(["name": name, "width": view.bounds.width, "height": view.bounds.height,
                                  "appearance": window.appearance?.name.rawValue ?? "system", "selected": model.selected ?? "",
                                  "capturedAt": ISO8601DateFormatter().string(from: Date()), "offscreen": true,
                                  "screenVisibleWidth": NSScreen.main?.visibleFrame.width ?? 0,
                                  "screenVisibleHeight": NSScreen.main?.visibleFrame.height ?? 0])
            try JSONSerialization.data(withJSONObject: frameMetadata, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.deletingLastPathComponent().appendingPathComponent("native-frames.json"))
            XCTAssertGreaterThan(png.count, 2000)
            window.close()
            // Let the old panel unmount before the next explicit navigation intent.
            try await Task.sleep(for: .milliseconds(100))
        }
        func capture<V: View>(_ content: V, name: String, size: NSSize? = nil, appearance: NSAppearance.Name, exercise: ((NSWindow) async throws -> Void)? = nil) async throws {
            let controller = NSHostingController(rootView: content)
            let frame = size ?? controller.view.fittingSize
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: frame), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: appearance); window.isReleasedWhenClosed = false
            controller.view.frame = NSRect(origin: .zero, size: frame); window.contentViewController = controller
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
            let scroll = try XCTUnwrap(scrollViews(try XCTUnwrap(window.contentView)).last { $0.documentView != nil })
            let height = try XCTUnwrap(scroll.documentView).bounds.height
            scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, height - scroll.contentView.bounds.height)))
            scroll.reflectScrolledClipView(scroll.contentView)
            return scroll
        }
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .light), name: "busy-light", appearance: .aqua)
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .dark), name: "busy-dark", appearance: .darkAqua)
        model.inspect(first)
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .dark), name: "detail-dark", appearance: .darkAqua)
        let quitAlert = model.makeEngineStopAlert()
        XCTAssertEqual(quitAlert.buttons.map(\.title), ["取消", "停止 Engine"])
        XCTAssertEqual(quitAlert.buttons.first?.keyEquivalent, "\r")
        XCTAssertEqual(quitAlert.buttons.last?.keyEquivalent, "")
        try await capture(QuitImpactList(affected: model.affected)
            .background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .light),
            name: "quit-impact-list", size: NSSize(width: 360, height: 300), appearance: .aqua)
        model.phase = .fault("连接已断开，重试后核对当前状态。")
        try await capture(StatusPanel(model: model).environment(\.colorScheme, .light), name: "failure", appearance: .aqua)
        model.phase = .ready
        // The controlled helper owns no real work; use the normal stop responsibility.
        var finished = false; model.requestQuit { finished = true }; model.confirmQuit(); try await eventually { finished }
        let (idle, _) = try controlledModel(options: [:]); idle.start(); try await eventually { idle.isCurrent }
        try await capture(StatusPanel(model: idle).environment(\.colorScheme, .light), name: "idle", appearance: .aqua)
        idle.rememberSettingsCategory("app")
        idle.cliDirectory = idle.userHome.appendingPathComponent("这是一个用于验证完整显示与复制的很长命令安装目录/还有一层中文目录/bin").path
        try await capture(SettingsView(model: idle).environment(\.colorScheme, .dark), name: "settings-dark", size: NSSize(width: 800, height: 680), appearance: .darkAqua)
        try await capture(SettingsView(model: idle).environment(\.colorScheme, .dark), name: "settings-bottom-dark", size: NSSize(width: 800, height: 680), appearance: .darkAqua) { window in
            let scroll = try scrollBottom(window)
            try await Task.sleep(for: .milliseconds(100))
            let document = try XCTUnwrap(scroll.documentView)
            XCTAssertGreaterThanOrEqual(scroll.contentView.bounds.maxY + 1, document.bounds.maxY)
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
            try changed(first, ["session": "running", "state": "running", "action": "正在运行测试", "currentNotice": NSNull()])))
        let (active, _) = try controlledModel(options: ["works": [running]])
        active.start(); try await eventually { active.isCurrent }
        XCTAssertEqual(active.menuBarState, .active, "有受影响的工作就是执行中")

        let waiting = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try changed(first, ["currentNotice": NSNull()])))
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
    @MainActor func testReconnectSeedsUnreadFactsAndCancelsOfflineBatch() async throws {
        let first = try work()
        let identity = ServiceIdentity(protocol: 1, version: "0.0.0", source: "/tmp/helper", serviceInstance: "s", base: "/tmp/data")
        func projection(_ ids: [String], revision: Int) throws -> NativeProjection {
            let notice = AttentionItem(id: ids.last!, session: first.session, kind: .done, at: Date().timeIntervalSince1970 * 1000, detail: nil, unread: true, delivered: false, fact: ids.last!)
            return NativeProjection(serviceInstance: "s", revision: revision, accepting: true, works: [try changed(first, ["currentNotice": JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))])])
        }
        var sent: [NoticeDelivery] = []
        let notifications = NotificationCoordinator(send: { sent.append($0) })
        notifications.enabled = true; notifications.enabledSince = 0
        notifications.beginConnection(try projection(["old"], revision: 1), identity: identity)
        notifications.observe(try projection(["old", "queued"], revision: 2), identity: identity)
        notifications.disconnect()
        notifications.beginConnection(try projection(["old", "queued", "offline"], revision: 3), identity: identity)
        notifications.observe(try projection(["old", "queued", "offline"], revision: 4), identity: identity)
        try await Task.sleep(for: .milliseconds(2100)); XCTAssertTrue(sent.isEmpty)
        notifications.observe(try projection(["old", "queued", "offline", "live"], revision: 5), identity: identity)
        try await Task.sleep(for: .milliseconds(2100)); XCTAssertEqual(sent.count, 1)
        notifications.disconnect()
    }
    @MainActor func testNotificationCollectorTwoSecondsAndReadCancellation() async throws {
        let first = try work()
        let identity = ServiceIdentity(protocol: 1, version: "0.0.0", source: "/tmp/helper", serviceInstance: "s", base: "/tmp/data")
        let now = Date().timeIntervalSince1970 * 1000
        func row(id: String, unread: Bool = true) throws -> NativeWork {
            let notice = AttentionItem(id: id, session: first.session, kind: .needsYou, at: now, detail: nil, unread: unread, delivered: false, fact: "event:\(id)")
            return try changed(first, ["currentNotice": JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))])
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
        let controller = app.appendingPathComponent("Contents/MacOS/control")
        try PrivateFiles.write(Data(contentsOf: helper), to: controller, mode: 0o700)
        addTeardownBlock {
            _ = try? EngineControl.execute(controller, ["--internal-engine-control", "stop", "--validation-root", room.path, "--request", UUID().uuidString])
        }
        let plist: [String: Any] = ["CFBundleIdentifier": bundle, "CFBundleShortVersionString": "0.0.0", "CFBundleExecutable": "control",
                                    "CFBundlePackageType": "APPL", "MagicProtocolVersion": 1, "MagicSystemTestRoot": room.path]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        var control: [String: Any] = ["systemTest": true, "source": helper.path, "works": []]
        options.forEach { control[$0.key] = $0.value }
        try JSONSerialization.data(withJSONObject: control).write(to: room.appendingPathComponent("control.json"))
        try JSONSerialization.data(withJSONObject: ["bundle": bundle, "allow": allow]).write(to: room.appendingPathComponent("system-authorization.json"))
        // 旧版本才会存这份「App 自己的开没开」；本轮起 App 不许再读它。
        if let legacyPreference { UserDefaults(suiteName: "MagicCode.Validation.\(room.lastPathComponent)")?.set(legacyPreference, forKey: "notificationsEnabled") }
        let port = NotificationCoordinator(send: { delivery in send(delivery) }, status: status, request: request)
        return (AppModel(appURL: app, validationRoot: room, notificationPort: port), room)
    }

    /// 一条「刚发生」的未读事实（`at` 取当前时刻，才过得了启用时刻那道门）。
    @MainActor private func freshNoticeRow(_ id: String) throws -> [String: Any] {
        let notice = AttentionItem(id: id, session: "s-\(id)", kind: .done, at: Date().timeIntervalSince1970 * 1000, detail: nil,
                                   unread: true, delivered: false, fact: "event:\(id)")
        let work = try changed(try work(), ["session": "s-\(id)", "state": "idle", "affected": false,
                                             "currentNotice": JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))])
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

    @MainActor private func saveFrame(_ window: NSWindow, name: String, offscreen: Bool = true) async throws {
        let directory = root.appendingPathComponent(".artifacts/macos/frames")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let view = try XCTUnwrap(window.contentView)
        // 离屏托管视图先同步平台控件；真实有标题窗口保留位置与可见生命周期。
        if offscreen {
            window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
            window.orderBack(nil)
            XCTAssertLessThan(window.frame.maxX, 0, "验收窗口不得移到用户桌面")
        } else { XCTAssertTrue(window.isVisible) }
        defer { if offscreen { window.orderOut(nil) } }
        try await Task.sleep(for: .milliseconds(350))
        view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
        let capturedAt = Date().timeIntervalSince1970
        let capturedAppearance = window.effectiveAppearance.name.rawValue
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: directory.appendingPathComponent(name + ".png"))
        if name.hasPrefix("u116-") {
            let app = Bundle(url: helperApp)
            let facts: [String: Any] = ["at": capturedAt, "appearance": capturedAppearance, "width": view.bounds.width, "height": view.bounds.height, "version": app?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知", "source": "offscreen native NSHostingController"]
            try JSONSerialization.data(withJSONObject: facts, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent(name + ".metadata.json"))
        }
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
        model.rememberSettingsCategory("app")
        let window = try await hostView(SettingsView(model: model), size: NSSize(width: 800, height: 680), appearance: .aqua)
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
        let (model, room) = try systemTestModel(status: { status }, request: { requested += 1; status = .authorized; return true },
                                             options: ["works": []], send: { sent.append($0) })
        model.start(); try await eventually { model.isCurrent }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(requested, 0, "首次打开不弹权限框")
        try JSONSerialization.data(withJSONObject: ["works": [try freshNoticeRow("first")]])
            .write(to: room.appendingPathComponent("control.json"), options: .atomic)
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
        model.notifications.userLooking = { _, _ in true }
        try JSONSerialization.data(withJSONObject: ["systemTest": true, "works": [try freshNoticeRow("watched")]])
            .write(to: room.appendingPathComponent("control.json"))
        try await Task.sleep(for: .seconds(2.6))
        XCTAssertTrue(sent.isEmpty, "你在看这一屏时不打断")
        model.notifications.userLooking = { _, _ in false }
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
                                           "currentNotice": JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))])
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
                                           "currentNotice": JSONSerialization.jsonObject(with: JSONEncoder().encode(old))])
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
        model.rememberSettingsCategory("app")
        let window = try await hostView(SettingsView(model: model), size: NSSize(width: 800, height: 680), appearance: .aqua)
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

    @MainActor func testCLIInstallationCommitsCandidateOnlyAfterSuccess() throws {
        let room = try temp()
        let model = AppModel(appURL: helperApp, validationRoot: room, notificationPort: NotificationCoordinator(send: { _ in XCTFail("安装命令不得发送通知") }))
        defer { model.requestQuit {} }
        let preferences = try XCTUnwrap(UserDefaults(suiteName: "\(room.path)/MagicCode.Validation"))
        let original = model.cliDirectory
        model.installCLI()
        XCTAssertEqual(preferences.string(forKey: "cliDirectory"), original)
        XCTAssertTrue(try CLIInstallation.belongs(URL(fileURLWithPath: original).appendingPathComponent("magic"), helper: model.helperURL))

        let blocked = room.appendingPathComponent("occupied-bin")
        let sentinel = Data("user-owned command".utf8)
        try PrivateFiles.write(sentinel, to: blocked.appendingPathComponent("magic"), mode: 0o600)
        model.installCLI(at: blocked.path)
        XCTAssertEqual(model.cliDirectory, original, "安装失败不能替换当前目录")
        XCTAssertEqual(preferences.string(forKey: "cliDirectory"), original, "安装失败不能持久化候选目录")
        XCTAssertTrue(model.actionMessage?.contains("已被占用") == true)
        XCTAssertEqual(try Data(contentsOf: blocked.appendingPathComponent("magic")), sentinel)
        XCTAssertTrue(try CLIInstallation.belongs(URL(fileURLWithPath: model.cliDirectory).appendingPathComponent("magic"), helper: model.helperURL))

        let candidate = room.appendingPathComponent("new-bin")
        model.installCLI(at: candidate.path)
        XCTAssertEqual(model.cliDirectory, candidate.path)
        XCTAssertEqual(preferences.string(forKey: "cliDirectory"), candidate.path)
        XCTAssertTrue(try CLIInstallation.belongs(candidate.appendingPathComponent("magic"), helper: model.helperURL))
    }

    @MainActor func testSettingsWriteReceiptsSurviveQueuedReadsAndConflictRecovery() async throws {
        let room = try temp()
        let model = AppModel(appURL: helperApp, validationRoot: room, notificationPort: NotificationCoordinator(send: { _ in XCTFail("设置不得发送通知") }))
        defer { model.requestQuit {} }
        model.readSettings(); try await eventually { !model.settingsBusy }
        let initial = try XCTUnwrap(model.settingsSnapshot)
        let action: SettingsValue = .object(["type": .string("prefs.set"), "reducedMotion": .bool(true)])
        model.applySettings(action, stamp: initial.stamp, key: "receipt-success")
        XCTAssertTrue(model.settingsBusy)
        // 同一 MainActor 回合内排队，确定刷新发生在写调用完成之后。
        model.readSettings()
        try await eventually { !model.settingsBusy }
        XCTAssertEqual(model.settingsSavedKey, "receipt-success", "排队读取不能吞掉弹窗用于关闭的保存标记")
        XCTAssertNotNil(model.settingsNote)
        XCTAssertNil(model.settingsError)
        XCTAssertEqual(model.settingsSnapshot?.configuration["motion"]["reduced"], .bool(true))

        let saved = try XCTUnwrap(model.settingsSnapshot)
        let path = URL(fileURLWithPath: saved.configPath)
        try Data("{\"motion\":{\"reduced\":false}}".utf8).write(to: path)
        model.applySettings(action, stamp: saved.stamp, key: "receipt-conflict")
        model.readSettings()
        try await eventually { !model.settingsBusy }
        let conflict = try XCTUnwrap(model.settingsError)
        XCTAssertTrue(conflict.contains("配置已被修改"), conflict)
        XCTAssertNil(model.settingsSavedKey)
        XCTAssertNil(model.settingsNote)
        let refreshed = try XCTUnwrap(model.settingsSnapshot)
        XCTAssertNotEqual(refreshed.stamp, saved.stamp, "保留写失败时仍须刷新配置基线")
        XCTAssertEqual(refreshed.configuration["motion"]["reduced"], .bool(false))
        model.readSettings(); try await eventually { !model.settingsBusy }
        XCTAssertEqual(model.settingsError, conflict, "后续读取不能冒充写失败已经解决")

        model.applySettings(action, stamp: refreshed.stamp, key: "receipt-recovered")
        XCTAssertNil(model.settingsSavedKey, "新操作须先清除旧成功标记")
        model.readSettings()
        try await eventually { !model.settingsBusy }
        XCTAssertNil(model.settingsError)
        XCTAssertEqual(model.settingsSavedKey, "receipt-recovered")
        XCTAssertEqual(model.settingsSnapshot?.configuration["motion"]["reduced"], .bool(true))
    }

    @MainActor func testSettingsReadFailureClearsAfterConfigurationRepair() async throws {
        let room = try temp()
        let model = AppModel(appURL: helperApp, validationRoot: room, notificationPort: NotificationCoordinator(send: { _ in XCTFail("设置不得发送通知") }))
        defer { model.requestQuit {} }
        let path = room.appendingPathComponent(".magic/config.json")
        try PrivateFiles.write(Data("{".utf8), to: path, mode: 0o600)
        model.readSettings(); try await eventually { !model.settingsBusy }
        XCTAssertNotNil(model.settingsError)
        XCTAssertNil(model.settingsSnapshot)
        try Data("{}".utf8).write(to: path)
        model.readSettings(); try await eventually { !model.settingsBusy }
        XCTAssertNil(model.settingsError, "修复配置后成功重读应清除原读失败")
        let snapshot = try XCTUnwrap(model.settingsSnapshot)

        model.applySettings(.object(["type": .string("prefs.set"), "reducedMotion": .bool(true)]), stamp: snapshot.stamp, key: "before-read-failure")
        try await eventually { !model.settingsBusy }
        XCTAssertNil(model.settingsError)
        XCTAssertEqual(model.settingsSavedKey, "before-read-failure")
        let valid = try Data(contentsOf: path)
        let note = try XCTUnwrap(model.settingsNote)
        try Data("{".utf8).write(to: path)
        model.readSettings(); try await eventually { !model.settingsBusy }
        XCTAssertNotNil(model.settingsError, "已有保存回执不能隐藏后续读取失败")
        XCTAssertEqual(model.settingsSavedKey, "before-read-failure")
        try valid.write(to: path)
        model.readSettings(); try await eventually { !model.settingsBusy }
        XCTAssertNil(model.settingsError, "读错误不能无限保留")
        XCTAssertEqual(model.settingsSavedKey, "before-read-failure")
        XCTAssertEqual(model.settingsNote, note)
    }

    @MainActor func testU116RealHelperSettingsAndSevenNativePages() async throws {
        _ = NSApplication.shared
        let app = helperApp
        let room = try temp()
        let model = AppModel(appURL: app, validationRoot: room, notificationPort: NotificationCoordinator(send: { _ in XCTFail("设置不得发送通知") }))
        defer { model.requestQuit {} }
        model.readSettings(); try await eventually { model.settingsSnapshot != nil && !model.settingsBusy }
        let first = try XCTUnwrap(model.settingsSnapshot)
        XCTAssertNil(first.stamp); XCTAssertTrue(model.works.isEmpty)
        XCTAssertTrue(first.configuration["providers"].object.isEmpty)
        let empty = try await hostView(SettingsView(model: model), size: NSSize(width: 1000, height: 860), appearance: .aqua)
        try await saveFrame(empty, name: "u116-models-empty-light"); empty.close()
        for category in SettingsCategory.all where category.id != "models" {
            model.rememberSettingsCategory(category.id)
            let window = try await hostView(SettingsView(model: model), size: NSSize(width: 1000, height: 860), appearance: .aqua)
            try await saveFrame(window, name: "u116-\(category.id)-empty-light"); window.close()
        }
        func save(_ action: SettingsValue, key: String) async throws {
            model.applySettings(action, stamp: model.settingsSnapshot?.stamp, key: key)
            try await eventually { !model.settingsBusy }
            XCTAssertNil(model.settingsError, model.settingsError ?? "")
            XCTAssertEqual(model.settingsSavedKey, key)
        }
        try await save(.object(["type": .string("provider.save"), "provider": .string("local"), "vendor": .string("deepseek"), "name": .string("本地受控连接 · 很长的中文名称用于核对设置布局"), "baseURL": .string("http://127.0.0.1:1/v1"), "apiKey": .string("SENTINEL_U116_SWIFT")]), key: "provider-local")
        try await save(.object(["type": .string("model.configure"), "choice": .string("default"), "provider": .string("local"), "model": .string("deepseek-flash"), "initialize": .bool(true)]), key: "choice-default")
        try await save(.object(["type": .string("mcp.save"), "name": .string("local-tools"), "server": .object(["command": .string("/SENTINEL_NEVER_RUN"), "args": .strings(["很长的独立参数，用于核对原生列表保留完整内容", "--next"])]), "secrets": .object(["API_TOKEN": .string("SENTINEL_U116_MCP")])]), key: "mcp-local")
        try await save(.object(["type": .string("role.save"), "id": .string("review"), "role": .object(["name": .string("独立审查成员"), "instructions": .string("只根据可核对的依据给出结果。很长的中文职责用于核对换行和层级。"), "tools": .array([]), "model": .object(["choice": .string("default"), "reasoning": .object(["mode": .string("off")])])])]), key: "role-review")
        for source in ["rules.sources", "rules.linkSources", "skills.sources"] {
            try await save(.object(["type": .string("sources.set"), "source": .string(source), "paths": .strings([room.appendingPathComponent("中文材料目录/用于核对完整路径/不存在的原始材料").path])]), key: source)
        }
        try await save(.object(["type": .string("prefs.set"), "statusLine": .object(["cells": .strings(["workspace", "model", "reasoning", "context", "session"]), "color": .bool(true)])]), key: "terminal")
        let snapshot = try XCTUnwrap(model.settingsSnapshot)
        let encoded = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        XCTAssertFalse(encoded.contains("SENTINEL_U116_SWIFT")); XCTAssertFalse(encoded.contains("SENTINEL_U116_MCP"))
        XCTAssertTrue(model.works.isEmpty)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: snapshot.configPath)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        var geometry: [[String: Any]] = []
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for category in SettingsCategory.all {
                model.rememberSettingsCategory(category.id)
                let window = try await hostView(SettingsView(model: model), size: NSSize(width: 1000, height: 860), appearance: appearance)
                try await saveFrame(window, name: "u116-\(category.id)-\(appearance == .aqua ? "light" : "dark")")
                geometry.append(["category": category.id, "appearance": window.effectiveAppearance.name.rawValue, "width": window.contentView!.bounds.width, "height": window.contentView!.bounds.height, "at": Date().timeIntervalSince1970])
                window.close()
            }
        }
        model.rememberSettingsCategory("advanced")
        let small = try await hostView(SettingsView(model: model), size: NSSize(width: 650, height: 600), appearance: .darkAqua)
        try await saveFrame(small, name: "u116-advanced-small-dark")
        func scrolls(_ view: NSView) -> [NSScrollView] { (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls) }
        let scroll = try XCTUnwrap(scrolls(small.contentView!).filter { $0.bounds.width > 300 && ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height }.first)
        let bottom = try XCTUnwrap(scroll.documentView).bounds.height
        scroll.contentView.scroll(to: NSPoint(x: 0, y: bottom - scroll.contentView.bounds.height)); scroll.reflectScrolledClipView(scroll.contentView)
        try await saveFrame(small, name: "u116-advanced-small-bottom-dark")
        XCTAssertEqual(scroll.contentView.bounds.maxY, bottom, accuracy: 1); small.close()
        try await eventually { !model.settingsBusy }
        let before = snapshot.stamp
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: snapshot.configPath))) as? [String: Any])
        raw["motion"] = ["reduced": true]
        try JSONSerialization.data(withJSONObject: raw).write(to: URL(fileURLWithPath: snapshot.configPath))
        model.applySettings(.object(["type": .string("prefs.set"), "reducedMotion": .bool(false)]), stamp: before, key: "stale")
        try await eventually { !model.settingsBusy }; XCTAssertNotNil(model.settingsError); XCTAssertNil(model.settingsSavedKey)
        let error = try await hostView(SettingsView(model: model), size: NSSize(width: 1000, height: 860), appearance: .aqua)
        // onAppear重新读取，错误另由同一原生动作生成。
        try await eventually { !model.settingsBusy }
        model.applySettings(.object(["type": .string("workspace.set"), "roots": .strings(["/SENTINEL_MISSING_ROOT"])]), stamp: model.settingsSnapshot?.stamp, key: "invalid")
        try await eventually { !model.settingsBusy }; XCTAssertNotNil(model.settingsError)
        try await saveFrame(error, name: "u116-advanced-field-error-light"); error.close()
        let drafts = SettingsDrafts()
        let long = "很长的中文职责与完整路径用于核对原生编辑器换行。" + String(repeating: "实际编辑输入仍应可见可取消。", count: 10)
        let mcpDraft = SettingsDraft(.object(["name": .string("local-tools"), "transport": .string("stdio"), "command": .string(room.appendingPathComponent(long).path), "args": .strings(Array(repeating: long, count: 4)), "secretRows": .array([.object(["name": .string("API_TOKEN"), "mode": .string("keep"), "value": .string("")])])]), stamp: snapshot.stamp)
        let roleDraft = SettingsDraft(.object(["id": .string("review"), "name": .string(long), "instructions": .string(long), "guidanceFiles": .strings([room.appendingPathComponent(long).path]), "skills": .strings(["review"]), "tools": .array([])]), stamp: snapshot.stamp)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let editors = [AnyView(McpEditor(model: model, snapshot: snapshot, drafts: drafts, draft: mcpDraft, name: "local-tools", close: {})), AnyView(RoleEditor(model: model, snapshot: snapshot, drafts: drafts, draft: roleDraft, id: "review", close: {}))]
            for (index, editor) in editors.enumerated() {
                let window = try await hostView(ScrollView { editor.padding(24) }.frame(width: 650, height: 400).background(Color(nsColor: .controlBackgroundColor)).tint(.blue), size: NSSize(width: 650, height: 400), appearance: appearance)
                let name = "u116-\(index == 0 ? "tools" : "roles")-long-editor-\(appearance == .aqua ? "light" : "dark")"
                try await saveFrame(window, name: name)
                let scroll = try XCTUnwrap(scrolls(window.contentView!).first { ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height })
                let bottom = try XCTUnwrap(scroll.documentView).bounds.height
                scroll.contentView.scroll(to: NSPoint(x: 0, y: bottom - scroll.contentView.bounds.height)); scroll.reflectScrolledClipView(scroll.contentView)
                try await saveFrame(window, name: name + "-bottom"); XCTAssertEqual(scroll.contentView.bounds.maxY, bottom, accuracy: 1); window.close()
            }
        }
        let saved = try Data(contentsOf: URL(fileURLWithPath: snapshot.configPath))
        let broken = Data("{\"apiKey\":\"SENTINEL_U116_BROKEN\",".utf8)
        try broken.write(to: URL(fileURLWithPath: snapshot.configPath))
        for category in SettingsCategory.all {
            model.rememberSettingsCategory(category.id)
            let window = try await hostView(SettingsView(model: model), size: NSSize(width: 1000, height: 860), appearance: .aqua)
            try await eventually { !model.settingsBusy && model.settingsError != nil }
            XCTAssertFalse(model.settingsError!.contains("SENTINEL_U116_BROKEN"))
            try await saveFrame(window, name: "u116-\(category.id)-read-error-light"); window.close()
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: snapshot.configPath)), broken)
        }
        try saved.write(to: URL(fileURLWithPath: snapshot.configPath))
        let natural = NSHostingController(rootView: SettingsView(model: model))
        // 设置是可嵌入页面；零尺寸提案检查页面下限，默认窗口大小由 MainWindowController 负责。
        let fitting = natural.sizeThatFits(in: .zero)
        XCTAssertEqual(fitting.width, 460, accuracy: 1); XCTAssertEqual(fitting.height, 420, accuracy: 1)
        let evidence: [String: Any] = ["source": "signed embedded helper + native SettingsView", "works": model.works.count, "sensitiveRead": false, "naturalWidth": fitting.width, "naturalHeight": fitting.height, "frames": geometry]
        try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent(".artifacts/macos/u116-settings-native.json"))
        var finished = false; model.requestQuit { finished = true }; try await eventually { finished }
    }

    @MainActor private func hostRoundTrip() async throws {
        let app = helperApp
        let helper = app.appendingPathComponent("Contents/Helpers/magic-runtime")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: helper.path))
        let room = try temp(), discovery = room.appendingPathComponent("engine.json")
        let process = Process(); process.executableURL = helper
        process.arguments = ["--internal-engine", "--home", room.path, "--parent", room.path, "--source", helper.path, "--app", app.path, "--discovery", discovery.path, "--lifecycle", UUID().uuidString]
        process.environment = ["HOME": room.path, "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        var record: HostDiscovery?
        try await eventually { record = (try? Data(contentsOf: discovery)).flatMap { try? JSONDecoder().decode(HostDiscovery.self, from: $0) }; return record?.state == "ready" }
        let current = try XCTUnwrap(record)
        let observer = ObserverConnection(); defer { observer.close() }
        let welcome = expectation(description: "native.welcome"), inspected = expectation(description: "inspection")
        observer.receive = { response in
            switch response {
            case .welcome(_, let projection):
                XCTAssertTrue(projection.works.isEmpty); welcome.fulfill()
                observer.send(.inspect(request: "i", session: "absent", notice: nil))
            case .inspected(_, let work, let error): XCTAssertNil(work); XCTAssertNotNil(error); inspected.fulfill()
            default: break
            }
        }
        observer.connect(path: current.socket, identity: current.identity)
        await fulfillment(of: [welcome, inspected], timeout: 5)
        XCTAssertTrue(process.isRunning, "stdin 关闭不结束 Engine")
        observer.send(.engineStop(request: "stop-test", identity: current.identity, idleOnly: nil))
        try await eventually { !process.isRunning }
        let stopped = try JSONDecoder().decode(HostDiscovery.self, from: Data(contentsOf: discovery))
        XCTAssertEqual(stopped.state, "stopped"); XCTAssertEqual(process.terminationStatus, 0)
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

    // XCTest 不运行 NSApplication.run；等待真实焦点/关闭事件时需要分发 AppKit 事件并完成一轮布局。
    @MainActor private func appKitEventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(5)
        repeat {
            while let event = NSApp.nextEvent(matching: .any, until: .distantPast, inMode: .default, dequeue: true) {
                NSApp.sendEvent(event)
            }
            NSApp.updateWindows()
            try await Task.sleep(for: .milliseconds(10))
        } while !condition() && Date() < deadline
        XCTAssertTrue(condition(), "没有观察到所需 AppKit 状态", file: file, line: line)
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

    @MainActor func testMainWindowReusesSessionSettingsAndNotificationEntrancesWithoutStoppingEngine() async throws {
        _ = NSApplication.shared
        // PolicySpy 只记录产品策略；允许测试进程自身激活，结束后恢复其原始策略。
        let activationPolicy = NSApp.activationPolicy()
        NSApp.setActivationPolicy(.accessory)
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
        defer { NSApp.setActivationPolicy(activationPolicy) }
        if !NSRunningApplication.current.isFinishedLaunching { NSApp.finishLaunching() }
        try await appKitEventually { NSRunningApplication.current.activationPolicy == .accessory }
        let (model, room) = try controlledModel(options: [:])
        let controller = MainWindowController(model: model)
        model.showMainWindow = { [weak controller] in controller?.show() }
        let policy = LongLivedWindows.shared, spy = PolicySpy()
        let real = (policy.current, policy.apply); spy.install(policy)
        defer {
            controller.window?.close(); controller.window?.contentViewController = nil
            controller.window?.delegate = nil; model.showMainWindow = nil
            model.requestQuit {}
            policy.current = real.0; policy.apply = real.1
        }
        model.start(); try await eventually { model.isCurrent }
        let identity = try XCTUnwrap(model.identity)
        XCTAssertNil(controller.window)
        model.manageSessions()
        let window = try XCTUnwrap(controller.window)
        window.animationBehavior = .none
        try await appKitEventually {
            window.isVisible && window.isKeyWindow && NSApp.isActive && policy.presentCount == 1
                && window.contentMinSize.width >= 460 && window.contentMinSize.height >= 480
        }
        XCTAssertTrue(window.contentViewController is NSHostingController<MainWindowView>)
        let content = try XCTUnwrap(window.contentView)
        content.layoutSubtreeIfNeeded()
        XCTAssertEqual(content.bounds.width, 1000, accuracy: 1)
        XCTAssertEqual(content.bounds.height, 760, accuracy: 1)
        XCTAssertLessThanOrEqual(window.contentMinSize.width, content.bounds.width)
        XCTAssertLessThanOrEqual(window.contentMinSize.height, content.bounds.height)
        XCTAssertEqual(spy.log.last, .regular)
        let visiblePolicyLog = spy.log

        model.manageSettings()
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        XCTAssertTrue(controller.window === window)
        XCTAssertEqual(model.mainPage, .settings)
        model.manageSessions()
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        XCTAssertTrue(controller.window === window)
        XCTAssertEqual(model.mainPage, .sessions)
        model.manageSettings()
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        let route = NoticeRoute(base: identity.base, serviceInstance: identity.serviceInstance, session: "one", notice: reason())
        model.notifications.openRoute?(route)
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        XCTAssertTrue(controller.window === window)
        XCTAssertEqual(model.mainPage, .sessions)
        XCTAssertEqual(model.sessions.route, route, "通知入口必须将来源交给同一窗口里的会话页")
        XCTAssertEqual(policy.presentCount, 1)
        XCTAssertEqual(spy.log, visiblePolicyLog, "内部切页不反复切换 Dock 策略")

        window.close()
        try await appKitEventually { !window.isVisible && !window.isKeyWindow && spy.log.last == .accessory }
        XCTAssertEqual(policy.presentCount, 0)
        let status = try await EngineControl.run(app: model.appURL, action: "status", home: room)
        XCTAssertEqual(status.state, "ready")
        XCTAssertEqual(status.record?.identity, identity, "关闭主窗口保留同一 Engine 实例")
        XCTAssertFalse(traces(room).contains { $0["event"] as? String == "shutdown" })
        model.manageSettings()
        try await appKitEventually { window.isVisible && window.isKeyWindow && NSApp.isActive && spy.log.last == .regular }
        XCTAssertTrue(controller.window === window, "关闭后从设置入口重开仍复用原窗口")
        XCTAssertEqual(spy.log.last, .regular)
        XCTAssertEqual(traces(room).filter { $0["event"] as? String == "started" }.count, 1)
        try await eventually { !model.settingsBusy }

        // 只缩小一次；切页与后续布局都不得抬高最小尺寸或把窗口撑回去。
        window.setContentSize(NSSize(width: 460, height: 480))
        func assertCompactLayout() {
            content.layoutSubtreeIfNeeded(); content.displayIfNeeded()
            let rect = window.contentRect(forFrameRect: window.frame)
            XCTAssertEqual(rect.width, 460, accuracy: 1); XCTAssertEqual(rect.height, 480, accuracy: 1)
            XCTAssertEqual(content.bounds.width, 460, accuracy: 1); XCTAssertEqual(content.bounds.height, 480, accuracy: 1)
            XCTAssertEqual(window.contentMinSize.width, 460, accuracy: 1)
            XCTAssertEqual(window.contentMinSize.height, 480, accuracy: 1)
            func checkViewport(_ view: NSView) {
                guard !view.isHiddenOrHasHiddenAncestor else { return }
                if let scroll = view as? NSScrollView {
                    let viewport = scroll.contentView.convert(scroll.contentView.bounds, to: content)
                    XCTAssertTrue(content.bounds.insetBy(dx: -1, dy: -1).contains(viewport), "可见滚动视口不得超出主窗口内容区：\(viewport)")
                    return // 滚动正文可以超出视口，不将正常滚动误判为越界。
                }
                view.subviews.forEach(checkViewport)
            }
            checkViewport(content)
        }
        model.rememberSettingsCategory("app")
        for (page, name) in [(AppModel.MainPage.sessions, "sessions"), (.settings, "settings")] {
            model.selectMainPage(page)
            try await saveFrame(window, name: "u123-main-compact-\(name)", offscreen: false)
            assertCompactLayout()
            XCTAssertTrue(controller.window === window)
        }
        model.selectMainPage(.sessions)
        window.orderBack(nil)
        await Task.yield()
        assertCompactLayout()
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

    @MainActor func testMainWindowHiddenSessionsDoNotReadSourcesAndKeepBrowsingState() async throws {
        _ = NSApplication.shared
        let activationPolicy = NSApp.activationPolicy()
        NSApp.setActivationPolicy(.accessory)
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
        defer { NSApp.setActivationPolicy(activationPolicy) }
        if !NSRunningApplication.current.isFinishedLaunching { NSApp.finishLaunching() }
        try await appKitEventually { NSRunningApplication.current.activationPolicy == .accessory }
        let (model, _) = try controlledModel(options: [:])
        let notice = reason(), work = try reasonWork(notice), messages = NativeMessages()
        let sessions = model.sessions
        sessions.send = { messages.requests.append($0) }
        sessions.connect(identity: testIdentity, current: true, works: [work])
        sessions.open(); try catalog(sessions, messages, [sessionRow()])
        sessions.selection = ["one"]; sessions.choose(); sessions.history()
        try history(sessions, messages, entries: [entry()])
        sessions.search = "会话"; sessions.workspace = ["/tmp/项目"]
        // 正文已加载但历史折叠；本测试显式驱动来源可见回调，避免滚动布局提前标读。
        XCTAssertFalse(sessions.historyExpanded)
        let controller = MainWindowController(model: model)
        model.showMainWindow = { [weak controller] in controller?.show() }
        let policy = LongLivedWindows.shared, spy = PolicySpy()
        let real = (policy.current, policy.apply); spy.install(policy)
        let other = offscreenWindow(titled: "Magic Code")
        other.animationBehavior = .none
        defer {
            other.close(); controller.window?.close(); controller.window?.contentViewController = nil
            controller.window?.delegate = nil; model.showMainWindow = nil
            model.requestQuit {}
            policy.current = real.0; policy.apply = real.1
        }
        model.manageSessions()
        let window = try XCTUnwrap(controller.window)
        window.animationBehavior = .none
        try await appKitEventually { window.isVisible && window.isKeyWindow && NSApp.isActive }
        try catalog(sessions, messages, [sessionRow()])
        other.makeKeyAndOrderFront(nil)
        try await appKitEventually { other.isKeyWindow && !window.isKeyWindow && NSApp.isActive }
        sessions.sourceVisible(notice.id, entry: 1, visible: true)
        XCTAssertTrue(messages.reads.isEmpty, "另一个同名窗口获得焦点不能激活会话读面")

        model.manageSettings()
        try await appKitEventually { window.isVisible && window.isKeyWindow && NSApp.isActive }
        model.selectMainPage(.sessions)
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        XCTAssertTrue(messages.reads.isEmpty, "切回会话不能沿用切页前的来源可见缓存")
        XCTAssertFalse(sessions.isPresenting(session: "one", notice: notice.id))
        model.manageSettings()
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        sessions.sourceVisible(notice.id, entry: 1, visible: true)
        XCTAssertTrue(messages.reads.isEmpty, "设置页可见时，即使收到会话来源可见回调也不得标读")
        XCTAssertFalse(sessions.isPresenting(session: "one", notice: notice.id))
        let historyRequests = messages.requests.filter { if case .history = $0 { return true }; return false }.count
        model.selectMainPage(.sessions)
        try await appKitEventually { window.isKeyWindow && NSApp.isActive }
        XCTAssertTrue(controller.window === window)
        XCTAssertEqual(sessions.search, "会话"); XCTAssertEqual(sessions.workspace, ["/tmp/项目"])
        XCTAssertEqual(sessions.selection, ["one"])
        XCTAssertEqual(sessions.entries.map(\.text), ["保存的完整回复"])
        XCTAssertEqual(messages.requests.filter { if case .history = $0 { return true }; return false }.count, historyRequests)
        if case .sessions(_, let archived, let workspace, let search) = messages.requests.last {
            XCTAssertEqual(archived, false); XCTAssertEqual(workspace, ["/tmp/项目"]); XCTAssertEqual(search, "会话")
        } else { XCTFail("切回会话应按保留的筛选重新查询目录") }
        XCTAssertTrue(messages.reads.isEmpty, "隐藏页迟到的正向回调不得缓存到切回后确认")
        XCTAssertFalse(sessions.isPresenting(session: "one", notice: notice.id))
        sessions.sourceVisible(notice.id, entry: 1, visible: true)
        XCTAssertEqual(messages.reads, [[notice.id]], "主窗口会话页在前台且来源可见时才标读")
        window.close()
        try await appKitEventually { !window.isVisible && !window.isKeyWindow }
        XCTAssertFalse(sessions.isPresenting(session: "one", notice: notice.id))
        try await eventually { !model.settingsBusy }
    }
}

/// 只替换短进程边界；平台锁、plist、实例选择与失败提交走正式实现。
private final class EnginePlatformFixture: @unchecked Sendable {
    let bundle: Bundle
    var busy = false
    var failBootstrap = false
    var bootstraps = 0
    var definition: [String: Any]?
    private var states: [String: String] = [:]
    private var parent = ""
    init(root: URL) throws {
        let app = root.appendingPathComponent("Platform.app"), contents = app.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": "com.magiccode.platformtest", "CFBundlePackageType": "APPL", "CFBundleExecutable": "control"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        bundle = try XCTUnwrap(Bundle(url: app))
    }
    func execute(_ executable: URL, _ arguments: [String], _ input: Data?) throws -> (Int32, Data) {
        if executable.path == "/bin/launchctl" {
            if arguments[0] == "bootout" {
                XCTAssertEqual(arguments[1], "gui/\(getuid())/com.magiccode.platformtest.engine")
                return (ESRCH, Data())
            }
            XCTAssertEqual(arguments[0], "bootstrap"); XCTAssertEqual(arguments[1], "gui/\(getuid())")
            bootstraps += 1
            definition = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: arguments[2])), format: nil) as? [String: Any]
            if failBootstrap { return (5, Data()) }
            states[parent] = "ready"; return (0, Data())
        }
        XCTAssertEqual(executable.lastPathComponent, "magic-runtime")
        XCTAssertEqual(arguments, ["--internal-engine-call"])
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(input)) as? [String: Any])
        parent = try XCTUnwrap(request["parent"] as? String)
        let action = try XCTUnwrap(request["action"] as? String)
        switch action {
        case "prepare": states[parent] = "starting"
        case "stop":
            if busy && request["idleOnly"] as? Bool == true {
                return (0, try JSONEncoder().encode(EngineControlResult(state: "failed", base: parent + "/.magic", alive: true, record: nil, error: "仍有工作")))
            }
            states[parent] = "stopped"
        case "fail-start": states[parent] = "failed"
        case "status": break
        default: XCTFail("unexpected \(action)")
        }
        let state = states[parent] ?? "stopped"
        let record = HostDiscovery(protocol: 1, version: "0.1.0", source: executable.path, serviceInstance: "test-generation", socket: parent + "/test.sock", base: parent + "/.magic", app: bundle.bundleURL.path, lifecycle: "test-lifecycle", pid: nil, startedAt: nil, state: state, request: nil, error: nil)
        return (0, try JSONEncoder().encode(EngineControlResult(state: state, base: record.base, alive: state == "ready", record: record, error: nil)))
    }
}

private final class NativeMessages {
    var requests: [NativeRequest] = []
    var catalog: String? { requests.reversed().compactMap { if case .sessions(let request, _, _, _) = $0 { return request }; return nil }.first }
    var history: String? { requests.reversed().compactMap { if case .history(let request, _, _, _) = $0 { return request }; return nil }.first }
    var inspect: String? { requests.reversed().compactMap { if case .inspect(let request, _, _) = $0 { return request }; return nil }.first }
    var reads: [[String]] { requests.compactMap { if case .read(_, let ids) = $0 { return ids }; return nil } }
}

extension NativeTests {
    private var testIdentity: ServiceIdentity { ServiceIdentity(protocol: 1, version: "0.1.0", source: "/tmp/helper", serviceInstance: "generation", base: "/tmp/native-data") }
    private func sessionRow(_ id: String = "one", archived: Bool = false, canArchive: Bool = true) -> NativeSession {
        NativeSession(id: id, title: "会话 \(id)", at: 1, workspace: ["/tmp/项目"], archived: archived, canArchive: canArchive,
                      terminalOpen: false, state: canArchive ? .idle : .running, reason: nil, recentInput: "最近交代", recentProgress: "保存的进展")
    }
    private func reason(_ id: String = "source-one", session: String = "one", entry: Int? = 1, event: Int? = nil) -> AttentionItem {
        AttentionItem(id: id, session: session, kind: .done, at: Date().timeIntervalSince1970 * 1000,
                      detail: "这是实际回复，保留中文组合字符 👩🏽‍💻", unread: true, delivered: false, fact: "event:\(id)",
                      source: AttentionSource(session: session, event: event, entry: entry))
    }
    private func reasonWork(_ notice: AttentionItem, archived: Bool = false, terminalOpen: Bool = false) throws -> NativeWork {
        try changed(work(), ["session": notice.session, "state": "idle", "affected": false, "gen": NSNull(),
                            "archived": archived, "canArchive": !archived, "terminalOpen": terminalOpen,
                            "currentNotice": JSONSerialization.jsonObject(with: JSONEncoder().encode(notice))])
    }
    @MainActor private func browser(works: [NativeWork] = []) -> (SessionBrowserModel, NativeMessages) {
        let model = SessionBrowserModel(), messages = NativeMessages()
        model.send = { messages.requests.append($0) }
        model.connect(identity: testIdentity, current: true, works: works)
        model.open()
        return (model, messages)
    }
    @MainActor private func catalog(_ model: SessionBrowserModel, _ messages: NativeMessages, _ rows: [NativeSession]) throws {
        model.receive(.sessionsResult(request: try XCTUnwrap(messages.catalog), serviceInstance: testIdentity.serviceInstance, sessions: rows, error: nil))
    }
    @MainActor private func history(_ model: SessionBrowserModel, _ messages: NativeMessages, entries: [HistoryEntry], events: [HistoryEvent] = [], currentRequests: [HistoryEvent] = [], next: Int? = nil, done: Bool = true) throws {
        model.receive(.historyResult(request: try XCTUnwrap(messages.history), serviceInstance: testIdentity.serviceInstance,
            session: model.selected?.id ?? model.route!.session, entries: entries, events: events, currentRequests: currentRequests, next: next, done: done, error: nil))
    }
    private func entry(_ id: Int = 1, text: String = "保存的完整回复") -> HistoryEntry {
        HistoryEntry(id: id, kind: "assistant", content: .object(["text": .string(text)]), payload: nil, at: 1, source: nil)
    }
    @MainActor func testCompactSessionNavigationRequiresExplicitOpenAndReopensNotice() throws {
        let notice = reason(), work = try reasonWork(notice)
        let (model, messages) = browser(works: [work])
        try catalog(model, messages, [sessionRow(), sessionRow("two")])
        model.selection = ["one"]; model.choose()
        XCTAssertFalse(model.compactDetail, "选中行与刷新选择不得自动离开窄窗列表")
        model.selection = ["one", "two"]; model.choose()
        XCTAssertFalse(model.compactDetail, "多选仍留在列表")
        model.showDetail("one")
        XCTAssertTrue(model.compactDetail)
        XCTAssertEqual(model.selection, ["one"])
        model.showCatalog()
        XCTAssertFalse(model.compactDetail)
        XCTAssertEqual(model.selection, ["one"], "返回列表保留当前选中项")
        model.choose()
        XCTAssertFalse(model.compactDetail)
        model.showDetail()
        XCTAssertTrue(model.compactDetail, "显式打开可继续使用保留的选择")

        let route = NoticeRoute(base: testIdentity.base, serviceInstance: testIdentity.serviceInstance, session: "one", notice: notice)
        model.open(route: route)
        XCTAssertTrue(model.compactDetail)
        model.showCatalog(); model.choose()
        XCTAssertFalse(model.compactDetail)
        XCTAssertEqual(model.selection, ["one"])
        model.open(route: route)
        XCTAssertTrue(model.compactDetail, "再次打开同一提醒也应恢复详情，不依赖 notice ID 变化")
        XCTAssertEqual(model.route, route)
        XCTAssertTrue(messages.reads.isEmpty, "导航本身不是来源已读")
    }
    @MainActor func testCurrentRequestSourceAcknowledgesOnlyWhileVisibleInForeground() throws {
        let notice = reason(entry: nil, event: 8), work = try reasonWork(notice)
        let (model, messages) = browser(works: [work])
        try catalog(model, messages, [sessionRow()])
        model.selection = ["one"]; model.choose(); model.showDetail(); model.history()
        let event = HistoryEvent(turn: nil, id: 8, session: "one", at: 1, kind: "tool.decision.request", data: .object(["material": .string("需要确认的操作")]))
        try history(model, messages, entries: [], currentRequests: [event])
        XCTAssertTrue(model.events.isEmpty, "当前待答来源不依赖历史 events 重复提供")
        XCTAssertEqual(model.currentRequests, [event])
        model.windowActive(true)
        XCTAssertTrue(messages.reads.isEmpty, "只收到待答内容不能标读")
        model.sourceVisible("another-notice", event: 8, visible: true)
        XCTAssertTrue(messages.reads.isEmpty, "其他提醒的可见回调不能标读当前提醒")
        model.windowActive(false)
        model.sourceVisible(notice.id, event: 8, visible: true)
        XCTAssertTrue(messages.reads.isEmpty, "后台可见不标读")
        model.sourceVisible(notice.id, event: 8, visible: false)
        model.windowActive(true)
        XCTAssertTrue(messages.reads.isEmpty, "回到前台时来源已离开视口，不得补标")
        model.sourceVisible(notice.id, event: 8, visible: true)
        XCTAssertEqual(messages.reads, [[notice.id]])
        if case .read(let service, let ids) = messages.requests.last {
            XCTAssertEqual(service, testIdentity.serviceInstance); XCTAssertEqual(ids, [notice.id])
        } else { XCTFail("实际可见的当前待答来源应发送标读请求") }
        model.sourceVisible(notice.id, event: 8, visible: true)
        model.windowActive(false); model.windowActive(true)
        XCTAssertEqual(messages.reads.count, 1, "同一来源的重复可见与前台事件不重复标读")
    }
    @MainActor func testCurrentRequestSourceRejectsMismatchEntryShortcutAndOldInstance() throws {
        let cases: [(label: String, eventID: Int, session: String, entryID: Int?, service: String)] = [
            ("不同事件", 9, "one", nil, testIdentity.serviceInstance),
            ("不同会话", 8, "two", nil, testIdentity.serviceInstance),
            ("entry 优先", 8, "one", 1, testIdentity.serviceInstance),
            ("旧实例", 8, "one", nil, "older-generation")
        ]
        for scenario in cases {
            let notice = reason(entry: scenario.entryID, event: 8), work = try reasonWork(notice)
            let (model, messages) = browser(works: [work])
            model.open(route: NoticeRoute(base: testIdentity.base, serviceInstance: scenario.service, session: "one", notice: notice))
            model.receive(.inspected(request: try XCTUnwrap(messages.inspect), work: work, error: nil))
            try catalog(model, messages, [sessionRow()])
            let event = HistoryEvent(turn: nil, id: scenario.eventID, session: scenario.session, at: 1, kind: "tool.decision.request", data: .object(["material": .string("需要确认的操作")]))
            try history(model, messages, entries: scenario.entryID.map { [entry($0)] } ?? [], currentRequests: [event])
            XCTAssertTrue(model.events.isEmpty)
            model.windowActive(true)
            model.sourceVisible(notice.id, event: 8, visible: true)
            XCTAssertTrue(messages.reads.isEmpty, "\(scenario.label)不能通过当前待答事件误标")
            if let entryID = scenario.entryID {
                model.sourceVisible(notice.id, entry: entryID, visible: true)
                XCTAssertEqual(messages.reads, [[notice.id]], "有 entry 时须看到对应正文才标读")
            }
        }
    }
    @MainActor func testSessionViewsKeepFiltersSelectionAndResumeReading() throws {
        let (model, messages) = browser()
        try catalog(model, messages, [sessionRow()])
        model.selection = ["one"]; model.choose(); model.historyExpanded = true; model.history()
        try history(model, messages, entries: [entry()])
        model.search = "会话"; model.workspace = ["/tmp/项目"]
        model.switchView(true)
        try catalog(model, messages, [sessionRow("archived", archived: true)])
        model.selection = ["archived"]; model.choose()
        model.switchView(false)
        XCTAssertEqual(model.selection, ["one"])
        let previousRequests = messages.requests.count
        try catalog(model, messages, [sessionRow()])
        XCTAssertGreaterThan(messages.requests.count, previousRequests, "同身份重返普通视图仍应读取所选历史")
        XCTAssertEqual(model.search, "会话"); XCTAssertEqual(model.workspace, ["/tmp/项目"])
        XCTAssertEqual(model.selected?.id, "one")
        XCTAssertTrue(messages.reads.isEmpty)
    }
    @MainActor func testSessionLateQueriesAndOfflineWritesDoNotChangeAuthority() throws {
        let (model, messages) = browser()
        let old = try XCTUnwrap(messages.catalog)
        model.search = "新搜索"; model.refresh()
        model.receive(.sessionsResult(request: old, serviceInstance: testIdentity.serviceInstance, sessions: [sessionRow("old")], error: nil))
        XCTAssertTrue(model.rows.isEmpty)
        try catalog(model, messages, [sessionRow()])
        model.disconnect()
        let before = messages.requests.count
        model.refresh(); model.manage([SessionManagement(session: "one", action: "archive")]); model.history()
        XCTAssertEqual(messages.requests.count, before)
        XCTAssertEqual(model.rows.first?.id, "one", "断线保留旧快照")
    }
    @MainActor func testSessionBatchKeepsPartialFailuresAndRestoresSeparately() throws {
        let (model, messages) = browser()
        try catalog(model, messages, [sessionRow(), sessionRow("two"), sessionRow("running", canArchive: false)])
        model.selection = ["one", "two", "running"]
        XCTAssertEqual(Set(model.eligible.map(\.id)), ["one", "two"])
        let items = model.eligible.map { SessionManagement(session: $0.id, action: "archive") }
        model.manage(items, request: "batch"); let before = messages.requests.count
        model.manage(items, request: "duplicate"); XCTAssertEqual(messages.requests.count, before)
        model.receive(.managed(request: "batch", serviceInstance: testIdentity.serviceInstance, results: [
            SessionManagementResult(session: "one", action: "archive", title: nil, ok: true, archived: true, error: nil),
            SessionManagementResult(session: "two", action: "archive", title: nil, ok: false, archived: nil, error: "另一入口刚开始执行")]))
        try catalog(model, messages, [sessionRow("two", canArchive: false), sessionRow("running", canArchive: false)])
        XCTAssertEqual(model.selection, ["two"]); XCTAssertTrue(model.operationMessage?.contains("刚开始执行") == true)
        model.refresh(); try catalog(model, messages, [sessionRow("two", canArchive: false)])
        XCTAssertTrue(model.operationMessage?.contains("刚开始执行") == true, "刷新不能抹掉操作错误")
        model.switchView(true); try catalog(model, messages, [sessionRow("one", archived: true)])
        model.selection = ["one"]; model.search = "会话"; model.workspace = ["/tmp/项目"]
        var copied = 0; model.copy = { _ in copied += 1 }
        model.copySelected(); XCTAssertEqual(copied, 0)
        model.manage([SessionManagement(session: "one", action: "restore")], request: "restore")
        model.receive(.managed(request: "restore", serviceInstance: testIdentity.serviceInstance, results: [SessionManagementResult(session: "one", action: "restore", title: nil, ok: true, archived: false, error: nil)]))
        try catalog(model, messages, [sessionRow()])
        XCTAssertFalse(model.archived); XCTAssertEqual(model.selection, ["one"]); XCTAssertEqual(copied, 0)
        XCTAssertEqual(model.search, "会话"); XCTAssertEqual(model.workspace, ["/tmp/项目"])
        model.copySelected(); XCTAssertEqual(copied, 1); XCTAssertTrue(messages.reads.isEmpty)
    }
    @MainActor func testRenameFailurePreservesInputAndArchivedHasNoRename() throws {
        let (model, messages) = browser()
        try catalog(model, messages, [sessionRow()]); model.selection = ["one"]; model.rename = "保留输入 👩🏽‍💻"
        model.manage([SessionManagement(session: "one", action: "rename", title: model.rename)], request: "rename")
        model.receive(.managed(request: "rename", serviceInstance: testIdentity.serviceInstance, results: [SessionManagementResult(session: "one", action: "rename", title: model.rename, ok: false, archived: nil, error: "已归档，请先恢复")]))
        XCTAssertEqual(model.rename, "保留输入 👩🏽‍💻"); XCTAssertTrue(model.operationMessage?.contains("先恢复") == true)
    }
    @MainActor func testOldNotificationReadsOriginalSourceAndKeepsNewestState() throws {
        let old = reason("old", entry: 1, event: 2), new = reason("new", entry: 3)
        let current = try reasonWork(new)
        let (model, messages) = browser(works: [current])
        let route = NoticeRoute(base: testIdentity.base, serviceInstance: testIdentity.serviceInstance, session: "one", notice: old)
        model.search = "挡住目标"; model.workspace = ["/elsewhere"]
        model.open(route: route)
        XCTAssertEqual(model.search, ""); XCTAssertTrue(model.workspace.isEmpty)
        if case .inspect(_, let session, let notice) = messages.requests.last { XCTAssertEqual(session, "one"); XCTAssertNil(notice) }
        else { XCTFail("来源状态必须按会话独立读取") }
        model.receive(.inspected(request: try XCTUnwrap(messages.inspect), work: current, error: nil))
        try catalog(model, messages, [sessionRow()])
        let event = HistoryEvent(turn: nil, id: 2, session: "one", at: 1, kind: "turn.end", data: .object([:]))
        try history(model, messages, entries: [entry()], events: [event])
        model.windowActive(true)
        model.sourceVisible(old.id, event: 2, visible: true)
        XCTAssertTrue(messages.reads.isEmpty, "有 entry 的来源不能因 turn.end 事件可见就已读")
        model.sourceVisible(old.id, entry: 1, visible: true)
        XCTAssertEqual(messages.reads, [["old"]]); XCTAssertFalse(model.routeIsCurrent)
        XCTAssertEqual(model.detailWork?.currentNotice?.id, "new")
        let archived = try reasonWork(new, archived: true)
        model.connect(identity: testIdentity, current: true, works: [])
        model.receive(.inspected(request: try XCTUnwrap(messages.inspect), work: archived, error: nil))
        try catalog(model, messages, [])
        XCTAssertEqual(model.selected?.id, "one"); XCTAssertTrue(model.selected?.archived == true)
        XCTAssertEqual(model.entries.first?.text, "保存的完整回复", "通知退出和归档不移走已阅读正文")
        XCTAssertEqual(model.route, route)
    }
    @MainActor func testSourceNeedsForegroundAndMatchingVisibleContentAndGeneration() throws {
        let notice = reason(entry: nil, event: 8), work = try reasonWork(notice)
        let (model, messages) = browser(works: [work])
        model.open(route: NoticeRoute(base: testIdentity.base, serviceInstance: "older-generation", session: "one", notice: notice))
        model.receive(.inspected(request: try XCTUnwrap(messages.inspect), work: work, error: nil))
        try catalog(model, messages, [sessionRow()])
        let event = HistoryEvent(turn: nil, id: 8, session: "one", at: 1, kind: "tool.decision.request", data: .object(["material": .string("需要确认的操作")]))
        try history(model, messages, entries: [], events: [event])
        model.windowActive(true); model.sourceVisible(notice.id, event: 8, visible: true)
        XCTAssertTrue(messages.reads.isEmpty, "旧实例来源可读，但不能回执到新实例")
        model.open(route: NoticeRoute(base: testIdentity.base, serviceInstance: testIdentity.serviceInstance, session: "one", notice: notice))
        model.receive(.inspected(request: try XCTUnwrap(messages.inspect), work: work, error: nil))
        try history(model, messages, entries: [], events: [event])
        model.windowActive(false); model.sourceVisible(notice.id, event: 8, visible: true)
        XCTAssertTrue(messages.reads.isEmpty)
        model.windowActive(true); XCTAssertEqual(messages.reads, [[notice.id]])
        model.sourceVisible(notice.id, event: 8, visible: true); XCTAssertEqual(messages.reads.count, 1)
    }
    @MainActor func testNotificationCrossBaseKeepsTargetWithoutQueryOrSwitch() throws {
        let (model, messages) = browser(); let before = messages.requests.count
        let route = NoticeRoute(base: "/another-instance", serviceInstance: "other", session: "one", notice: reason())
        model.open(route: route)
        XCTAssertEqual(model.route, route); XCTAssertEqual(messages.requests.count, before)
        XCTAssertTrue(model.historyError?.contains("另一数据位置") == true)
    }
    @MainActor func testNativeHistoryPagesKeepContentAndRejectLateSelectionReplies() throws {
        let (model, messages) = browser()
        try catalog(model, messages, [sessionRow(), sessionRow("two")])
        model.selection = ["one"]; model.choose(); model.history()
        try history(model, messages, entries: [entry()], next: 1, done: false)
        model.history()
        if case .history(_, let session, let after, _) = messages.requests.last { XCTAssertEqual(session, "one"); XCTAssertEqual(after, 1) }
        else { XCTFail("没有分页请求") }
        let late = try XCTUnwrap(messages.history)
        model.selection = ["two"]; model.choose()
        model.receive(.historyResult(request: late, serviceInstance: testIdentity.serviceInstance, session: "one", entries: [entry(2)], events: [], currentRequests: [], next: nil, done: true, error: nil))
        XCTAssertTrue(model.entries.isEmpty)
        XCTAssertTrue(messages.reads.isEmpty)
    }
    func testNotificationPayloadKeepsSourceAndStableSessionDeliveryIdentity() throws {
        let first = reason("old"), second = reason("new")
        let a = NoticeDelivery(work: try reasonWork(first), notice: first, identity: testIdentity)
        let b = NoticeDelivery(work: try reasonWork(second), notice: second, identity: testIdentity)
        XCTAssertEqual(a.identifier, b.identifier); XCTAssertNotEqual(a.route.notice.id, b.route.notice.id)
        XCTAssertEqual(a.body, first.detail); XCTAssertEqual(a.route.notice.source, first.source)
        let info: [AnyHashable: Any] = ["route": String(decoding: try JSONEncoder().encode(a.route), as: UTF8.self)]
        XCTAssertEqual(NotificationCoordinator.decodeRoute(info), a.route)
    }
    @MainActor func testNotificationSourceReplacementWithdrawsOldEvenWhenUpdateFails() async throws {
        var deliveries: [NoticeDelivery] = [], removed: [String] = [], acknowledged: [String] = []
        var fail = false
        let port = NotificationCoordinator(send: { delivery in if fail { throw WireError.invalid("拒绝投递") }; deliveries.append(delivery) }, remove: { removed += $0 })
        var failures: [String] = []; port.failure = { failures.append($0) }; port.delivered = { acknowledged += $0 }
        port.enabled = true; port.enabledSince = 0
        port.beginConnection(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 1, accepting: true, works: []), identity: testIdentity)
        let first = try reasonWork(reason("old"))
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 2, accepting: true, works: [first]), identity: testIdentity)
        try await eventually({ deliveries.count == 1 })
        fail = true
        let replacement = try reasonWork(reason("new"))
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 3, accepting: true, works: [replacement]), identity: testIdentity)
        XCTAssertEqual(removed, [deliveries[0].identifier], "更新投递前先撤下过期来源")
        try await eventually({ !failures.isEmpty })
        XCTAssertEqual(acknowledged, ["old"]); XCTAssertEqual(deliveries.count, 1)
        port.disconnect()
    }
    @MainActor func testTerminalFirstDepartureCanNotifyButReturnWithdrawsWithoutRedelivery() async throws {
        var deliveries: [NoticeDelivery] = [], removed: [String] = []
        let port = NotificationCoordinator(send: { deliveries.append($0) }, remove: { removed += $0 })
        port.enabled = true; port.enabledSince = 0
        port.beginConnection(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 1, accepting: true, works: []), identity: testIdentity)
        let notice = reason(), bound = try reasonWork(notice, terminalOpen: true), detached = try reasonWork(notice)
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 2, accepting: true, works: [bound]), identity: testIdentity)
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 3, accepting: true, works: [detached]), identity: testIdentity)
        try await eventually({ deliveries.count == 1 })
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 4, accepting: true, works: [bound]), identity: testIdentity)
        XCTAssertEqual(removed, [deliveries[0].identifier])
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 5, accepting: true, works: [detached]), identity: testIdentity)
        try await Task.sleep(for: .milliseconds(2100)); XCTAssertEqual(deliveries.count, 1)
        port.disconnect()
    }
    @MainActor func testDeliveryAcceptedAfterTerminalReturnIsWithdrawnWithoutReceipt() async throws {
        var pending: CheckedContinuation<Void, Never>?, removed: [String] = [], receipts: [String] = []
        let port = NotificationCoordinator(send: { _ in await withCheckedContinuation { pending = $0 } }, remove: { removed += $0 })
        port.enabled = true; port.enabledSince = 0; port.delivered = { receipts += $0 }
        port.beginConnection(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 1, accepting: true, works: []), identity: testIdentity)
        let notice = reason(), first = try reasonWork(notice)
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 2, accepting: true, works: [first]), identity: testIdentity)
        try await eventually({ pending != nil })
        port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 3, accepting: true, works: [try reasonWork(notice, terminalOpen: true)]), identity: testIdentity)
        pending?.resume(); pending = nil
        try await eventually({ !removed.isEmpty }); XCTAssertTrue(receipts.isEmpty)
        port.disconnect()
    }
    @MainActor func testPreDeliveryInspectRejectsChangedReasonArchiveAndBinding() async throws {
        for target in ["changed", "archived", "bound"] {
            var deliveries = 0, inspected = 0
            let port = NotificationCoordinator(send: { _ in deliveries += 1 })
            port.enabled = true; port.enabledSince = 0
            let notice = reason(), candidate = try reasonWork(notice)
            let refreshed = try reasonWork(target == "changed" ? reason("new") : notice, archived: target == "archived", terminalOpen: target == "bound")
            port.currentWorks = { sessions in inspected += 1; XCTAssertEqual(sessions, ["one"]); return [refreshed] }
            port.beginConnection(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 1, accepting: true, works: []), identity: testIdentity)
            port.observe(NativeProjection(serviceInstance: testIdentity.serviceInstance, revision: 2, accepting: true, works: [candidate]), identity: testIdentity)
            try await eventually({ inspected == 1 }); XCTAssertEqual(deliveries, 0, target)
            port.disconnect()
        }
    }
    @MainActor func testSessionWindowNativeLightDarkAndNarrowLayout() async throws {
        _ = NSApplication.shared
        let (model, messages) = browser()
        model.open(); try catalog(model, messages, [sessionRow(), sessionRow("中文很长的名称 👩🏽‍💻 é 不拆分组合字符")])
        for (width, appearance) in [(980.0, NSAppearance.Name.aqua), (460.0, .darkAqua)] {
            let window = try await hostView(SessionWindow(model: model), size: NSSize(width: width, height: 620), appearance: appearance)
            defer { window.close() }
            let view = try XCTUnwrap(window.contentView)
            view.layoutSubtreeIfNeeded()
            XCTAssertEqual(view.bounds.width, width, accuracy: 1)
            try await saveFrame(window, name: "u123-session-\(Int(width))")
        }
    }
}
