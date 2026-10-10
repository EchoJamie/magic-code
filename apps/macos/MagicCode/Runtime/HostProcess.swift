import Foundation
import Darwin

struct EngineControlResult: Codable {
    let state: String
    let base: String?
    let alive: Bool?
    let record: HostDiscovery?
    let error: String?
}

/// 一次性平台入口；读取原生实例选择并序列化 launchd 生命周期操作。
/// 图形 App 只等待结果，退出 App 不会取消这个进程。
enum EngineControl {
    static func run(app: URL, action: String, home: URL? = nil, parent: URL? = nil,
                    expected: ServiceIdentity? = nil, request: String = UUID().uuidString) async throws -> EngineControlResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    guard let bundle = Bundle(url: app), var executable = bundle.executableURL else { throw WireError.invalid("找不到同包平台入口") }
                    #if DEBUG
                    let fixture = app.appendingPathComponent("Contents/Resources/controlled-helper.py")
                    if AppModel.systemTestRoot(bundle: bundle) != nil, FileManager.default.isExecutableFile(atPath: fixture.path) { executable = fixture }
                    #endif
                    var arguments = ["--internal-engine-control", action, "--request", request]
                    if let home { arguments += ["--validation-root", home.path] }
                    if let parent { arguments += ["--parent", parent.path] }
                    if let expected { arguments += ["--expected", String(decoding: try JSONEncoder().encode(expected), as: UTF8.self)] }
                    let (code, data) = try execute(executable, arguments)
                    let result = try JSONDecoder().decode(EngineControlResult.self, from: data)
                    guard code == 0 || result.base != nil else { throw WireError.invalid(result.error ?? "Engine 平台控制失败") }
                    continuation.resume(returning: result)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    static func execute(_ executable: URL, _ arguments: [String], input: Data? = nil) throws -> (Int32, Data) {
        let process = Process(), output = Pipe()
        process.executableURL = executable; process.arguments = arguments
        process.standardOutput = output; process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        let pipe = input.map { _ in Pipe() }
        if let pipe { process.standardInput = pipe }
        try process.run()
        if let pipe, let input { try pipe.fileHandleForWriting.write(contentsOf: input); try pipe.fileHandleForWriting.close() }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, data)
    }
    static func perform(_ arguments: [String], bundle: Bundle = .main,
                        execute: (URL, [String], Data?) throws -> (Int32, Data) = EngineControl.execute) throws -> EngineControlResult {
        func value(_ name: String) -> String? { arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        guard let action = arguments.first, ["status", "start", "stop", "switch", "remove"].contains(action) else { throw WireError.invalid("无效 Engine 动作") }
        let app = bundle.bundleURL.resolvingSymlinksInPath()
        let helper = app.appendingPathComponent("Contents/Helpers/magic-runtime").resolvingSymlinksInPath()
        #if DEBUG
        let validation = AppModel.systemTestRoot(bundle: bundle) ?? value("--validation-root").map { URL(fileURLWithPath: $0) }
        #else
        let validation: URL? = nil
        #endif
        if bundle.bundleIdentifier?.hasPrefix("com.magiccode.validation.") == true, validation == nil { throw WireError.invalid("系统验收隔离根无效，拒绝控制") }
        let home = validation ?? FileManager.default.homeDirectoryForCurrentUser
        let defaults = validation.map { UserDefaults(suiteName: "\($0.path)/MagicCode.Validation")! } ?? .standard
        var parent = defaults.string(forKey: "baseDirectory").map { URL(fileURLWithPath: $0) } ?? home
        let directory = home.appendingPathComponent("Library/Application Support/Magic Code/runtime")
        let lock = HostPublication(directory: directory)
        let label = (bundle.bundleIdentifier ?? "com.magiccode.app") + ".engine"
        let target = "gui/\(getuid())/\(label)", plist = directory.appendingPathComponent("engine.plist")
        let request = value("--request") ?? UUID().uuidString
        let expected = try value("--expected").map { try JSONDecoder().decode(ServiceIdentity.self, from: Data($0.utf8)) }
        func call(_ operation: String, record: HostDiscovery? = nil, lifecycle: String? = nil, idleOnly: Bool = false, error: String? = nil) throws -> EngineControlResult {
            var input: [String: Any] = ["action": operation, "home": home.path, "parent": parent.path, "app": app.path,
                "source": helper.path, "discovery": lock.file.path, "request": request, "idleOnly": idleOnly, "systemTaskRemoved": operation == "reclaim"]
            if let error { input["error"] = error }
            if let identity = expected ?? record?.identity { input["expected"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(identity)) }
            if let lifecycle { input["lifecycle"] = lifecycle }
            let (code, data) = try execute(helper, ["--internal-engine-call"], JSONSerialization.data(withJSONObject: input))
            let result = try JSONDecoder().decode(EngineControlResult.self, from: data)
            guard code == 0 else { throw WireError.invalid(result.error ?? "Engine 控制读取失败") }
            return result
        }
        func bootout() throws {
            let (code, _) = try execute(URL(fileURLWithPath: "/bin/launchctl"), ["bootout", target], nil)
            guard code == 0 || code == ESRCH else { throw WireError.invalid("无法移除 Engine 系统任务（launchctl \(code)）") }
        }
        func stop(_ current: EngineControlResult, idleOnly: Bool) throws -> EngineControlResult {
            guard let record = current.record else { try bootout(); return current }
            var result = current
            if current.alive == true && current.state != "unreachable" {
                result = try call("stop", record: record, idleOnly: idleOnly)
                if result.state == "failed" { return result }
            }
            if idleOnly && result.state != "stopped" { throw WireError.invalid("原 Engine 失联，无法核实空闲；请先明确停止 Engine") }
            try bootout()
            if result.state != "stopped" {
                let deadline = Date().addingTimeInterval(10)
                repeat {
                    let state = try call("status", record: record)
                    if state.alive == false || (state.record?.pid == nil && state.state == "starting") { break }
                    if Date() > deadline { throw WireError.invalid("系统任务已移除，但原 Engine 退出尚未确认") }
                    Thread.sleep(forTimeInterval: 0.05)
                } while true
                result = try call("reclaim", record: record)
            }
            return result
        }
        func start() throws -> EngineControlResult {
            var current = try call("status")
            let pendingUntil = Date().addingTimeInterval(20)
            while current.state == "starting", Date() < pendingUntil {
                Thread.sleep(forTimeInterval: 0.05); current = try call("status")
            }
            if current.state == "ready" { return current }
            guard current.alive == false else { throw WireError.invalid(current.error ?? "旧 Engine 未确认停止，请先明确停止") }
            try bootout()
            let lifecycle = UUID().uuidString
            _ = try call("prepare", lifecycle: lifecycle)
            let logs = parent.appendingPathComponent(".magic/logs")
            try PrivateFiles.directory(logs)
            let startup = logs.appendingPathComponent("manager-startup.jsonl")
            if let size = try? startup.resourceValues(forKeys: [.fileSizeKey]).fileSize, size >= 10 * 1024 * 1024 { try PrivateFiles.write(Data(), to: startup) }
            if !FileManager.default.fileExists(atPath: startup.path) { try PrivateFiles.write(Data(), to: startup) }
            let definition: [String: Any] = ["Label": label, "ProgramArguments": [helper.path, "--internal-engine", "--home", home.path,
                "--parent", parent.path, "--source", helper.path, "--app", app.path, "--discovery", lock.file.path, "--lifecycle", lifecycle],
                "RunAtLoad": true, "KeepAlive": ["SuccessfulExit": false], "WorkingDirectory": home.path,
                "StandardOutPath": startup.path, "StandardErrorPath": startup.path]
            try PrivateFiles.write(PropertyListSerialization.data(fromPropertyList: definition, format: .xml, options: 0), to: plist)
            let (code, _) = try execute(URL(fileURLWithPath: "/bin/launchctl"), ["bootstrap", "gui/\(getuid())", plist.path], nil)
            guard code == 0 else {
                return try call("fail-start", lifecycle: lifecycle, error: "系统拒绝启动 Engine（launchctl \(code)），请检查该任务的系统允许状态")
            }
            let deadline = Date().addingTimeInterval(20)
            repeat {
                current = try call("status")
                if current.state == "ready" || current.state == "failed" { return current }
                Thread.sleep(forTimeInterval: 0.05)
            } while Date() < deadline
            throw WireError.invalid("Engine 启动尚未就绪")
        }
        func checkBase() throws {
            if let base = value("--base"), URL(fileURLWithPath: base).resolvingSymlinksInPath() != parent.appendingPathComponent(".magic").resolvingSymlinksInPath() {
                throw WireError.invalid("终端指定的数据实例与当前选择不一致，未执行 Engine 控制")
            }
        }
        if action == "status" { try checkBase(); return try call("status") }
        try lock.acquire()
        defaults.synchronize()
        parent = defaults.string(forKey: "baseDirectory").map { URL(fileURLWithPath: $0) } ?? home
        try checkBase()
        let current = try call("status")
        if action == "start" { return try start() }
        let wasRunning = current.state == "ready" || current.state == "stopping"
        let stopped = try stop(current, idleOnly: action == "switch" && current.state != "stopped" && current.state != "failed")
        guard stopped.state == "stopped" else { return stopped }
        if action == "switch" {
            guard let path = value("--parent"), path.hasPrefix("/") else { throw WireError.invalid("基础路径必须为绝对路径") }
            parent = URL(fileURLWithPath: path).standardizedFileURL
            defaults.set(parent.path, forKey: "baseDirectory"); defaults.synchronize()
            // 旧发现属于旧实例，停止结果已确认后才移除。
            try? FileManager.default.removeItem(at: lock.file)
            try? FileManager.default.removeItem(at: plist)
            if !wasRunning { return try call("status") }
            do { return try start() }
            catch { return EngineControlResult(state: "failed", base: parent.appendingPathComponent(".magic").path, alive: nil, record: nil, error: error.localizedDescription) }
        }
        if action == "remove" { try? FileManager.default.removeItem(at: plist); try? FileManager.default.removeItem(at: lock.file) }
        return stopped
    }
}
