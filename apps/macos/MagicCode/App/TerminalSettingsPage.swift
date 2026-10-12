import SwiftUI

struct TerminalSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    var body: some View {
        TerminalPreferencesEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("terminal-fields", .object([
            "cells": snapshot.configuration["statusLine"]["cells"],
            "color": .bool(snapshot.configuration["statusLine"]["color"] == .null || snapshot.configuration["statusLine"]["color"].flag),
            "reducedMotion": .bool(snapshot.configuration["motion"]["reduced"].flag)
        ]), stamp: snapshot.stamp))
    }
}
struct TerminalPreferencesEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    @State private var columns = 80
    private let fields = ["session", "model", "reasoning", "context", "workspace"]
    private let labels = ["session": "会话名", "model": "模型", "reasoning": "思考", "context": "上下文", "workspace": "工作区"]
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "状态行预览") {
                HStack {
                    MagicIcon(name: "terminal")
                    VStack(alignment: .leading, spacing: 4) {
                        Text("先看到效果，再调整显示内容").font(.headline)
                        Text("示例内容 · 与真实终端使用相同呈现规则").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    MagicBadge(text: draft.dirty ? "未保存的预览" : "已保存的偏好")
                }
                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("› 帮我整理会话与通知").foregroundStyle(.secondary)
                        Text("等待你的下一条交代。").foregroundStyle(.secondary)
                        Divider()
                        TimelineView(.animation(minimumInterval: 0.2, paused: draft.value["reducedMotion"].flag || !draft.value["color"].flag)) { timeline in
                            let colors = snapshot.preview["colors"].array
                            let index = colors.isEmpty ? 0 : Int(timeline.date.timeIntervalSince1970 * 5) % colors.count
                            let color = colors.isEmpty ? Color.primary : previewColor(colors[index].text)
                            snapshot.preview["segments"].array.reduce(Text("")) { text, segment in
                                text + Text(segment["text"].text).foregroundColor(segment["dynamic"].flag ? color : previewColor(segment["color"].text))
                            }.fixedSize()
                        }
                    }.font(.system(.callout, design: .monospaced)).padding(18)
                }.background(MagicStyle.canvas, in: RoundedRectangle(cornerRadius: 12))
                HStack {
                    Text("模拟终端宽度").foregroundStyle(.secondary)
                    Spacer()
                    Stepper("\(columns) 列", value: $columns, in: 20...160, step: 10).fixedSize()
                }
                Text("运行状态与全放行提示始终保留；无值字段整格省略，窄窗口从右侧让位。预览不会操作真实会话。").font(.caption).foregroundStyle(.secondary)
            }
            SettingsCard(title: "显示的信息") {
                Text("从上到下对应终端从左到右。优先保留的信息放在前面。").font(.caption).foregroundStyle(.secondary)
                ForEach(draft.value["cells"].array.indices, id: \.self) { index in
                    let field = draft.value["cells"].array[index].text
                    HStack(spacing: 12) {
                        Text("\(index + 1)").monospacedDigit().foregroundStyle(.tertiary).frame(width: 20)
                        Text(labels[field] ?? field).frame(maxWidth: .infinity, alignment: .leading)
                        Button { swap(index, index - 1) } label: { Image(systemName: "arrow.up") }
                            .disabled(index == 0).accessibilityLabel("上移\(labels[field] ?? field)")
                        Button { swap(index, index + 1) } label: { Image(systemName: "arrow.down") }
                            .disabled(index + 1 == draft.value["cells"].array.count).accessibilityLabel("下移\(labels[field] ?? field)")
                        Button { var cells = draft.value["cells"].array; cells.remove(at: index); draft.put("cells", .array(cells)) } label: { Image(systemName: "minus.circle") }
                            .accessibilityLabel("隐藏\(labels[field] ?? field)")
                    }
                }
                if draft.value["cells"].array.isEmpty { Text("仅显示必须保留的运行状态与全放行提示。").foregroundStyle(.secondary) }
                let hidden = fields.filter { !draft.value["cells"].array.contains(.string($0)) }
                if !hidden.isEmpty {
                    Menu("添加显示字段", systemImage: "plus") {
                        ForEach(hidden, id: \.self) { key in
                            Button(labels[key] ?? key) { draft.put("cells", .array(draft.value["cells"].array + [.string(key)])) }
                        }
                    }.fixedSize()
                }
            }.id("status")
            SettingsCard(title: "颜色与动效") {
                Toggle("状态行上色", isOn: draft.flag("color", default: true))
                Toggle("减少动效", isOn: draft.flag("reducedMotion"))
                Text("减少动效停止亮度变化，耗时读数仍然更新。以上调整先显示在预览中，保存后应用。").font(.caption).foregroundStyle(.secondary)
            }.toggleStyle(.switch)
            DraftFooter(model: model, draft: draft, key: "terminal-fields", boundary: "一并保存字段顺序、颜色与动效；当前终端随后采用，计时继续。模拟宽度仅用于预览。", cancel: { drafts.discard("terminal-fields") }, action: {
                .object(["type": .string("prefs.set"), "statusLine": statusLine, "reducedMotion": draft.value["reducedMotion"]])
            })
        }
        .onChange(of: draft.value) { _, _ in preview() }
        .onChange(of: columns) { _, _ in preview() }
        .onAppear { preview() }
    }
    private var statusLine: SettingsValue { .object(["cells": draft.value["cells"], "color": draft.value["color"]]) }
    private func swap(_ from: Int, _ to: Int) {
        var values = draft.value["cells"].array; values.swapAt(from, to); draft.put("cells", .array(values))
    }
    private func preview() {
        model.readSettings(preview: .object(["statusLine": statusLine, "columns": .number(Double(columns)), "reducedMotion": draft.value["reducedMotion"]]))
    }
    private func previewColor(_ value: String) -> Color {
        guard value.hasPrefix("#"), let hex = UInt64(value.dropFirst(), radix: 16) else { return .primary }
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}
