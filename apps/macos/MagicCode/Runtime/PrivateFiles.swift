import Foundation
import Darwin

enum PrivateFiles {
    static func directory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var st = stat()
        guard lstat(url.path, &st) == 0, st.st_uid == getuid(), st.st_mode & S_IFMT == S_IFDIR else {
            throw WireError.invalid("目录不属于当前用户或不是普通目录：\(url.path)")
        }
        guard chmod(url.path, 0o700) == 0 else { throw POSIXError(.EACCES) }
    }

    static func write(_ data: Data, to url: URL, mode: mode_t = 0o600) throws {
        try directory(url.deletingLastPathComponent())
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        try handle.write(contentsOf: data)
        guard fsync(fd) == 0, rename(temporary.path, url.path) == 0 else { throw POSIXError(.EIO) }
    }
}

final class HostPublication {
    let directory: URL
    var file: URL { directory.appendingPathComponent("host.json") }
    private var lockFD: Int32 = -1
    init(directory: URL) { self.directory = directory }
    func acquire() throws {
        try PrivateFiles.directory(directory)
        lockFD = open(directory.appendingPathComponent("host.lock").path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lockFD >= 0 else { throw POSIXError(.EACCES) }
        guard flock(lockFD, LOCK_EX) == 0 else {
            close(lockFD); lockFD = -1
            throw WireError.invalid("另一个 Magic Code 已在运行。请退出原 App 后再打开此版本。")
        }
    }
    deinit { if lockFD >= 0 { close(lockFD) } }
}
