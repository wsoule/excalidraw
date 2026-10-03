import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { getFrameLikeTitle, isFrameLikeElement } from "@excalidraw/element";
import { useEffect, useState } from "react";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { isReplayEnabled } from "./drawingTiming";

import { useStartPresentation } from "./PresentationMode";
import { RecordingsPanel } from "./RecordingsPanel";
import {
  exportPresentationToPdf,
  getSlides,
  isSlideReplayEnabled,
  moveSlide,
  setReplayEnabled,
  setSlideReplayEnabled,
} from "./slides";

type SlideListItem = { id: string; title: string; replay: boolean };

const toListItems = (elements: readonly ExcalidrawElement[]) =>
  getSlides(elements).map((slide) => ({
    id: slide.id,
    title: getFrameLikeTitle(slide),
    replay: isSlideReplayEnabled(slide),
  }));

const isSameList = (a: SlideListItem[], b: SlideListItem[]) =>
  a.length === b.length &&
  a.every(
    (item, i) =>
      item.id === b[i].id &&
      item.title === b[i].title &&
      item.replay === b[i].replay,
  );

type SelectionSummary = { ids: string[]; animated: number };

const EMPTY_SELECTION: SelectionSummary = { ids: [], animated: 0 };

/** selected elements (with their labels), frames excluded */
const getSelectionSummary = (
  elements: readonly ExcalidrawElement[],
  selectedElementIds: AppState["selectedElementIds"],
): SelectionSummary => {
  const selected = elements.filter(
    (element) =>
      !element.isDeleted &&
      !isFrameLikeElement(element) &&
      (selectedElementIds[element.id] ||
        ("containerId" in element &&
          element.containerId &&
          selectedElementIds[element.containerId])),
  );
  return selected.length
    ? {
        ids: selected.map((element) => element.id),
        animated: selected.filter(isReplayEnabled).length,
      }
    : EMPTY_SELECTION;
};

const isSameSelection = (a: SelectionSummary, b: SelectionSummary) =>
  a.animated === b.animated &&
  a.ids.length === b.ids.length &&
  a.ids.every((id, i) => id === b.ids[i]);

export const PresentationPanel = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const startPresentation = useStartPresentation();
  const [slides, setSlides] = useState<SlideListItem[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [selection, setSelection] = useState(EMPTY_SELECTION);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const update = (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
    ) => {
      const next = toListItems(elements);
      setSlides((prev) => (isSameList(prev, next) ? prev : next));
      const nextSelection = getSelectionSummary(
        elements,
        appState.selectedElementIds,
      );
      setSelection((prev) =>
        isSameSelection(prev, nextSelection) ? prev : nextSelection,
      );
    };
    update(excalidrawAPI.getSceneElements(), excalidrawAPI.getAppState());
    return excalidrawAPI.onChange(update);
  }, [excalidrawAPI]);

  const goToSlide = (id: string) => {
    excalidrawAPI?.setViewport({
      target: id,
      fit: "contain",
      animation: { duration: 300 },
      offsets: { ui: true },
    });
  };

  const exportPdf = async () => {
    if (!excalidrawAPI || isExporting) {
      return;
    }
    setIsExporting(true);
    try {
      await exportPresentationToPdf(excalidrawAPI);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="presentation-panel">
      <div className="presentation-panel__actions">
        <button
          type="button"
          className="presentation-panel__button presentation-panel__button--primary"
          disabled={!slides.length}
          onClick={() => startPresentation(0)}
        >
          ▶ Present
        </button>
        <button
          type="button"
          className="presentation-panel__button"
          disabled={!slides.length || isExporting}
          onClick={exportPdf}
        >
          {isExporting ? "Exporting…" : "Export PDF"}
        </button>
      </div>

      {slides.length ? (
        <ol className="presentation-panel__list">
          {slides.map((slide, index) => (
            <li key={slide.id} className="presentation-panel__item">
              <span className="presentation-panel__number">{index + 1}</span>
              <button
                type="button"
                className="presentation-panel__name"
                title="Show on canvas"
                onClick={() => goToSlide(slide.id)}
              >
                {slide.title}
              </button>
              <button
                type="button"
                className="presentation-panel__icon-button presentation-panel__replay-toggle"
                aria-label="Replay drawing when presenting"
                aria-pressed={slide.replay}
                title={
                  slide.replay
                    ? "Replays how it was drawn (click to show it finished)"
                    : "Shows it finished (click to replay how it was drawn)"
                }
                onClick={() =>
                  excalidrawAPI &&
                  setSlideReplayEnabled(excalidrawAPI, slide.id, !slide.replay)
                }
              >
                ✎
              </button>
              <button
                type="button"
                className="presentation-panel__icon-button"
                aria-label="Move slide up"
                title="Move up"
                disabled={index === 0}
                onClick={() =>
                  excalidrawAPI && moveSlide(excalidrawAPI, slide.id, index - 1)
                }
              >
                ↑
              </button>
              <button
                type="button"
                className="presentation-panel__icon-button"
                aria-label="Move slide down"
                title="Move down"
                disabled={index === slides.length - 1}
                onClick={() =>
                  excalidrawAPI && moveSlide(excalidrawAPI, slide.id, index + 1)
                }
              >
                ↓
              </button>
              <button
                type="button"
                className="presentation-panel__icon-button"
                aria-label="Present from this slide"
                title="Present from here"
                onClick={() => startPresentation(index)}
              >
                ▶
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="presentation-panel__hint">
          Each frame is a slide. Press <kbd>F</kbd> (or pick the frame tool) and
          draw a frame around each slide's content.
        </p>
      )}

      {!!slides.length && !!selection.ids.length && (
        <div className="presentation-panel__selection">
          <span className="presentation-panel__selection-label">
            {selection.ids.length} selected:{" "}
            {selection.animated === selection.ids.length
              ? "animated"
              : selection.animated === 0
              ? "shown at start"
              : `${selection.animated} animated`}
          </span>
          <div className="presentation-panel__actions">
            <button
              type="button"
              className="presentation-panel__button"
              disabled={selection.animated === selection.ids.length}
              title="Replay how they were drawn"
              onClick={() =>
                excalidrawAPI &&
                setReplayEnabled(excalidrawAPI, new Set(selection.ids), true)
              }
            >
              ✎ Animate
            </button>
            <button
              type="button"
              className="presentation-panel__button"
              disabled={selection.animated === 0}
              title="Already there when the slide appears"
              onClick={() =>
                excalidrawAPI &&
                setReplayEnabled(excalidrawAPI, new Set(selection.ids), false)
              }
            >
              Show at start
            </button>
          </div>
        </div>
      )}

      {!!slides.length && (
        <p className="presentation-panel__hint">
          While presenting: → / Space / tap right for next, ← / tap left for
          previous, Esc to exit. ✎ slides replay how they were drawn (R to
          replay, A to turn off for all); select elements to choose which ones
          animate. D pen, L laser, C clean mode (for screen recording), S sync
          chirp, Shift+R record. Slide order and these settings are saved inside
          the drawing, so they travel with the .excalidraw file.
        </p>
      )}

      <RecordingsPanel />
    </div>
  );
};
