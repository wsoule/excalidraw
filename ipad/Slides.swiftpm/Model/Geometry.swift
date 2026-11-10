import CoreGraphics

/// Where slides live on the shared canvas.
///
/// The canvas is one big drawing in "content" coordinates (points at zoom 1,
/// origin top-left). Slides are rectangles on it, laid out on a grid. A slide's
/// position on the canvas never changes when the slide is reordered: the order
/// in the deck is the presentation order, the grid position is just where its
/// ink lives.
enum SlideLayout {
    /// 16:9, large enough that a fit-to-screen slide is drawn at roughly 1:1.
    static let slideSize = CGSize(width: 1600, height: 900)
    static let gap: CGFloat = 240
    /// Empty canvas kept around the slides (also keeps every slide reachable
    /// without negative scroll offsets).
    static let margin: CGFloat = 800
    static let columns = 4

    static var aspectRatio: CGFloat { slideSize.width / slideSize.height }

    static func rect(column: Int, row: Int) -> CGRect {
        CGRect(
            x: margin + CGFloat(column) * (slideSize.width + gap),
            y: margin + CGFloat(row) * (slideSize.height + gap),
            width: slideSize.width,
            height: slideSize.height
        )
    }

    /// The first grid cell (row by row) that no existing slide overlaps.
    /// Deleting a slide frees its cell, so the next new slide reuses it.
    static func nextFreeRect(avoiding existing: [CGRect]) -> CGRect {
        var index = 0
        while true {
            let candidate = rect(column: index % columns, row: index / columns)
            if !existing.contains(where: { $0.intersects(candidate) }) {
                return candidate
            }
            index += 1
        }
    }

    /// Size of the scrollable canvas: everything that holds a slide or ink,
    /// plus the margin, and never smaller than two full rows of slides.
    static func worldSize(slides: [CGRect], drawingBounds: CGRect) -> CGSize {
        var maxX = rect(column: columns - 1, row: 0).maxX
        var maxY = rect(column: 0, row: 1).maxY
        for slide in slides {
            maxX = max(maxX, slide.maxX)
            maxY = max(maxY, slide.maxY)
        }
        if !drawingBounds.isNull, !drawingBounds.isEmpty {
            maxX = max(maxX, drawingBounds.maxX)
            maxY = max(maxY, drawingBounds.maxY)
        }
        return CGSize(width: maxX + margin, height: maxY + margin)
    }
}

/// A scroll view position: zoom scale plus content offset (in zoomed points).
struct Viewport: Equatable {
    var zoom: CGFloat
    var offset: CGPoint
}

enum ViewportMath {
    /// The viewport that shows `rect` (content coordinates) as large as
    /// possible, centered, with `padding` points of space around it.
    static func fit(_ rect: CGRect, in viewSize: CGSize, padding: CGFloat) -> Viewport {
        let availableWidth = max(viewSize.width - 2 * padding, 1)
        let availableHeight = max(viewSize.height - 2 * padding, 1)
        let zoom = min(availableWidth / rect.width, availableHeight / rect.height)
        return Viewport(
            zoom: zoom,
            offset: CGPoint(
                x: rect.midX * zoom - viewSize.width / 2,
                y: rect.midY * zoom - viewSize.height / 2
            )
        )
    }

    /// Clamps a content offset so the visible area stays inside `bounds`
    /// (content coordinates). Along an axis where the visible area is larger
    /// than `bounds`, `bounds` is centered instead.
    static func clamp(
        offset: CGPoint,
        zoom: CGFloat,
        viewSize: CGSize,
        within bounds: CGRect
    ) -> CGPoint {
        func axis(_ offset: CGFloat, view: CGFloat, low: CGFloat, high: CGFloat) -> CGFloat {
            let visible = view / zoom
            if visible >= high - low {
                return (low + high) / 2 * zoom - view / 2
            }
            let start = min(max(offset / zoom, low), high - visible)
            return start * zoom
        }
        return CGPoint(
            x: axis(offset.x, view: viewSize.width, low: bounds.minX, high: bounds.maxX),
            y: axis(offset.y, view: viewSize.height, low: bounds.minY, high: bounds.maxY)
        )
    }

    /// Converts a content-coordinate rect to on-screen (view) coordinates.
    static func toScreen(_ rect: CGRect, zoom: CGFloat, offset: CGPoint) -> CGRect {
        CGRect(
            x: rect.minX * zoom - offset.x,
            y: rect.minY * zoom - offset.y,
            width: rect.width * zoom,
            height: rect.height * zoom
        )
    }
}
