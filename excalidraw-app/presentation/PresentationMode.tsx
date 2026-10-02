import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { atom, useAtom, useSetAtom } from "../app-jotai";

import {
  getSlideReplayTimeline,
  renderSlideForReplay,
  SlideReplay,
} from "./slideReplay";
import { getSlideRenderInput, getSlides, renderSlideToSvgUrl } from "./slides";
import { useDrawingRecorder } from "./useDrawingRecorder";

import "./Presentation.scss";

import type { Slide, SlideRenderInput } from "./slides";

/** non-null while presenting */
export const presentationAtom = atom<{ startIndex: number } | null>(null);

const CONTROLS_HIDE_DELAY = 2500;
const SWIPE_THRESHOLD = 50;
const ANIMATE_STORAGE_KEY = "excalidraw-presentation-animate";

const loadAnimatePreference = () => {
  try {
    return localStorage.getItem(ANIMATE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};

const saveAnimatePreference = (animate: boolean) => {
  try {
    localStorage.setItem(ANIMATE_STORAGE_KEY, String(animate));
  } catch {}
};

type ReplayController = {
  isPlaying: () => boolean;
  finish: () => void;
};

/** A slide that replays how it was drawn. */
const ReplaySlide = ({
  slide,
  input,
  getSvg,
  controllerRef,
  label,
  onError,
}: {
  slide: Slide;
  input: SlideRenderInput;
  getSvg: (slide: Slide) => Promise<SVGSVGElement>;
  controllerRef: React.MutableRefObject<ReplayController | null>;
  label: string;
  onError: () => void;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let svg: SVGSVGElement | null = null;
    let controller: ReplayController | null = null;

    (async () => {
      try {
        const template = await getSvg(slide);
        const container = containerRef.current;
        if (cancelled || !container) {
          return;
        }
        // the replay mutates the nodes; keep the cached render pristine
        svg = template.cloneNode(true) as SVGSVGElement;
        container.appendChild(svg);

        const replay = new SlideReplay(
          svg,
          getSlideReplayTimeline(slide, input),
        );
        replay.seek(0);

        let playing = true;
        const startTime = performance.now();
        const tick = (now: number) => {
          const time = now - startTime;
          replay.seek(time);
          if (time >= replay.duration) {
            playing = false;
            return;
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);

        controller = {
          isPlaying: () => playing,
          finish: () => {
            cancelAnimationFrame(frame);
            replay.seek(Infinity);
            playing = false;
          },
        };
        controllerRef.current = controller;
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          onError();
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      svg?.remove();
      if (controller && controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [slide, input, getSvg, controllerRef, onError]);

  return (
    <div
      ref={containerRef}
      className="presentation-mode__slide presentation-mode__slide--replay"
      role="img"
      aria-label={label}
    />
  );
};

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
  const clampIndex = useCallback(
    (nextIndex: number) => Math.max(0, Math.min(slides.length - 1, nextIndex)),
    [slides.length],
  );
  // `play`: replay the drawing (when going forward), `token`: restarts it
  const [visit, setVisit] = useState(() => ({
    index: clampIndex(startIndex),
    play: true,
    token: 0,
  }));
  const { index } = visit;
  const [animate, setAnimate] = useState(loadAnimatePreference);
  const replayRef = useRef<ReplayController | null>(null);
  const [urls, setUrls] = useState<(string | null)[]>(() =>
    slides.map(() => null),
  );
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<number>(0);

  const goTo = useCallback(
    (nextIndex: number) =>
      setVisit((prevVisit) => ({
        index: clampIndex(nextIndex),
        play: true,
        token: prevVisit.token + 1,
      })),
    [clampIndex],
  );
  const next = useCallback(() => {
    // first press finishes the replay, like a click-through animation
    if (replayRef.current?.isPlaying()) {
      replayRef.current.finish();
      return;
    }
    setVisit((prevVisit) =>
      prevVisit.index >= slides.length - 1
        ? prevVisit
        : {
            index: prevVisit.index + 1,
            play: true,
            token: prevVisit.token + 1,
          },
    );
  }, [slides.length]);
  // going back shows the finished slide
  const prev = useCallback(
    () =>
      setVisit((prevVisit) =>
        prevVisit.index <= 0
          ? prevVisit
          : {
              index: prevVisit.index - 1,
              play: false,
              token: prevVisit.token + 1,
            },
      ),
    [],
  );
  const replay = useCallback(
    () =>
      setVisit((prevVisit) => ({
        ...prevVisit,
        play: true,
        token: prevVisit.token + 1,
      })),
    [],
  );
  // show the static slide instead
  const onReplayError = useCallback(
    () => setVisit((prevVisit) => ({ ...prevVisit, play: false })),
    [],
  );
  const toggleAnimate = useCallback(() => {
    setAnimate((prevAnimate) => {
      saveAnimatePreference(!prevAnimate);
      return !prevAnimate;
    });
  }, []);

  // replay renders, cached per presentation (and prefetched for the next slide)
  const replaySvgs = useMemo(
    () => new Map<string, Promise<SVGSVGElement>>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slides, input],
  );
  const getReplaySvg = useCallback(
    (slide: Slide) => {
      let svg = replaySvgs.get(slide.id);
      if (!svg) {
        svg = renderSlideForReplay(slide, input);
        replaySvgs.set(slide.id, svg);
        svg.catch(() => replaySvgs.delete(slide.id));
      }
      return svg;
    },
    [replaySvgs, input],
  );
  useEffect(() => {
    const nextSlide = slides[index + 1];
    if (animate && nextSlide) {
      getReplaySvg(nextSlide).catch(() => {});
    }
  }, [animate, index, slides, getReplaySvg]);

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
        case "r":
          replay();
          break;
        case "a":
          toggleAnimate();
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
  }, [next, prev, goTo, replay, toggleAnimate, onExit, slides.length]);

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
      {animate && visit.play ? (
        <ReplaySlide
          key={`${index}:${visit.token}`}
          slide={slides[index]}
          input={input}
          getSvg={getReplaySvg}
          controllerRef={replayRef}
          label={slides[index].name || `Slide ${index + 1}`}
          onError={onReplayError}
        />
      ) : url ? (
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
          className="presentation-mode__text-button"
          onClick={replay}
          disabled={!animate}
          aria-label="Replay drawing"
          title="Replay drawing (R)"
        >
          ↻
        </button>
        <button
          type="button"
          className="presentation-mode__text-button"
          onClick={toggleAnimate}
          aria-pressed={animate}
          aria-label="Animate drawing"
          title={`Animate drawing: ${animate ? "on" : "off"} (A)`}
        >
          ✎
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
  // record drawing timings while editing, for replaying them when presenting
  useDrawingRecorder();
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
