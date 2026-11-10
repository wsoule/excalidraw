import PencilKit
import SwiftUI

enum EditorMode: String, CaseIterable, Identifiable {
    /// One slide at a time, viewport locked to it (Keynote-like).
    case slides
    /// The whole infinite canvas, every slide visible as a frame.
    case canvas

    var id: Self { self }
}

/// The deck: slide order, which slide is current, which view is showing.
///
/// The live drawing (and its undo history) belongs to the single
/// `PKCanvasView` that stays mounted in both views. The store keeps the latest
/// copy the canvas reported, for thumbnails and saving, and never pushes a
/// drawing back into the canvas, so undo keeps working across view switches.
@MainActor
final class DeckStore: ObservableObject {
    @Published private(set) var slides: [Slide]
    @Published private(set) var currentSlideID: Slide.ID? = nil
    @Published var mode: EditorMode = .slides
    @Published private(set) var thumbnails: [Slide.ID: UIImage] = [:]

    private(set) var drawing: PKDrawing

    private let fileURL: URL
    private var saveTask: Task<Void, Never>?
    private var thumbnailTask: Task<Void, Never>?

    /// Thumbnails are rendered at this fraction of the slide's point size:
    /// a 1600-point slide becomes a 400-pixel-wide image.
    private let thumbnailScale: CGFloat = 0.25

    init(fileURL: URL = DeckStorage.defaultURL) {
        self.fileURL = fileURL

        if let file = DeckStore.load(from: fileURL) {
            slides = file.slides
            drawing = file.drawing
        } else {
            slides = [Slide(rect: SlideLayout.rect(column: 0, row: 0))]
            drawing = PKDrawing()
        }
        currentSlideID = slides.first?.id
        renderThumbnails()
    }

    var currentSlide: Slide? {
        slides.first { $0.id == currentSlideID }
    }

    var currentIndex: Int? {
        slides.firstIndex { $0.id == currentSlideID }
    }

    // MARK: Slides

    /// Adds a slide after the current one (in presentation order), placed in
    /// the first free spot on the canvas, and makes it current.
    func addSlide() {
        let slide = Slide(rect: SlideLayout.nextFreeRect(avoiding: slides.map(\.rect)))
        let insertAt = currentIndex.map { $0 + 1 } ?? slides.endIndex
        slides.insert(slide, at: insertAt)
        currentSlideID = slide.id
        renderThumbnails(only: [slide.id])
        scheduleSave()
    }

    /// Removes the slide. Its ink stays on the canvas (visible in Canvas view);
    /// adding a slide afterwards reuses the freed spot and brings it back.
    /// The last remaining slide can't be deleted.
    func deleteSlide(_ id: Slide.ID) {
        guard slides.count > 1, let index = slides.firstIndex(where: { $0.id == id }) else {
            return
        }
        slides.remove(at: index)
        if currentSlideID == id {
            currentSlideID = slides[min(index, slides.count - 1)].id
        }
        thumbnails[id] = nil
        scheduleSave()
    }

    func deleteSlides(atOffsets offsets: IndexSet) {
        for id in offsets.map({ slides[$0].id }) {
            deleteSlide(id)
        }
    }

    /// Changes presentation order only; slides keep their place on the canvas.
    func moveSlides(fromOffsets source: IndexSet, toOffset destination: Int) {
        slides.move(fromOffsets: source, toOffset: destination)
        scheduleSave()
    }

    /// Makes a slide current without changing the view. In Canvas view the
    /// canvas zooms to it.
    func select(_ id: Slide.ID) {
        currentSlideID = id
    }

    /// Makes a slide current and switches to Slide view.
    func open(_ id: Slide.ID) {
        currentSlideID = id
        mode = .slides
    }

    func selectPrevious() {
        guard let index = currentIndex, index > 0 else { return }
        currentSlideID = slides[index - 1].id
    }

    func selectNext() {
        guard let index = currentIndex, index < slides.count - 1 else { return }
        currentSlideID = slides[index + 1].id
    }

    // MARK: Drawing

    /// Called by the canvas after every change to the ink.
    func drawingDidChange(_ drawing: PKDrawing) {
        self.drawing = drawing
        scheduleThumbnails()
        scheduleSave()
    }

    private func scheduleThumbnails() {
        thumbnailTask?.cancel()
        thumbnailTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            self?.renderThumbnails()
        }
    }

    private func renderThumbnails(only ids: Set<Slide.ID>? = nil) {
        var updated = thumbnails
        // Slides are always light (white paper), whatever the system
        // appearance, so render the ink's dynamic colors in light mode.
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            for slide in self.slides where ids?.contains(slide.id) ?? true {
                updated[slide.id] = self.drawing.image(from: slide.rect, scale: self.thumbnailScale)
            }
        }
        let liveIDs = Set(slides.map(\.id))
        thumbnails = updated.filter { liveIDs.contains($0.key) }
    }

    // MARK: Saving

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    func save() {
        saveTask?.cancel()
        let file = DeckFile(
            version: DeckFile.currentVersion,
            slides: slides,
            drawing: drawing.dataRepresentation()
        )
        do {
            let data = try JSONEncoder().encode(file)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            print("Saving the deck failed: \(error)")
        }
    }

    private static func load(from url: URL) -> (slides: [Slide], drawing: PKDrawing)? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let data = try Data(contentsOf: url)
            let file = try JSONDecoder().decode(DeckFile.self, from: data)
            let drawing = try PKDrawing(data: file.drawing)
            guard !file.slides.isEmpty else { return nil }
            return (file.slides, drawing)
        } catch {
            // Never overwrite a file we couldn't read: move it aside so the
            // user's work can still be recovered, then start a fresh deck.
            let stamp = Int(Date().timeIntervalSince1970)
            let backup = url.deletingLastPathComponent()
                .appendingPathComponent("Deck-unreadable-\(stamp).json")
            try? FileManager.default.moveItem(at: url, to: backup)
            print("Couldn't read the deck (\(error)); moved it to \(backup.lastPathComponent)")
            return nil
        }
    }
}
