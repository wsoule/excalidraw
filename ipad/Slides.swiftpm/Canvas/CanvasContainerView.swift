import PencilKit
import UIKit

/// Hosts the one `PKCanvasView` used by both views.
///
/// Layers, back to front:
/// 1. `SlideBackgroundView`: gray desk + white slides
/// 2. `PKCanvasView`: the ink (transparent background)
/// 3. `SlideOverlayView`: fade outside the slide / slide borders and numbers
///
/// Slide view and Canvas view are the same canvas with a different viewport:
/// - Slide view fits the current slide to the screen and keeps the viewport
///   on it (you can zoom in to draw details, but not wander off the slide).
/// - Canvas view pans and zooms freely over every slide.
final class CanvasContainerView: UIView, PKCanvasViewDelegate {
    let canvasView = PKCanvasView()

    var onDrawingChange: (@MainActor (PKDrawing) -> Void)?
    var onOpenSlide: (@MainActor (Slide.ID) -> Void)? {
        didSet { overlayView.onOpenSlide = onOpenSlide }
    }

    private let backgroundView = SlideBackgroundView()
    private let overlayView = SlideOverlayView()
    private let toolPicker = PKToolPicker()
    private var isToolPickerSetUp = false

    private var mode: EditorMode = .slides
    private var slides: [Slide] = []
    private var currentSlideID: Slide.ID?

    private var lastLayoutSize: CGSize = .zero
    /// True while we move the viewport ourselves, so the Slide view clamp
    /// doesn't fight the animation.
    private var isApplyingViewport = false
    private var isClamping = false

