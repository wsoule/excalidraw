import CoreGraphics
import Foundation

/// A slide is a rectangle on the shared canvas, like a frame in Excalidraw.
/// Its ink is whatever part of the canvas drawing falls inside `rect`.
struct Slide: Identifiable, Codable, Equatable {
    var id = UUID()
    var rect: CGRect
}

/// On-disk format. `drawing` is `PKDrawing.dataRepresentation()`.
struct DeckFile: Codable {
    static let currentVersion = 1

    var version: Int
    /// In presentation order.
    var slides: [Slide]
    var drawing: Data
}

enum DeckStorage {
    static var defaultURL: URL {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Deck.json")
    }
}
