import Foundation
import Darwin

enum LogLevel: String, Codable, CaseIterable {
    case error, warn, info, debug, trace
    var priority: Int { Self.allCases.firstIndex(of: self)! }
}
struct Diagnostics: Codable, Equatable {
    var debugMode: Bool
    var logLevel: LogLevel
    static let defaults = Diagnostics(debugMode: false, logLevel: .info)
    static func arguments(_ args: [String]) throws -> [String] {
        var debug: Bool?, level: LogLevel?
        var result: [String] = [], index = 0
        while index < args.count {
            let arg = args[index]
            if arg == "--debug" || arg == "--no-debug" {
                let value = arg == "--debug"
                if let debug, debug != value { throw WireError.invalid("--debug 与 --no-debug 不能同时使用") }
                debug = value; result.append(arg)
            } else if arg == "--log-level" {
                index += 1
                guard index < args.count, let value = LogLevel(rawValue: args[index]) else { throw WireError.invalid("--log-level 须指定 error / warn / info / debug / trace") }
                if let level, level != value { throw WireError.invalid("--log-level 不能指定不同等级") }
                level = value; result += [arg, value.rawValue]
            }
            index += 1
        }
        return result
    }
}

/// A bounded utility queue. No wire payload, arbitrary error text or user content enters this API.
final class DiagnosticFileLog: @unchecked Sendable {
    private let queue = DispatchQueue(label: "MagicCode.file-log", qos: .utility)
    private let capacity = DispatchSemaphore(value: 1024)
    private let dropLock = NSLock()
    private var dropped = 0
    private var closed = false
    private var level = LogLevel.info
    private var identifiers: [String: String] = [:]
    private var directory: URL?
    private var file: FileHandle?
    private var path: URL?
    private var size = 0
    private var part = 0
    private let start = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)"
    private var problem: String?
    private let fileLimit = 10 * 1024 * 1024
    private let totalLimit = 100 * 1024 * 1024
    var changed: ((String?) -> Void)?

    func configure(dataDir: String, level: LogLevel, completion: @escaping (String?) -> Void) {
        queue.async { [self] in
            guard !closed else { MainRunLoop.deliver { completion("日志已关闭") }; return }
            do {
                let target = URL(fileURLWithPath: dataDir).appendingPathComponent("logs")
                if directory != target { try finishFile(); directory = target }
                self.level = level
                if file == nil { try rotate() }
                problem = nil
                writeNow(.info, "diagnostics.applied")
            } catch { problem = "日志写入失败，请检查目录权限与磁盘空间" }
            let result = problem
            MainRunLoop.deliver { completion(result) }
        }
    }
    func identify(host: String, service: String?) {
        queue.async { [self] in identifiers = ["hostInstance": host]; identifiers["serviceInstance"] = service }
    }
    func write(_ level: LogLevel, _ event: String, request: String? = nil) {
        guard event.range(of: "^[a-z][a-z0-9.-]{0,79}$", options: .regularExpression) != nil else { return }
        guard capacity.wait(timeout: .now()) == .success else { dropLock.lock(); dropped += 1; dropLock.unlock(); return }
        queue.async { [self] in
            defer { capacity.signal() }
            writeNow(level, event, request: request)
            dropLock.lock(); let count = dropped; dropped = 0; dropLock.unlock()
            if count > 0 { writeNow(.warn, "log.dropped", count: count) }
        }
    }
    private func writeNow(_ level: LogLevel, _ event: String, count: Int? = nil, request: String? = nil) {
        guard !closed, level.priority <= self.level.priority, directory != nil else { return }
        do {
            var record: [String: Any] = ["time": Int(Date().timeIntervalSince1970 * 1000), "level": level.rawValue, "component": "app", "event": event, "message": event, "pid": ProcessInfo.processInfo.processIdentifier]
            for (key, value) in identifiers { record[key] = value }
            if let request, request.range(of: "^[a-zA-Z0-9_-]{1,100}$", options: .regularExpression) != nil { record["request"] = request }
            if let count { record["count"] = count }
            var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]); data.append(10)
            if file == nil || size + data.count > fileLimit { try rotate() }
            try file?.write(contentsOf: data); size += data.count
            if problem != nil { problem = nil; MainRunLoop.deliver { [weak self] in self?.changed?(nil) } }
        } catch {
            problem = "日志写入失败，请检查目录权限与磁盘空间"
            MainRunLoop.deliver { [weak self] in self?.changed?("日志写入失败，请检查目录权限与磁盘空间") }
        }
    }
    private func finishFile() throws {
        if let file { try file.close(); self.file = nil }
        if let path { try FileManager.default.moveItem(at: path, to: URL(fileURLWithPath: path.path.replacingOccurrences(of: ".active.jsonl", with: ".jsonl"))); self.path = nil }
    }
    private func rotate() throws {
        try finishFile()
        guard let directory else { return }
        try PrivateFiles.directory(directory)
        let path = directory.appendingPathComponent("app-\(getpid())-\(start)-\(part).active.jsonl"); part += 1
        let fd = open(path.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw POSIXError(.EACCES) }
        file = FileHandle(fileDescriptor: fd, closeOnDealloc: true); self.path = path; size = 0
        try prune()
    }
    private func prune() throws {
        guard let directory else { return }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]).filter { $0.lastPathComponent.range(of: "^(app|manager|executor)-.*\\.jsonl$", options: .regularExpression) != nil }
        let entries = files.compactMap { path -> (URL, Int, Date)? in
            guard let v = try? path.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (path, v.fileSize ?? 0, v.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(0) { $0 + $1.1 }
        for entry in entries.filter({ !$0.0.lastPathComponent.hasSuffix(".active.jsonl") }).sorted(by: { $0.2 < $1.2 }) {
            if total <= totalLimit - fileLimit { break }
            if (try? FileManager.default.removeItem(at: entry.0)) != nil { total -= entry.1 }
        }
    }
    func close(_ completion: @escaping () -> Void) {
        let lock = NSLock()
        var finished = false
        let finish = {
            lock.lock(); let first = !finished; finished = true; lock.unlock()
            if first { MainRunLoop.deliver(completion) }
        }
        queue.async { [self] in closed = true; try? finishFile(); try? prune(); finish() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2, execute: finish)
    }
}
