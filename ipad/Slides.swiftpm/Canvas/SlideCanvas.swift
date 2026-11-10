import PencilKit
import SwiftUI

/// SwiftUI wrapper around `CanvasContainerView`.
///
/// The canvas is created once with the saved drawing. After that the canvas
/// owns the drawing: it reports changes to the store, and SwiftUI only tells
/// it which view (Slide/Canvas) and which slide to show.
struct SlideCanvas: UIViewRepresentable {
    @ObservedObject var store: DeckStore

    func makeUIView(context: Context) -> CanvasContainerView {
        let view = CanvasContainerView(drawing: store.drawing)
        view.onDrawingChange = { [weak store] drawing in
            store?.drawingDidChange(drawing)
        }
        view.onOpenSlide = { [weak store] id in
            store?.open(id)
        }
        return view
    }

    func updateUIView(_ view: CanvasContainerView, context: Context) {
        view.update(mode: store.mode, slides: store.slides, currentSlideID: store.currentSlideID)
    }
}
