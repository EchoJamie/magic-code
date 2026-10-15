import Foundation

/// 仅用于跨语言文件契约测试；正式 App 在进程内直接调用相同原生实现。
@main struct SettingsHarness {
    static func main() async throws {
        let request = try JSONDecoder().decode(SettingsValue.self, from: FileHandle.standardInput.readDataToEndOfFile())
        if CommandLine.arguments.count == 5, CommandLine.arguments[2] == "hold-lock" {
            try SettingsFile.withLock(request["configPath"].text) {
                try Data().write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
                let deadline = Date().addingTimeInterval(10)
                while !FileManager.default.fileExists(atPath: CommandLine.arguments[4]), Date() < deadline { Thread.sleep(forTimeInterval: 0.002) }
            }
            return
        }
        let result = try await SettingsCall.run(metadataURL: URL(fileURLWithPath: CommandLine.arguments[1]), request: request, environment: ProcessInfo.processInfo.environment)
        FileHandle.standardOutput.write(try JSONEncoder().encode(result))
    }
}
