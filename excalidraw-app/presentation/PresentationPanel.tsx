import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { getFrameLikeTitle } from "@excalidraw/element";
import { useEffect, useState } from "react";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { useStartPresentation } from "./PresentationMode";
import { exportPresentationToPdf, getSlides, moveSlide } from "./slides";

type SlideListItem = { id: string; title: string };

const toListItems = (elements: readonly ExcalidrawElement[]) =>
  getSlides(elements).map((slide) => ({
    id: slide.id,
    title: getFrameLikeTitle(slide),
  }));

const isSameList = (a: SlideListItem[], b: SlideListItem[]) =>
  a.length === b.length &&
  a.every((item, i) => item.id === b[i].id && item.title === b[i].title);

export const PresentationPanel = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const startPresentation = useStartPresentation();
  const [slides, setSlides] = useState<SlideListItem[]>([]);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const update = (elements: readonly ExcalidrawElement[]) => {
      const next = toListItems(elements);
      setSlides((prev) => (isSameList(prev, next) ? prev : next));
    };
    update(excalidrawAPI.getSceneElements());
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

      {!!slides.length && (
        <p className="presentation-panel__hint">
          While presenting: → / Space / tap right for next, ← / tap left for
          previous, Esc to exit. Slide order is saved inside the drawing, so it
          travels with the .excalidraw file.
        </p>
      )}
    </div>
  );
};