    init(drawing: PKDrawing) {
        super.init(frame: .zero)
        backgroundColor = SlideStyle.canvasColor

        canvasView.drawing = drawing
        canvasView.delegate = self
        canvasView.backgroundColor = .clear
        canvasView.isOpaque = false
        // Follows the system "Only Draw with Apple Pencil" setting: with it on,
        // fingers scroll and zoom; with it off, one finger draws too.
        canvasView.drawingPolicy = .default
        // Slides are white paper: keep ink colors as picked, never inverted
        // for dark mode.
        canvasView.overrideUserInterfaceStyle = .light
        canvasView.contentInsetAdjustmentBehavior = .never
        canvasView.showsHorizontalScrollIndicator = false
        canvasView.showsVerticalScrollIndicator = false
        canvasView.bouncesZoom = true

        toolPicker.colorUserInterfaceStyle = .light

        addSubview(backgroundView)
        addSubview(canvasView)
        addSubview(overlayView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: Updates from SwiftUI

    func update(mode: EditorMode, slides: [Slide], currentSlideID: Slide.ID?) {
        let viewportChanged = mode != self.mode || currentSlideID != self.currentSlideID
        self.mode = mode
        self.slides = slides
        self.currentSlideID = currentSlideID

        updateContentSize()
        if viewportChanged {
            applyViewport(animated: window != nil)
        }
        updateDecorations()

        // The tool picker only shows while the canvas is first responder;
        // get it back if something else (e.g. a menu) took it.
        if window != nil, isToolPickerSetUp, !canvasView.isFirstResponder {
            canvasView.becomeFirstResponder()
        }
    }

    private var currentSlide: Slide? {
        slides.first { $0.id == currentSlideID }
    }

    private var worldSize: CGSize {
        SlideLayout.worldSize(slides: slides.map(\.rect), drawingBounds: canvasView.drawing.bounds)
    }

    // MARK: Layout

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, !isToolPickerSetUp else { return }
        isToolPickerSetUp = true
        toolPicker.addObserver(canvasView)
        toolPicker.setVisible(true, forFirstResponder: canvasView)
        canvasView.becomeFirstResponder()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        backgroundView.frame = bounds
        canvasView.frame = bounds
        overlayView.frame = bounds

        // Rotation, Split View, showing/hiding the slide list: re-fit.
        if bounds.size != lastLayoutSize {
            lastLayoutSize = bounds.size
            applyViewport(animated: false)
        }
        updateDecorations()
    }

    // MARK: Viewport

    private func applyViewport(animated: Bool) {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let size = bounds.size

        let target: Viewport
        switch mode {
        case .slides:
            guard let slide = currentSlide else { return }
            target = ViewportMath.fit(slide.rect, in: size, padding: SlideStyle.slidePadding)
            canvasView.minimumZoomScale = target.zoom
            canvasView.maximumZoomScale = target.zoom * 4

        case .canvas:
            let world = CGRect(origin: .zero, size: worldSize)
            // Zoom out around the current slide so you keep your bearings.
            let focus = currentSlide.map {
                $0.rect.insetBy(dx: -$0.rect.width * 0.6, dy: -$0.rect.height * 0.6)
            } ?? world
            target = ViewportMath.fit(focus, in: size, padding: SlideStyle.slidePadding)
            let wholeWorld = ViewportMath.fit(world, in: size, padding: 0)
            canvasView.minimumZoomScale = min(wholeWorld.zoom, target.zoom)
            canvasView.maximumZoomScale = 4
        }

        let apply = {
            self.isApplyingViewport = true
            self.canvasView.zoomScale = target.zoom
            self.updateContentSize()
            self.canvasView.contentOffset = self.validOffset(target.offset)
            self.isApplyingViewport = false
            self.updateDecorations()
        }
        if animated {
            // The background and overlay redraw instantly rather than
            // animating, so cross-fade the whole container instead of
            // animating the scroll view (which would let the ink drift
            // away from the slide paper mid-animation).
            UIView.transition(
                with: self,
                duration: 0.25,
                options: [.transitionCrossDissolve, .allowUserInteraction],
                animations: apply
            )
        } else {
            apply()
        }
    }

    /// Clamps an offset into the range the scroll view itself allows, so it
    /// doesn't jump on the first touch.
    private func validOffset(_ offset: CGPoint) -> CGPoint {
        let insets = canvasView.contentInset
        let size = canvasView.contentSize
        let maxX = max(-insets.left, size.width - bounds.width + insets.right)
        let maxY = max(-insets.top, size.height - bounds.height + insets.bottom)
        return CGPoint(
            x: min(max(offset.x, -insets.left), maxX),
            y: min(max(offset.y, -insets.top), maxY)
        )
    }

    /// `PKCanvasView` content size is in zoomed points.
    private func updateContentSize() {
        let world = worldSize
        let zoom = canvasView.zoomScale
        let contentSize = CGSize(width: world.width * zoom, height: world.height * zoom)
        if canvasView.contentSize != contentSize {
            canvasView.contentSize = contentSize
        }
        updateInsets()
    }

    private func updateInsets() {
        let insets: UIEdgeInsets
        switch mode {
        case .slides:
            // Generous, so the centered slide position is always a valid
            // offset (in narrow Split View the slide sits near the content
            // origin). The clamp below keeps the viewport on the slide.
            insets = UIEdgeInsets(
                top: bounds.height,
                left: bounds.width,
                bottom: bounds.height,
                right: bounds.width
            )
        case .canvas:
            // Center the canvas when it's smaller than the screen.
            let horizontal = max(0, (bounds.width - canvasView.contentSize.width) / 2)
            let vertical = max(0, (bounds.height - canvasView.contentSize.height) / 2)
            insets = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
        }
        if canvasView.contentInset != insets {
            canvasView.contentInset = insets
        }
    }

    /// Slide view: keep the visible area on the current slide plus the same
    /// screen padding used to fit it. At the fit zoom that is exactly the
    /// visible area, so the slide stays centered; zoomed in, you can pan up to
    /// the padding past each edge.
    private func clampToCurrentSlide() {
        guard mode == .slides, !isApplyingViewport, !isClamping, let slide = currentSlide else {
            return
        }
        let padding = SlideStyle.slidePadding / canvasView.zoomScale
        let allowed = slide.rect.insetBy(dx: -padding, dy: -padding)
        let current = canvasView.contentOffset
        let clamped = ViewportMath.clamp(
            offset: current,
            zoom: canvasView.zoomScale,
            viewSize: canvasView.bounds.size,
            within: allowed
        )
        if abs(clamped.x - current.x) > 0.5 || abs(clamped.y - current.y) > 0.5 {
            isClamping = true
            canvasView.contentOffset = clamped
            isClamping = false
        }
    }

    private func updateDecorations() {
        let state = SlideDecorationState(
            slides: slides,
            currentSlideID: currentSlideID,
            mode: mode,
            zoom: canvasView.zoomScale,
            offset: canvasView.contentOffset
        )
        backgroundView.state = state
        overlayView.state = state
    }

    // MARK: PKCanvasViewDelegate / UIScrollViewDelegate

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        // Ink near the edge grows the canvas so there's always room to draw.
        updateContentSize()
        onDrawingChange?(canvasView.drawing)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        clampToCurrentSlide()
        updateDecorations()
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        updateContentSize()
        clampToCurrentSlide()
        updateDecorations()
    }
}
