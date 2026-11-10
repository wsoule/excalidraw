import SwiftUI

struct ContentView: View {
    @ObservedObject var store: DeckStore

    var body: some View {
        NavigationSplitView {
            SlideRail(store: store)
                .navigationTitle("Slides")
        } detail: {
            SlideCanvas(store: store)
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Picker("View", selection: $store.mode) {
                Text("Slide").tag(EditorMode.slides)
                Text("Canvas").tag(EditorMode.canvas)
            }
            .pickerStyle(.segmented)
            .frame(width: 220)
        }

        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                store.selectPrevious()
            } label: {
                Label("Previous Slide", systemImage: "chevron.up")
            }
            .disabled(store.currentIndex == 0)
            .keyboardShortcut(.upArrow, modifiers: [])

            Button {
                store.selectNext()
            } label: {
                Label("Next Slide", systemImage: "chevron.down")
            }
            .disabled(store.currentIndex == store.slides.count - 1)
            .keyboardShortcut(.downArrow, modifiers: [])

            Button {
                store.addSlide()
            } label: {
                Label("New Slide", systemImage: "plus.rectangle")
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
        }
    }
}
