import SwiftUI
import AppKit

/// 菜单栏那一枚。底永远是品牌单色符号，深浅自动反色；三种状态只在符号**右侧并排**一个标记，
/// 不换成系统符号。
///
/// 并排而不是叠在角上：品牌方案写着「核心识别依赖轮廓」，而那个 M 的右上角恰恰是个尖
/// （折跃的「提示符」负空间全靠这道轮廓）。叠上去无论怎么让位都要咬掉它一点，
/// 所以标记落在符号外，轮廓一个点都不动。
///
/// 整枚在代码里合成**一张** template 图再交给菜单栏，不直接把视图树交给 `MenuBarExtra`：
/// 菜单栏那一格只画标签的第一个元素，且资源目录里的图在这一格画不出来（两者都实拍验过，
/// 见 `交接/回报/U103.md`）。合成到一张图里，这两个坑都不踩。
enum MenuBarState {
    case idle      // 空闲静态：只有品牌符号
    case active    // 有执行：实心点
    case attention // 需要你或异常：!
}

extension AppModel {
    /// 判据与 `WorkList` 的分组同源；不新增任何表现层事实。
    var menuBarState: MenuBarState {
        if case .fault = phase { return .attention }
        if works.contains(where: { WorkGroup.of($0) == .needsYou || WorkGroup.of($0) == .uncertain }) { return .attention }
        return works.contains(where: { $0.affected }) ? .active : .idle
    }
}

struct MenuBarMark: View {
    let state: MenuBarState

    var body: some View {
        Image(nsImage: MenuBarMark.image(for: state)).renderingMode(.template)
    }

    private static let markSize = CGSize(width: 16, height: 14.6)
    private static let badge: CGFloat = 6
    private static let gap: CGFloat = 1.6
    private static let canvas: CGFloat = 18

    /// 取资源的 bundle：App 里就是 App 包；单元测试里这一支是编进测试 bundle 的，
    /// 用 `Bundle.main` 会取不到，离屏帧就会少掉符号——正是这个错配把
    /// 「菜单栏那一格画不出资源目录的图」藏了整整一轮。
    private final class ResourceBundle {}

    /// 合成菜单栏那一枚：品牌符号 ＋ 右侧状态标记，落成一张 template 图。
    static func image(for state: MenuBarState) -> NSImage {
        let brand = Bundle(for: ResourceBundle.self).image(forResource: NSImage.Name("BrandMark"))
        let width = state == .idle ? markSize.width : markSize.width + gap + badge
        let image = NSImage(size: NSSize(width: width, height: canvas), flipped: false) { _ in
            NSColor.black.setFill()
            brand?.draw(in: NSRect(x: 0, y: (canvas - markSize.height) / 2,
                                   width: markSize.width, height: markSize.height))
            guard state != .idle else { return true }
            // 标记与符号同高居中，落在符号右侧。
            let box = NSRect(x: markSize.width + gap, y: (canvas - badge) / 2, width: badge, height: badge)
            if state == .attention { attentionPath(in: box).fill() } else { NSBezierPath(ovalIn: box).fill() }
            return true
        }
        image.isTemplate = true
        return image
    }

    /// 一个立着的 !：小尺寸下实心圆挖洞会把 ! 挖没，直接画形状更清楚。
    /// 杆比外接方框窄得多，否则外接方框是方的，画出来就成了一坨。
    private static func attentionPath(in box: NSRect) -> NSBezierPath {
        let thickness = box.width * 0.34
        let barHeight = box.height * 0.56
        let path = NSBezierPath()
        path.appendRoundedRect(NSRect(x: box.midX - thickness / 2, y: box.maxY - barHeight,
                                      width: thickness, height: barHeight),
                               xRadius: thickness / 2, yRadius: thickness / 2)
        path.appendOval(in: NSRect(x: box.midX - thickness / 2, y: box.minY, width: thickness, height: thickness))
        return path
    }
}
