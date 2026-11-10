# Slides for iPad (native)

A native iPadOS app (SwiftUI + PencilKit) for making slide decks by drawing with Apple Pencil. It has two views of the same drawing:

- **Slide view**: one slide at a time, Keynote style, with a slide list on the left. The viewport is locked to the current slide. You can zoom in to draw details but can't wander off the slide.
- **Canvas view**: the whole infinite canvas with every slide visible as a frame. You can pan and zoom freely, draw across slides, and tap a slide's number to open it.

This is a separate native app. It doesn't use the Excalidraw web code in this repository, but it borrows its central idea: **slides are frames on one shared canvas**.

## Run it

**On the iPad, no Mac needed:** copy the `Slides.swiftpm` folder to the iPad (iCloud Drive or AirDrop). Open it in [Swift Playgrounds](https://apps.apple.com/app/swift-playgrounds/id908519492) and press ▶︎.

**On a Mac:** open `Slides.swiftpm` in Xcode 15 or later, pick an iPad simulator or your iPad, and run it. Running on a real device needs your Apple ID set as the signing team, and Apple Pencil only works on a real device.

> ⚠️ This code was written in a Linux environment with no Swift compiler, so it has **never been compiled or run**. Expect a few compile errors or rough edges on the first build. The viewport math (`Model/Geometry.swift`) was checked numerically with a port of the same formulas.

## How it works

```
┌─ CanvasContainerView ───────────────────────────────┐
│  3. SlideOverlayView    fade outside slide / borders │  ← only the number
│  2. PKCanvasView        the ink (one PKDrawing)      │    buttons take touches
│  1. SlideBackgroundView gray desk + white paper      │
└──────────────────────────────────────────────────────┘
```

- **One drawing, one canvas view.** The whole deck is one `PKDrawing` in one `PKCanvasView` that stays on screen. Switching views only changes the viewport (zoom and offset), so ink and undo history carry over between views.
- **A slide is a rectangle** (`Slide.rect`) on that canvas, placed on a 4-column grid (`SlideLayout`). Its content is whatever ink falls inside the rectangle.
- **Order ≠ position.** Reordering slides in the list changes presentation order only. A slide's spot on the canvas never moves.
- **Deleting a slide keeps its ink** on the canvas, so nothing is lost. The next new slide reuses the freed spot, which brings that ink back.
- **Saving:** autosaves to `Documents/Deck.json` one second after the last change, and immediately when the app goes to the background. If the file can't be read, it's moved aside to `Deck-unreadable-<time>.json` rather than overwritten.

| File | What it does |
| --- | --- |
| `SlidesApp.swift` | App entry, saves when backgrounded |
| `Model/Geometry.swift` | Slide grid layout, fit/clamp viewport math |
| `Model/Deck.swift` | `Slide`, file format |
| `Store/DeckStore.swift` | Slide list, current slide, view mode, thumbnails, autosave |
| `Canvas/CanvasContainerView.swift` | PencilKit canvas, Slide/Canvas viewport switching |
| `Canvas/SlideDecorations.swift` | Paper background and overlay layers |
| `Canvas/SlideCanvas.swift` | SwiftUI wrapper |
| `Views/ContentView.swift` | Split view, toolbar, Slide/Canvas toggle |
| `Views/SlideRail.swift` | Slide list with thumbnails, reorder and delete |

## Not done yet

- Presenting full screen, with Pencil laser/ink while presenting
- PDF and image export, and sharing
- Multiple decks (a document browser using `DocumentGroup`)
- Moving or resizing slides on the canvas
- Keeping the docked tool picker from covering the bottom of the slide (`PKToolPicker.frameObscured(in:)`)
- Shapes, text and images (PencilKit is ink only)
