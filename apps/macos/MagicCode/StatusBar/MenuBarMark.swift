import SwiftUI

/// 菜单栏那一枚。底永远是品牌单色符号（`BrandMark`，template），深浅自动反色；
/// 三种状态只在符号上叠一个标记，不换成系统符号。
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

/// 注意标记是一个立着的 ! 。小尺寸下实心圆挖洞会把 ! 挖没，直接画形状更清楚；
/// 杆比外接方框窄得多，否则外接方框是方的，画出来就成了一坨。
private struct AttentionMark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let width = rect.width * 0.34
        path.addRoundedRect(in: CGRect(x: rect.midX - width / 2, y: rect.minY, width: width, height: rect.height * 0.56),
                            cornerSize: CGSize(width: width / 2, height: width / 2))
        path.addEllipse(in: CGRect(x: rect.midX - width / 2, y: rect.maxY - width, width: width, height: width))
        return path
    }
}

struct MenuBarMark: View {
    let state: MenuBarState
    /// 资源目录里的品牌单色符号。产品路径不传；离屏帧装置所在的测试 bundle 没有资源目录，
    /// 用同一支品牌文件注入，让帧拍到的仍是这一枚符号。
    var mark: Image = Image("BrandMark")

    /// 标记的外接方框与落点：贴住符号右上角。
    private static let box: CGFloat = 6.5
    private static let offset = CGSize(width: 0.7, height: 0.3)
    /// 挖孔比标记每边大 1pt。品牌讲「核心识别依赖轮廓」，重叠处让出一圈底色，
    /// 标记就不会咬掉那道折跃的斜臂。
    private static let halo: CGFloat = 1.0

    var body: some View {
        ZStack(alignment: .topTrailing) {
            mark
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 16, height: 14.6)
            if state != .idle {
                Circle().fill().frame(width: Self.box + Self.halo * 2, height: Self.box + Self.halo * 2)
                    .offset(x: Self.offset.width + Self.halo, y: Self.offset.height - Self.halo)
                    .blendMode(.destinationOut)
                badge.frame(width: Self.box, height: Self.box).offset(Self.offset)
            }
        }
        .compositingGroup()
        .frame(width: 21, height: 18)
    }

    @ViewBuilder private var badge: some View {
        if state == .attention { AttentionMark().fill() } else { Circle().fill() }
    }
}
