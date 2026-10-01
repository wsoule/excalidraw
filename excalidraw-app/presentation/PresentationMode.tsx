import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { atom, useAtom, useSetAtom } from "../app-jotai";

import { getSlideRenderInput, getSlides, renderSlideToSvgUrl } from "./slides";

import "./Presentation.scss";

import type { Slide, SlideRenderInput } from "./slides";

/** non-null while presenting */
export const presentationAtom = atom<{ startIndex: number } | null>(null);

const CONTROLS_HIDE_DELAY = 2500;
const SWIPE_THRESHOLD = 50;

const getFullscreenElement = (): Element | null =>
  document.fullscreenElement || (document as any).webkitFullscreenElement;

/** must be called synchronously from a user gesture (click/tap/key) */
const enterFullscreen = () => {
  const root = document.documentElement as any;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  try {
    // returns a promise in modern browsers, undefined in older Safari
    Promise.resolve(request?.call(root)).catch(() => {});
  } catch {
    // not supported/allowed (e.g. iPhone): present in the browser window
  }
};

const exitFullscreen = () => {
  if (!getFullscreenElement()) {
    return;
  }
  const exit =
    document.exitFullscreen || (document as any).webkitExitFullscreen;
  try {
    Promise.resolve(exit?.call(document)).catch(() => {});
  } catch {}
};

export const useStartPresentation = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const setPresentation = useSetAtom(presentationAtom);

  return useCallback(
    (startIndex = 0) => {
      if (!excalidrawAPI) {
        return;
      }
      if (!getSlides(excalidrawAPI.getSceneElements()).length) {
        excalidrawAPI.setToast({
          message: "Add a frame (F) for each slide to start presenting.",
          closable: true,
        });
        return;
      }
      enterFullscreen();
      setPresentation({ startIndex });
    },
    [excalidrawAPI, setPresentation],
  );
};

const Presenter = ({
  slides,
  input,
  startIndex,
  onExit,
}: {
  slides: readonly Slide[];
  input: SlideRenderInput;
  startIndex: number;
  onExit: () => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(slides.length - 1, startIndex)),
  );
  const [urls, setUrls] = useState<(string | null)[]>(() =>
    slides.map(() => null),
  );
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<number>(0);

  const goTo = useCallback(
    (nextIndex: number) =>
      setIndex(Math.max(0, Math.min(slides.length - 1, nextIndex))),
    [slides.length],
  );
  const next = useCallback(
    () => setIndex((i) => Math.min(slides.length - 1, i + 1)),
    [slides.length],
  );
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // render slides: the starting one first, then the rest in the background
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    const indices = [...slides.keys()];
    const order = [
      ...indices.slice(startIndex),
      ...indices.slice(0, startIndex),
    ];

    (async () => {
      for (const slideIndex of order) {
        try {
          const url = await renderSlideToSvgUrl(slides[slideIndex], input);
          if (cancelled) {
            URL.revokeObjectURL(url);
            break;
          }
          created.push(url);
          setUrls((prevUrls) => {
            const nextUrls = [...prevUrls];
            nextUrls[slideIndex] = url;
            return nextUrls;
          });
        } catch (error) {
          console.error(error);
        }
      }
    })();

    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [slides, input, startIndex]);

  // leaving fullscreen (e.g. Esc) ends the presentation
  useEffect(() => {
    let wasFullscreen = !!getFullscreenElement();
    const onFullscreenChange = () => {
      const isFullscreen = !!getFullscreenElement();
      if (wasFullscreen && !isFullscreen) {
        onExit();
      }
      wasFullscreen = isFullscreen;
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    rootRef.current?.focus();

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        onFullscreenChange,
      );
    };
  }, [onExit]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(
      () => setControlsVisible(false),
      CONTROLS_HIDE_DELAY,
    );
  }, []);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(hideTimerRef.current);
  }, [showControls]);

  // capture phase on window so the editor underneath never sees the keys
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      let handled = true;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
        case "Enter":
        case "n":
          next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
        case "p":
          prev();
          break;
        case "Home":
          goTo(0);
          break;
        case "End":
          goTo(slides.length - 1);
          break;
        case "Escape":
          onExit();
          break;
        default:
          handled = false;
      }
      if (handled) {
        event.preventDefault();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [next, prev, goTo, onExit, slides.length]);

  // tap/click right side → next, left side → previous; swipe on touch
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    showControls();
    if (!start || event.button > 0) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      dx < 0 ? next() : prev();
    } else if (event.clientX < window.innerWidth / 3) {
      prev();
    } else {
      next();
    }
  };

  const url = urls[index];

  return (
    <div
      ref={rootRef}
      className={`presentation-mode${
        controlsVisible ? "" : " presentation-mode--idle"
      }`}
      tabIndex={-1}
      role="dialog"
      // taps on slides shouldn't close an undocked sidebar underneath
      data-prevent-outside-click
      aria-label="Presentation"
      onPointerMove={showControls}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {url ? (
        <img
          className="presentation-mode__slide"
          src={url}
          alt={slides[index].name || `Slide ${index + 1}`}
          draggable={false}
        />
      ) : (
        <div className="presentation-mode__loading">Loading slide…</div>
      )}

      <div
        className="presentation-mode__controls"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => {
          event.stopPropagation();
          showControls();
        }}
      >
        <button
          type="button"
          onClick={prev}
          disabled={index === 0}
          aria-label="Previous slide"
          title="Previous (←)"
        >
          ‹
        </button>
        <span className="presentation-mode__counter">
          {index + 1} / {slides.length}
        </span>
        <button
          type="button"
          onClick={next}
          disabled={index === slides.length - 1}
          aria-label="Next slide"
          title="Next (→ / Space)"
        >
          ›
        </button>
        <button
          type="button"
          className="presentation-mode__exit"
          onClick={onExit}
          aria-label="Exit presentation"
          title="Exit (Esc)"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

export const PresentationMode = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [presentation, setPresentation] = useAtom(presentationAtom);
  const [snapshot, setSnapshot] = useState<{
    slides: Slide[];
    input: SlideRenderInput;
  } | null>(null);

  // snapshot the scene when the presentation starts
  useEffect(() => {
    if (!presentation || !excalidrawAPI) {
      setSnapshot(null);
      return;
    }
    const input = getSlideRenderInput(excalidrawAPI);
    const slides = getSlides(input.elements);
    if (!slides.length) {
      setPresentation(null);
      return;
    }
    setSnapshot({ slides, input });
  }, [presentation, excalidrawAPI, setPresentation]);

  const onExit = useCallback(() => {
    exitFullscreen();
    setPresentation(null);
  }, [setPresentation]);

  if (!presentation || !snapshot) {
    return null;
  }

  return createPortal(
    <Presenter
      slides={snapshot.slides}
      input={snapshot.input}
      startIndex={presentation.startIndex}
      onExit={onExit}
    />,
    document.body,
  );
};
