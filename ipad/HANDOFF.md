# Handoff: native iPad slides app

## Status

- The code is in `ipad/Slides.swiftpm` on branch `claude/eager-ramanujan-ojtgfa`.
- **It has never been compiled or run.** It was written without a Swift compiler.
- The viewport math was checked separately with a Python port of the formulas.
- An independent read-through found no definite compile errors. Its runtime fixes are in commit 2.

## Get it running

```bash
git fetch origin claude/eager-ramanujan-ojtgfa
git checkout claude/eager-ramanujan-ojtgfa
open ipad/Slides.swiftpm   # Xcode 15+, or copy the folder to an iPad and open it in Swift Playgrounds
```

Choose an iPad simulator, or your iPad with your Apple ID as the signing team. Apple Pencil only works on a real device.

## Likely first-build issues

| Where | What | Fix |
| --- | --- | --- |
| `Package.swift` | `.placeholder(icon: .pencil)` might not be a valid name | Choose another icon in the Playgrounds/Xcode app settings |
| `ContentView.swift` | ↑/↓ shortcuts may be swallowed by canvas keyboard scrolling | Set `canvasView.allowsKeyboardScrolling = false` (iOS 17+) |
| `SlideRail.swift` | Drag-to-reorder without Edit mode is unconfirmed | The Edit button is the fallback |

## Smoke test

1. Draw on slide 1, tap **+** and draw on slide 2. The thumbnails should update.
2. Switch to **Canvas**. Both slides and their ink should show, and you should be able to draw across them.
3. Tap a slide's number to go back to **Slide** view. Undo should still work.
4. Pinch-zoom in Slide view. You shouldn't be able to pan off the slide.
5. Rotate, open Split View, and hide the slide list. The slide should re-fit.
6. Force-quit and reopen. Everything should still be there (`Documents/Deck.json`).

## Design (keep these unless there's a reason)

- **One `PKDrawing` in one `PKCanvasView`** that stays mounted. Slide and Canvas view only change zoom and offset, so ink and undo are shared. Never push a drawing back into the canvas from the store; doing so resets undo.
- **A slide is a rect on the canvas** (`Slide.rect`, a 4-column grid in `SlideLayout`). List order is presentation order, separate from canvas position.
- **Deleting a slide keeps its ink.** The next new slide reuses the freed spot.
- **Layers:** paper background → ink (transparent) → overlay. Only the overlay's number buttons take touches.
- **Saving:** JSON with the drawing as base64, versioned (`DeckFile.currentVersion`). An unreadable file is moved aside, never overwritten.

## Next up (rough priority)

1. Fix the first-build errors and run the smoke test.
2. Keep the docked tool picker from covering the slide (`PKToolPicker.frameObscured(in:)`, then re-fit).
3. Full-screen presenting: page through `drawing.image(from: slide.rect, …)`, with Pencil laser/ink on top.
4. PDF export and share sheet.
5. Multiple decks with `DocumentGroup` and a custom UTType (needs Info.plist, so probably move to an Xcode project).
6. Move or resize slides on the canvas.
7. Text, shapes and images. PencilKit is ink only, so these need their own layer.

The web app's presentation features (`excalidraw-app/presentation/`) are a good spec for 3 and 4. They cover replay, laser, PDF and video.
