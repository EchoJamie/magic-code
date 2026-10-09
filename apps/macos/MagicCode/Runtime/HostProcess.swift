import Foundation
import Darwin

/// Process owns only the read side of stdin. The App's CLOEXEC writer never enters its descendants.
final class HostProcess {
    let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let diagnostics = Pipe()
    private let readQueue = DispatchQueue(label: "MagicCode.host.read")
    private let writeQueue = DispatchQueue(label: "MagicCode.host.write")
    private var lines = JSONLines()
    private let drains = DispatchGroup()
    var received: ((HostResponse) -> Void)?
    var exited: ((Int32) -> Void)?
    var diagnostic: ((String) -> Void)?

    func start(helper: URL, app: URL, instance: String, base: URL, home: URL, environment: [String: String], diagnosticsArguments: [String] = []) throws {
        process.executableURL = helper
        process.arguments = ["--internal-manager", "--host-instance", instance, "--app", app.path] + diagnosticsArguments
        process.currentDirectoryURL = home
        var env = environment
        env["MAGIC_HOME"] = base.path
        process.environment = env
        process.standardInput = input; process.standardOutput = output; process.standardError = diagnostics
        _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC)
        process.terminationHandler = { [weak self] process in
            guard let self else { return }
            self.drains.notify(queue: .global(qos: .utility)) { [weak self] in MainRunLoop.deliver { [weak self] in self?.exited?(process.terminationStatus) } }
        }
        drains.enter(); drains.enter()
        do { try process.run() } catch { drains.leave(); drains.leave(); throw error }
        readQueue.async { [self] in
            defer { drains.leave() }
            do {
                while let data = try Self.readChunk(output.fileHandleForReading.fileDescriptor) {
                    for line in try lines.append(data) {
                        let response = try JSONDecoder().decode(HostResponse.self, from: line)
                        MainRunLoop.deliver { [weak self] in self?.received?(response) }
                    }
                }
            } catch {
                MainRunLoop.deliver { [weak self] in self?.received?(.error(reason: "宿主协议无效：\(error.localizedDescription)")) }
                // A malformed frame must not leave an undrained stdout blocking the manager.
                while (try? Self.readChunk(output.fileHandleForReading.fileDescriptor)) != nil {}
            }
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            defer { drains.leave() }
            while let data = try? Self.readChunk(diagnostics.fileHandleForReading.fileDescriptor) {
                let text = String(decoding: data, as: UTF8.self)
                MainRunLoop.deliver { [weak self] in self?.diagnostic?(text) }
            }
        }
        // Explicit parent copies: closing App always delivers EOF, even if a Terminal is alive.
        try input.fileHandleForReading.close()
        try output.fileHandleForWriting.close()
        try diagnostics.fileHandleForWriting.close()
    }
    private static func readChunk(_ fd: Int32) throws -> Data? {
        var bytes = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            return count == 0 ? nil : Data(bytes.prefix(count))
        }
    }
    func shutdown(request: String) { send(.shutdown(request: request)) }
    func send(_ message: HostRequest) {
        writeQueue.async { [weak self] in
            guard let self else { return }
            do {
                var data = try JSONEncoder().encode(message); data.append(10)
                try self.input.fileHandleForWriting.write(contentsOf: data)
            } catch { MainRunLoop.deliver { [weak self] in self?.received?(.error(reason: "停止请求未送达：\(error.localizedDescription)")) } }
        }
    }
    func closeLifetime() { try? input.fileHandleForWriting.close() }
    deinit {
        try? input.fileHandleForWriting.close()
    }
}

// AppKit terminateLater runs NSModalPanelRunLoopMode. DispatchQueue.main alone is
// not drained there; protocol completion must stay deliverable during termination.
enum MainRunLoop {
    static let modal = RunLoop.Mode("NSModalPanelRunLoopMode")
    static func deliver(_ body: @escaping () -> Void) {
        RunLoop.main.perform(inModes: [.default, .common, modal, RunLoop.Mode("NSEventTrackingRunLoopMode")], block: body)
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }
}
