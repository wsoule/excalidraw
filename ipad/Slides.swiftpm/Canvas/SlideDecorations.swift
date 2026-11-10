import UIKit

enum SlideStyle {
    /// The "desk" around the slides.
    static let canvasColor = UIColor(white: 0.88, alpha: 1)
    static let paperColor = UIColor.white
    /// Space around the slide in Slide view, in screen points.
    static let slidePadding: CGFloat = 32
}

/// What the background and overlay layers need in order to draw.
struct SlideDecorationState {
    var slides: [Slide] = []
    var currentSlideID: Slide.ID?
    var mode: EditorMode = .slides
    var zoom: CGFloat = 1
    var offset: CGPoint = .zero

    func screenRect(of slide: Slide) -> CGRect {
        ViewportMath.toScreen(slide.rect, zoom: zoom, offset: offset)
    }
}

/// Drawn *behind* the ink: the gray desk and the white slide paper.
final class SlideBackgroundView: UIView {
    var state = SlideDecorationState() {
        didSet { setNeedsDisplay() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        SlideStyle.canvasColor.setFill()
        context.fill(rect)

        for slide in state.slides {
            let paper = state.screenRect(of: slide)
            guard paper.intersects(rect) else { continue }
            context.saveGState()
            context.setShadow(
                offset: CGSize(width: 0, height: 2),
                blur: 8,
                color: UIColor.black.withAlphaComponent(0.18).cgColor
            )
            SlideStyle.paperColor.setFill()
            context.fill(paper)
            context.restoreGState()
        }
    }
}

/// Drawn *above* the ink.
/// - Slide view: fades everything outside the current slide, so ink that
///   spills past the slide edge is visibly "off the slide".
/// - Canvas view: slide borders and numbered buttons (tap to open the slide).
///
/// Only the number buttons take touches; everything else passes through to the
/// canvas so drawing works everywhere.
final class SlideOverlayView: UIView {
    var onOpenSlide: (@MainActor (Slide.ID) -> Void)?

    var state = SlideDecorationState() {
        didSet {
            setNeedsDisplay()
            layoutNumberButtons()
        }
    }

    private var numberButtons: [Slide.ID: UIButton] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }

        switch state.mode {
        case .slides:
            guard let slide = state.slides.first(where: { $0.id == state.currentSlideID }) else {
                return
            }
            let hole = UIBezierPath(rect: state.screenRect(of: slide))
            let outside = UIBezierPath(rect: bounds)
            outside.append(hole)
            outside.usesEvenOddFillRule = true
            SlideStyle.canvasColor.withAlphaComponent(0.75).setFill()
            outside.fill()

        case .canvas:
            for slide in state.slides {
                let frame = state.screenRect(of: slide)
                guard frame.insetBy(dx: -4, dy: -4).intersects(rect) else { continue }
                let isCurrent = slide.id == state.currentSlideID
                context.setStrokeColor(
                    isCurrent ? tintColor.cgColor : UIColor.black.withAlphaComponent(0.25).cgColor
                )
                context.setLineWidth(isCurrent ? 3 : 1)
                context.stroke(frame.insetBy(dx: -1.5, dy: -1.5))
            }
        }
    }

    private func layoutNumberButtons() {
        let visibleIDs = state.mode == .canvas ? Set(state.slides.map(\.id)) : []

        for (id, button) in numberButtons where !visibleIDs.contains(id) {
            button.removeFromSuperview()
            numberButtons[id] = nil
        }

        for (index, slide) in state.slides.enumerated() where visibleIDs.contains(slide.id) {
            let button = numberButtons[slide.id] ?? makeNumberButton(for: slide.id)
            let isCurrent = slide.id == state.currentSlideID
            var configuration = isCurrent
                ? UIButton.Configuration.filled()
                : UIButton.Configuration.gray()
            configuration.title = "\(index + 1)"
            configuration.buttonSize = .small
            configuration.cornerStyle = .capsule
            button.configuration = configuration
            button.sizeToFit()

            let frame = state.screenRect(of: slide)
            button.frame.origin = CGPoint(x: frame.minX, y: frame.minY - button.bounds.height - 6)
        }
    }

    private func makeNumberButton(for id: Slide.ID) -> UIButton {
        let button = UIButton(
            primaryAction: UIAction { [weak self] _ in self?.onOpenSlide?(id) }
        )
        button.accessibilityHint = "Opens this slide"
        addSubview(button)
        numberButtons[id] = button
        return button
    }
}
