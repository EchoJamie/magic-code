import Foundation
import Darwin

/// One observer socket; all IO is serialized off the UI thread. It has no host capability.
final class ObserverConnection {
    private let queue = DispatchQueue(label: "MagicCode.observer")
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var lines = JSONLines()
    private var closed = false
    var receive: ((NativeResponse) -> Void)?
    var disconnected: ((String) -> Void)?

    func connect(path: String, identity: ServiceIdentity) {
        queue.async { [self] in
            guard !closed else { return }
            do {
                var address = sockaddr_un()
                address.sun_family = sa_family_t(AF_UNIX)
                address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
                let bytes = path.utf8CString
                guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw WireError.invalid("服务端点路径过长") }
                withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
                fd = socket(AF_UNIX, SOCK_STREAM, 0)
                guard fd >= 0 else { throw POSIXError(.EIO) }
                _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
                var one: Int32 = 1
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
                var timeout = timeval(tv_sec: 2, tv_usec: 0)
                setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
                let connected = withUnsafePointer(to: &address) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
                }
                guard connected == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECONNREFUSED) }
                let read = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
                read.setEventHandler { [weak self] in self?.readAvailable() }
                source = read; read.resume()
                write(.hello(role: "observer", protocol: identity.protocol, version: identity.version, source: identity.source, base: identity.base))
            } catch { fail(error.localizedDescription) }
        }
    }
    func send(_ request: NativeRequest) { queue.async { [weak self] in self?.write(request) } }
    private func write(_ request: NativeRequest) {
        guard fd >= 0, !closed else { return }
        do {
            var data = try JSONEncoder().encode(request); data.append(10)
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw POSIXError(.EPIPE) }
                    offset += count
                }
            }
        } catch { fail(error.localizedDescription) }
    }
    private func readAvailable() {
        var buffer = [UInt8](repeating: 0, count: 65536)
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count < 0 && errno == EINTR { return }
        guard count > 0 else { fail("核心连接已断开"); return }
        do {
            for line in try lines.append(Data(buffer.prefix(count))) {
                let message = try JSONDecoder().decode(NativeResponse.self, from: line)
                MainRunLoop.deliver { [weak self] in self?.receive?(message) }
            }
        } catch { fail("核心协议无效：\(error.localizedDescription)") }
    }
    private func fail(_ reason: String) {
        guard !closed else { return }
        finish()
        MainRunLoop.deliver { [weak self] in self?.disconnected?(reason) }
    }
    private func finish() {
        closed = true; source?.cancel(); source = nil
        if fd >= 0 { Darwin.close(fd); fd = -1 }
    }
    func close() { queue.async { [self] in finish() } }
    deinit { if fd >= 0 { Darwin.close(fd) } }
}

// 模态面板与系统退出等待期间也必须能处理连接完成。
enum MainRunLoop {
    static let modal = RunLoop.Mode("NSModalPanelRunLoopMode")
    static func deliver(_ body: @escaping () -> Void) {
        RunLoop.main.perform(inModes: [.default, .common, modal, RunLoop.Mode("NSEventTrackingRunLoopMode")], block: body)
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }
}
