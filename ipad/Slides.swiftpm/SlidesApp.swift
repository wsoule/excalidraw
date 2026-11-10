import SwiftUI

@main
struct SlidesApp: App {
    @StateObject private var store = DeckStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
        }
        .onChange(of: scenePhase) { _, phase in
            // Save right away when leaving the app instead of waiting for the
            // debounced autosave.
            if phase != .active {
                store.save()
            }
        }
    }
}
