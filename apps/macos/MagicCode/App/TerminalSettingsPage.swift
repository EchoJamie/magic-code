import SwiftUI

struct TerminalSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    var body: some View {
        TerminalPreferencesEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("terminal-fields", snapshot.configuration["statusLine"]["cells"], stamp: snapshot.stamp))
    }
}
struct TerminalPreferencesEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    @State private var columns = 80
    private let labels = ["session": "会话名", "model": "模型", "reasoning": "思考", "context": "上下文", "workspace": "工作区"]
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "状态行字段") {
                Text("运行状态与全放行提示始终保留。无值的字段整格省略；窄时从右侧让位。").font(.callout).foregroundStyle(.secondary)
                ForEach(draft.value.array.indices, id: \.self) { index in
                    HStack {
                        Text(labels[draft.value.array[index].text] ?? "").frame(maxWidth: .infinity, alignment: .leading)
                        Button { swap(index, index - 1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).accessibilityLabel("上移字段")
                        Button { swap(index, index + 1) } label: { Image(systemName: "arrow.down") }.disabled(index + 1 == draft.value.array.count).accessibilityLabel("下移字段")
                        Button { var cells = draft.value.array; cells.remove(at: index); draft.value = .array(cells) } label: { Image(systemName: "minus.circle") }.accessibilityLabel("隐藏字段")
                    }
                }
                ForEach(["session", "model", "reasoning", "context", "workspace"].filter { !draft.value.array.contains(.string($0)) }, id: \.self) { key in
                    Button("添加\(labels[key] ?? key)", systemImage: "plus") { draft.value = .array(draft.value.array + [.string(key)]) }
                }
                DraftFooter(model: model, draft: draft, key: "terminal-fields", boundary: "保存后向当前终端受理呈现偏好；计时继续。", cancel: { drafts.discard("terminal-fields") }, action: {
                    .object(["type": .string("prefs.set"), "statusLine": .object(["cells": draft.value, "color": .bool(colorEnabled)])])
                })
            }.id("status")
            SettingsCard(title: "颜色与动效") {
                Toggle("状态行上色", isOn: Binding(get: { colorEnabled }, set: { value in
                    model.applySettings(.object(["type": .string("prefs.set"), "statusLine": .object(["cells": snapshot.configuration["statusLine"]["cells"], "color": .bool(value)])]), stamp: snapshot.stamp, key: "terminal-color")
                })).disabled(model.settingsBusy || !model.isCurrent)
                Toggle("减少动效", isOn: Binding(get: { reduced }, set: { value in
                    model.applySettings(.object(["type": .string("prefs.set"), "reducedMotion": .bool(value)]), stamp: snapshot.stamp, key: "terminal-motion")
                })).disabled(model.settingsBusy || !model.isCurrent)
                Text("开关保存成功后回显。减少动效停止亮度变化，耗时读数仍然更新。").font(.caption).foregroundStyle(.secondary)
            }
            SettingsCard(title: "示例预览") {
                HStack { Text("终端列数"); Stepper("\(columns)", value: $columns, in: 20...160, step: 10) }
                ScrollView(.horizontal) {
                    TimelineView(.periodic(from: .now, by: 0.2)) { timeline in
                        let colors = snapshot.preview["colors"].array
                        let index = colors.isEmpty ? 0 : Int(timeline.date.timeIntervalSince1970 * 5) % colors.count
                        let color = colors.isEmpty ? Color.primary : previewColor(colors[index].text)
                        snapshot.preview["segments"].array.reduce(Text("")) { text, segment in
                            text + Text(segment["text"].text).foregroundColor(segment["dynamic"].flag ? color : previewColor(segment["color"].text))
                        }.font(.system(.callout, design: .monospaced)).padding(14).fixedSize()
                    }
                }.background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                Text("数据为示例，来自与实际 TUI 相同的字段顺序、列宽省略和动效规则。不会操作真实会话。").font(.caption).foregroundStyle(.secondary)
            }
        }.onChange(of: draft.value) { _, _ in preview() }.onChange(of: columns) { _, _ in preview() }
        .onChange(of: colorEnabled) { _, _ in preview() }.onChange(of: reduced) { _, _ in preview() }
        .onAppear { preview() }
    }
    private var colorEnabled: Bool { snapshot.configuration["statusLine"]["color"] == .null || snapshot.configuration["statusLine"]["color"].flag }
    private var reduced: Bool { snapshot.configuration["motion"]["reduced"].flag }
    private func swap(_ from: Int, _ to: Int) { var values = draft.value.array; values.swapAt(from, to); draft.value = .array(values) }
    private func preview() { model.readSettings(preview: .object(["statusLine": .object(["cells": draft.value, "color": .bool(colorEnabled)]), "columns": .number(Double(columns)), "reducedMotion": .bool(reduced)])) }
    private func previewColor(_ value: String) -> Color {
        guard value.hasPrefix("#"), let hex = UInt64(value.dropFirst(), radix: 16) else { return .primary }
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}
