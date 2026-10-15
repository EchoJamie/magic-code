import Foundation

struct EngineControlResult: Codable {
    let state: String
    let base: String?
    let alive: Bool?
    let record: HostDiscovery?
    let error: String?
}

/// App 只调用选定 Engine 的管理入口；平台托管与收尾责任由 Engine 持有。
enum EngineControl {
    static func run(engine: URL, action: String, home: URL, parent: URL? = nil,
                    expected: ServiceIdentity? = nil, request: String = UUID().uuidString) async throws -> EngineControlResult {
        var arguments = ["service", action, "--home", home.path, "--request", request]
        if let parent { arguments += ["--parent", parent.path] }
        if let expected { arguments += ["--expected", String(decoding: try JSONEncoder().encode(expected), as: UTF8.self)] }
        let (code, data) = try await executeAsync(engine, arguments)
        let result = try JSONDecoder().decode(EngineControlResult.self, from: data)
        guard code == 0 || result.base != nil else { throw WireError.invalid(result.error ?? "Engine 控制失败") }
        return result
    }
    static func executeAsync(_ executable: URL, _ arguments: [String]) async throws -> (Int32, Data) {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try execute(executable, arguments)) }
                catch { continuation.resume(throwing: error) }
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
}

struct InstalledComponents: Codable {
    let engine: String
    let cli: String?
    let command: String?
}
enum ComponentInstallation {
    static func directory(_ home: URL) -> URL { home.appendingPathComponent("Library/Application Support/Magic Code") }
    static func read(_ home: URL) throws -> InstalledComponents {
        let file = directory(home).appendingPathComponent("components.json")
        guard let value = try? JSONDecoder().decode(InstalledComponents.self, from: Data(contentsOf: file)),
              value.engine.hasPrefix("/"), value.cli.map({ $0.hasPrefix("/") }) ?? true, value.command.map({ $0.hasPrefix("/") }) ?? true else {
            throw WireError.invalid("组件未安装或登记无效，请在设置中修复组件安装")
        }
        return value
    }
    static func engine(_ home: URL) throws -> URL {
        let path = try read(home).engine
        guard FileManager.default.isExecutableFile(atPath: path) else { throw WireError.invalid("缺少 Engine，请在设置中修复组件安装") }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath()
    }
    static func cli(_ home: URL) throws -> URL {
        guard let path = try read(home).cli, FileManager.default.isExecutableFile(atPath: path) else {
            throw WireError.invalid("缺少终端组件，请在设置 → App → 管理命令中修复安装")
        }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath()
    }
    static func selectedParent(_ home: URL, legacyParent: String? = nil) throws -> URL {
        let file = directory(home).appendingPathComponent("engine.json")
        if !FileManager.default.fileExists(atPath: file.path) { return legacyParent.map { URL(fileURLWithPath: $0) } ?? home }
        let value = try SettingsFile.read(file.path)
        guard value["parent"].text.hasPrefix("/") else { throw WireError.invalid("Engine 数据目标无效，请先修复实例选择") }
        return URL(fileURLWithPath: value["parent"].text)
    }
    static func install(app: URL, home: URL, bin: String? = nil, legacyParent: String? = nil, upgrade: Bool = false) async throws -> InstalledComponents {
        guard !app.path.hasPrefix("/Volumes/") else { throw WireError.invalid("请先把 App 移到 Applications，再完成组件安装") }
        let payload = app.appendingPathComponent("Contents/Helpers")
        var arguments = ["install", "--profile", "app", "--payload", payload.path, "--home", home.path]
        if let bin { arguments += ["--bin", bin] }; if let legacyParent { arguments += ["--legacy-parent", legacyParent] }
        if upgrade { arguments += ["--upgrade-engine", "--upgrade-cli"] }
        let (code, data) = try await EngineControl.executeAsync(payload.appendingPathComponent("magic-engine"), arguments)
        let result = try JSONDecoder().decode(SettingsValue.self, from: data)
        guard code == 0, result["components"].isObject else { throw WireError.invalid(result["error"].text.isEmpty ? "组件安装未完成，请检查缺失组件后重试" : result["error"].text) }
        return try JSONDecoder().decode(InstalledComponents.self, from: JSONEncoder().encode(result["components"]))
    }
}
