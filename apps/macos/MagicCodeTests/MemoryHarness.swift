import Foundation

/// 独立测试入口：使用正式连接与 Codable，分页游标取自 Swift 解码结果。
@main struct MemoryHarness {
    struct Input: Decodable {
        let socket: String
        let identity: ServiceIdentity
        let session: String
        let item: String
    }
    struct Output: Encodable { let responses: [NativeResponse] }

    static func main() {
        do { try run() }
        catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }

    static func run() throws {
        let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let connection = ObserverConnection()
        defer { connection.close() }
        var responses: [NativeResponse] = []
        var failure: String?
        var finished = false
        var disconnected = false
        var pending = "memory"
        connection.disconnected = { reason in
            disconnected = true
            if !finished { failure = reason }
        }
        connection.receive = { response in
            switch response {
            case let .welcome(identity, _):
                guard identity == input.identity else { failure = "Engine 身份不符"; return }
                connection.send(.memory(request: pending, session: input.session, offset: nil))
            case let .memoryResult(request, instance, session, memory, _, _, material, error):
                guard request == pending, instance == input.identity.serviceInstance, session == input.session else {
                    failure = "记忆响应关联不符"; return
                }
                if let error { failure = error; return }
                responses.append(response)
                if request == "memory" {
                    guard let source = memory?.items.first(where: { $0.id == input.item })?.sources.first else {
                        failure = "记忆条目缺少来源"; return
                    }
                    pending = "source-0"
                    connection.send(.memorySource(request: pending, session: input.session, source: source, item: input.item, knowledge: nil))
                } else if let material {
                    if let next = material.next {
                        guard next > (material.source.offset ?? 0), !material.complete else {
                            failure = "来源分页未前进"; return
                        }
                        var source = material.source
                        source.offset = next
                        pending = "source-\(next)"
                        connection.send(.memorySource(request: pending, session: input.session, source: source, item: input.item, knowledge: nil))
                    } else {
                        guard material.complete else { failure = "来源未完成且缺少下一页"; return }
                        finished = true
                    }
                } else { failure = "缺少来源材料" }
            case let .error(reason): failure = reason
            default: break
            }
        }
        connection.connect(path: input.socket, identity: input.identity)
        let deadline = Date().addingTimeInterval(10)
        while !finished && failure == nil && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        if let failure { throw WireError.invalid(failure) }
        guard finished else { throw WireError.invalid("记忆桥读取超时") }
        var data = try JSONEncoder().encode(Output(responses: responses))
        data.append(10)
        FileHandle.standardOutput.write(data)

        // TS 收到结果后关闭隔离 Engine；真实连接必须收到断开通知才能通过。
        let closeDeadline = Date().addingTimeInterval(10)
        while !disconnected && Date() < closeDeadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        guard disconnected else { throw WireError.invalid("Engine 关闭后原生 socket 未断开") }
    }
}
