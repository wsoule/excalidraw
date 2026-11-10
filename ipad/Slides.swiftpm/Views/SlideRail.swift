import SwiftUI

/// The Keynote-style list of slides: tap to go to a slide, drag (or Edit) to
/// reorder, long-press to delete.
struct SlideRail: View {
    @ObservedObject var store: DeckStore
    @State private var slidePendingDeletion: Slide.ID?

    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(Array(store.slides.enumerated()), id: \.element.id) { index, slide in
                    SlideThumbnail(
                        number: index + 1,
                        image: store.thumbnails[slide.id],
                        isCurrent: slide.id == store.currentSlideID
                    )
                    .id(slide.id)
                    .contentShape(Rectangle())
                    .onTapGesture { store.select(slide.id) }
                    .listRowBackground(Color.clear)
                    .contextMenu {
                        Button {
                            store.open(slide.id)
                        } label: {
                            Label("Edit Slide", systemImage: "pencil.tip")
                        }
                        Button(role: .destructive) {
                            slidePendingDeletion = slide.id
                        } label: {
                            Label("Delete Slide", systemImage: "trash")
                        }
                        .disabled(store.slides.count <= 1)
                    }
                }
                .onMove { store.moveSlides(fromOffsets: $0, toOffset: $1) }
                .onDelete { store.deleteSlides(atOffsets: $0) }
            }
            .listStyle(.sidebar)
            .onChange(of: store.currentSlideID) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id) }
            }
        }
        .toolbar {
            EditButton()
        }
        .confirmationDialog(
            "Delete this slide?",
            isPresented: Binding(
                get: { slidePendingDeletion != nil },
                set: { if !$0 { slidePendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Slide", role: .destructive) {
                if let id = slidePendingDeletion {
                    store.deleteSlide(id)
                }
                slidePendingDeletion = nil
            }
        } message: {
            Text("The drawing stays on the canvas. You can see it in Canvas view.")
        }
    }
}

struct SlideThumbnail: View {
    let number: Int
    let image: UIImage?
    let isCurrent: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(number)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(isCurrent ? Color.accentColor : .secondary)
                .frame(width: 22, alignment: .trailing)

            ZStack {
                Color.white
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                }
            }
            .aspectRatio(SlideLayout.aspectRatio, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(
                        isCurrent ? Color.accentColor : Color.secondary.opacity(0.3),
                        lineWidth: isCurrent ? 3 : 1
                    )
            )
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Slide \(number)")
        .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
    }
}
