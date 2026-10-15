import Foundation
import Darwin

/// 与 @magic/config 共用文件身份、O_EXCL 锁与原子替换协议。
enum SettingsFile {
    static func canonical(_ path: String) -> String {
        if let pointer = realpath(path, nil) { defer { free(pointer) }; return String(cString: pointer) }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let parent = url.deletingLastPathComponent().path
        if let pointer = realpath(parent, nil) { defer { free(pointer) }; return String(cString: pointer) + "/" + url.lastPathComponent }
        return url.path
    }
    static func stamp(_ path: String) -> String? {
        let path = canonical(path)
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        let modified = Int64(info.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(info.st_mtimespec.tv_nsec)
        let changed = Int64(info.st_ctimespec.tv_sec) * 1_000_000_000 + Int64(info.st_ctimespec.tv_nsec)
        return "\(path):\(info.st_dev):\(info.st_ino):\(modified):\(changed):\(info.st_size)"
    }
    static func read(_ path: String) throws -> SettingsValue {
        let data: Data
        do { data = try Data(contentsOf: URL(fileURLWithPath: path)) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return .object([:]) }
        catch { throw WireError.invalid("文件无法读取，请检查路径与权限") }
        guard let value = try? JSONDecoder().decode(SettingsValue.self, from: data), case .object = value else {
            throw WireError.invalid("文件须是合法 JSON 对象，请先修复再修改")
        }
        return value
    }
    static func withLock<T>(_ path: String, cache: Bool = false, _ body: () throws -> T) throws -> T {
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = (cache ? path : canonical(path)) + ".lock"
        let deadline = Date().addingTimeInterval(cache ? 2 : 1)
        while true {
            let fd = open(lock, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            if fd >= 0 {
                if !cache {
                    let data = Data("{\"pid\":\(getpid()),\"at\":\(Int64(Date().timeIntervalSince1970 * 1000))}\n".utf8)
                    let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
                    if count != data.count { close(fd); unlink(lock); throw WireError.invalid("文件锁无法写入") }
                }
                close(fd)
                break
            }
            guard errno == EEXIST else { throw WireError.invalid("文件不可写，请检查路径与权限") }
            if !cache, abandoned(lock) { unlink(lock); continue }
            guard Date() < deadline else { throw WireError.invalid("文件正在写入，请稍后重试；输入已保留") }
            Thread.sleep(forTimeInterval: cache ? 0.005 : 0.002)
        }
        defer { unlink(lock) }
        return try body()
    }
    private static func abandoned(_ path: String) -> Bool {
        var info = stat()
        guard stat(path, &info) == 0, Date().timeIntervalSince1970 - Double(info.st_mtimespec.tv_sec) - Double(info.st_mtimespec.tv_nsec) / 1e9 > 10,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let value = try? JSONDecoder().decode(SettingsValue.self, from: data) else { return false }
        guard let pid = value["pid"].number else { return true }
        guard pid >= Double(Int32.min), pid <= Double(Int32.max), pid.rounded() == pid else { return false }
        return kill(Int32(pid), 0) != 0 && errno == ESRCH
    }
    static func replace(_ value: SettingsValue, at path: String, expected: String?) throws {
        let temp = path + ".tmp-\(getpid())-\(UUID().uuidString)"
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(value); data.append(10)
        let fd = open(temp, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw WireError.invalid("临时文件无法创建") }
        defer { close(fd); unlink(temp) }
        var offset = 0
        try data.withUnsafeBytes { bytes in
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw WireError.invalid("文件无法写入") }
                offset += count
            }
        }
        guard stamp(path) == expected else { throw WireError.invalid("文件已被修改，请重新读取后再保存；输入已保留") }
        guard rename(temp, path) == 0 else { throw WireError.invalid("文件无法原子保存") }
    }
    static func edit(_ path: String, expected: String?, _ update: (SettingsValue) throws -> SettingsValue) throws {
        try withLock(path) {
            guard stamp(path) == expected else { throw WireError.invalid("文件已被修改，请重新读取后再保存；输入已保留") }
            let next = try update(read(path))
            try replace(next, at: path, expected: expected)
        }
    }
}

extension SettingsValue {
    var isObject: Bool { if case .object = self { return true }; return false }
    var isArray: Bool { if case .array = self { return true }; return false }
    var isText: Bool { if case .string = self { return true }; return false }
    var isBool: Bool { if case .bool = self { return true }; return false }
    var nonempty: Bool { isText && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    mutating func put(_ key: String, _ value: SettingsValue?) { var fields = object; fields[key] = value; self = .object(fields) }
}
