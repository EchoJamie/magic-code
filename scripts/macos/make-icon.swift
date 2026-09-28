import AppKit
import Foundation

// Reproducible native vector artwork; no external brand assets or build dependencies.
let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let artwork = NSImage(size: NSSize(width: 1024, height: 1024))
artwork.lockFocus()
let background = NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 220, yRadius: 220)
NSGradient(starting: NSColor(calibratedRed: 0.28, green: 0.30, blue: 0.79, alpha: 1), ending: NSColor(calibratedRed: 0.12, green: 0.15, blue: 0.36, alpha: 1))!.draw(in: background, angle: -70)
func sparkle(x: CGFloat, y: CGFloat, radius: CGFloat) {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: x, y: y + radius))
    path.curve(to: NSPoint(x: x + radius, y: y), controlPoint1: NSPoint(x: x + radius * 0.22, y: y + radius * 0.22), controlPoint2: NSPoint(x: x + radius * 0.22, y: y + radius * 0.22))
    path.curve(to: NSPoint(x: x, y: y - radius), controlPoint1: NSPoint(x: x + radius * 0.22, y: y - radius * 0.22), controlPoint2: NSPoint(x: x + radius * 0.22, y: y - radius * 0.22))
    path.curve(to: NSPoint(x: x - radius, y: y), controlPoint1: NSPoint(x: x - radius * 0.22, y: y - radius * 0.22), controlPoint2: NSPoint(x: x - radius * 0.22, y: y - radius * 0.22))
    path.curve(to: NSPoint(x: x, y: y + radius), controlPoint1: NSPoint(x: x - radius * 0.22, y: y + radius * 0.22), controlPoint2: NSPoint(x: x - radius * 0.22, y: y + radius * 0.22))
    NSColor.white.setFill(); path.fill()
}
sparkle(x: 470, y: 460, radius: 255)
sparkle(x: 755, y: 752, radius: 102)
sparkle(x: 255, y: 770, radius: 60)
artwork.unlockFocus()
var images: [[String: String]] = []
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = points * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        artwork.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
        NSGraphicsContext.restoreGraphicsState()
        let name = "icon-\(points)-\(scale)x.png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
        images.append(["idiom": "mac", "size": "\(points)x\(points)", "scale": "\(scale)x", "filename": name])
    }
}
try JSONSerialization.data(withJSONObject: ["images": images, "info": ["author": "xcode", "version": 1]], options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("Contents.json"))
