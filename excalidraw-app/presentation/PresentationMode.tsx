import { randomId } from "@excalidraw/common";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { atom, useAtom, useSetAtom } from "../app-jotai";

import { renderSlideForReplay } from "./slideReplay";
import {
  getSlideRenderInput,
  getSlides,
  isSlideReplayEnabled,
  renderSlideToSvgUrl,
} from "./slides";
import { useDrawingRecorder } from "./useDrawingRecorder";
import { ReplaySlide } from "./ReplaySlide";
import {
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from "./fullscreen";

import { InkLayer, LaserLayer } from "./InkLayers";
import { keepInk } from "./inkStrokes";
import {
  PresentationRecorder,
  formatDuration,
  recordingsChangedAtom,
  saveRecording,
} from "./presentationRecording";
import { SYNC_FLASH_DURATION, playSyncChirp } from "./syncChirp";
import {
  PRESENTATION_HEARTBEAT,
  PRESENTATION_TIMEOUT,
  broadcastPresentation,
  onPresentationMessage,
} from "./presentationSync";
import { PresentationFollower, getPresenterName } from "./PresentationFollower";

import "./Presentation.scss";

import type { InkStroke } from "./inkStrokes";
import type { PresentationRecording } from "./presentationRecording";
import type { RemotePresentation } from "./PresentationFollower";
import type { PresentationState, SlidePoint } from "./presentationSync";
import type { ReplayController } from "./ReplaySlide";
import type { Slide, SlideRenderInput } from "./slides";

/** non-null while presenting */
export const presentationAtom = atom<{ startIndex: number } | null>(null);

const CONTROLS_HIDE_DELAY = 2500;
const SWIPE_THRESHOLD = 50;
const ANIMATE_STORAGE_KEY = "excalidraw-presentation-animate";

const EMPTY_INK: readonly InkStroke[] = [];
const DRAFT_BROADCAST_INTERVAL = 50;
const CLEAN_HINT_DURATION = 2500;
const CLEAN_EXIT_CORNER = 96;
const DOUBLE_TAP_TIME = 500;

const LASER_BROADCAST_INTERVAL = 25;

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
  onKeepInk,
  onRecording,
}: {
  slides: readonly Slide[];
  input: SlideRenderInput;
  startIndex: number;
  onExit: () => void;
  /** saves ink into the drawing */
  onKeepInk: (slide: Slide, strokes: readonly InkStroke[]) => void;
  /** a finished recording */
  onRecording: (recording: PresentationRecording) => void;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const clampIndex = useCallback(
    (nextIndex: number) => Math.max(0, Math.min(slides.length - 1, nextIndex)),
    [slides.length],
  );
  // `play`: replay the drawing (when going forward), `token`: restarts it
  const [visit, setVisit] = useState<{
    index: number;
    play: boolean;
    token: number;
    finished?: boolean;
  }>(() => ({
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
      // (for people following)
      setVisit((prevVisit) => ({ ...prevVisit, finished: true }));
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
        finished: false,
      })),
    [],
  );
  // show the static slide instead
  const onReplayError = useCallback(
    () => setVisit((prevVisit) => ({ ...prevVisit, play: false })),
    [],
  );
  // pen/laser; ink is per slide, for this presentation only unless kept
  const [tool, setTool] = useState<"pen" | "laser" | null>(null);
  const [ink, setInk] = useState<ReadonlyMap<string, readonly InkStroke[]>>(
    () => new Map(),
  );
  const slideId = slides[index].id;
  const slideInk = ink.get(slideId) ?? EMPTY_INK;
  const hasUnkeptInk = slideInk.some((stroke) => !stroke.kept);

  const updateSlideInk = useCallback(
    (update: (strokes: readonly InkStroke[]) => readonly InkStroke[]) =>
      setInk((prevInk) => {
        const nextInk = new Map(prevInk);
        nextInk.set(slideId, update(prevInk.get(slideId) ?? EMPTY_INK));
        return nextInk;
      }),
    [slideId],
  );
  const toggleTool = useCallback(
    (nextTool: "pen" | "laser") =>
      setTool((prevTool) => (prevTool === nextTool ? null : nextTool)),
    [],
  );
  const addStroke = useCallback(
    (stroke: InkStroke) => updateSlideInk((strokes) => [...strokes, stroke]),
    [updateSlideInk],
  );
  // kept ink is in the drawing; only clear/undo the rest
  const clearInk = useCallback(
    () => updateSlideInk((strokes) => strokes.filter((stroke) => stroke.kept)),
    [updateSlideInk],
  );
  const undoInk = useCallback(
    () =>
      updateSlideInk((strokes) => {
        const lastIndex = strokes.findLastIndex((stroke) => !stroke.kept);
        return lastIndex === -1
          ? strokes
          : strokes.filter((_, strokeIndex) => strokeIndex !== lastIndex);
      }),
    [updateSlideInk],
  );
  const keepSlideInk = useCallback(() => {
    if (!hasUnkeptInk) {
      return;
    }
    onKeepInk(slides[index], slideInk);
    updateSlideInk((strokes) =>
      strokes.map((stroke) =>
        stroke.kept ? stroke : { ...stroke, kept: true },
      ),
    );
  }, [hasUnkeptInk, onKeepInk, slides, index, slideInk, updateSlideInk]);

  // clean mode: nothing but the slide (for screen recordings)
  const [clean, setClean] = useState(false);
  const [cleanHint, setCleanHint] = useState(false);
  const toggleClean = useCallback(
    () => setClean((prevClean) => !prevClean),
    [],
  );
  useEffect(() => {
    setCleanHint(clean);
    if (clean) {
      const timer = window.setTimeout(
        () => setCleanHint(false),
        CLEAN_HINT_DURATION,
      );
      return () => window.clearTimeout(timer);
    }
  }, [clean]);
  // double-tap the top-right corner to get the controls back (no Esc on iPad)
  const cornerTapRef = useRef(0);
  const onPointerDownCapture = (event: React.PointerEvent) => {
    if (
      !clean ||
      event.clientX < window.innerWidth - CLEAN_EXIT_CORNER ||
      event.clientY > CLEAN_EXIT_CORNER
    ) {
      return;
    }
    // neither drawing nor navigating
    event.stopPropagation();
    const now = performance.now();
    if (now - cornerTapRef.current < DOUBLE_TAP_TIME) {
      cornerTapRef.current = 0;
      setClean(false);
    } else {
      cornerTapRef.current = now;
    }
  };

  // sync chirp + flash, for lining up with the camera's recording
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (flash) {
      const timer = window.setTimeout(() => setFlash(0), SYNC_FLASH_DURATION);
      return () => window.clearTimeout(timer);
    }
  }, [flash]);
  const sync = useCallback(() => {
    const start = playSyncChirp();
    setFlash(start);
    return start;
  }, []);

  // recording what's shown, to export it as a video afterwards
  const recorderRef = useRef<PresentationRecorder | null>(null);
  const [recordingStart, setRecordingStart] = useState<number | null>(null);
  const [, setRecordingTick] = useState(0);
  useEffect(() => {
    if (recordingStart === null) {
      return;
    }
    const timer = window.setInterval(
      () => setRecordingTick((tick) => tick + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [recordingStart]);
  const onRecordingRef = useRef(onRecording);
  onRecordingRef.current = onRecording;
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecordingStart(null);
    if (recorder) {
      onRecordingRef.current(recorder.finish(randomId()));
    }
  }, []);
  // exiting stops (and saves) the recording
  useEffect(() => stopRecording, [stopRecording]);

  const toggleRecording = useCallback(() => {
    if (recorderRef.current) {
      stopRecording();
      return;
    }
    // time 0 is the chirp
    const start = sync();
    const recorder = new PresentationRecorder(
      start,
      Date.now() + (start - performance.now()),
      {
        elements: input.elements,
        files: input.files,
        viewBackgroundColor: input.appState.viewBackgroundColor,
        theme: input.appState.theme,
      },
    );
    recorder.state(presentationStateRef.current, start);
    recorderRef.current = recorder;
    setRecordingStart(start);
    setClean(true);
  }, [sync, stopRecording, input]);

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
    if (animate && nextSlide && isSlideReplayEnabled(nextSlide)) {
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        undoInk();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
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
        case "d":
          toggleTool("pen");
          break;
        case "l":
          toggleTool("laser");
          break;
        case "e":
          clearInk();
          break;
        case "k":
          keepSlideInk();
          break;
        case "c":
          toggleClean();
          break;
        case "s":
          sync();
          break;
        case "R":
          toggleRecording();
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
  }, [
    next,
    prev,
    goTo,
    replay,
    toggleAnimate,
    toggleTool,
    clearInk,
    undoInk,
    keepSlideInk,
    toggleClean,
    sync,
    toggleRecording,
    onExit,
    slides.length,
  ]);

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
  // the A/✎ switch turns it off for all slides; the sidebar per slide
  const canReplay = animate && isSlideReplayEnabled(slides[index]);

  // presenting to the people in the live-collaboration room (if any)
  const sessionId = useMemo(() => randomId(), []);
  const presentationState = useMemo<PresentationState>(
    () => ({
      sessionId,
      slideId,
      slideNumber: index + 1,
      slideCount: slides.length,
      play: visit.play,
      token: visit.token,
      finished: !!visit.finished,
      replay: canReplay,
      strokes: slideInk,
    }),
    [sessionId, slideId, index, slides.length, visit, canReplay, slideInk],
  );
  const presentationStateRef = useRef(presentationState);
  presentationStateRef.current = presentationState;
  useEffect(() => {
    broadcastPresentation({ kind: "state", state: presentationState });
    recorderRef.current?.state(presentationState);
  }, [presentationState]);
  useEffect(() => {
    // for people joining late, and messages that got dropped
    const heartbeat = window.setInterval(
      () =>
        broadcastPresentation(
          { kind: "state", state: presentationStateRef.current },
          true,
        ),
      PRESENTATION_HEARTBEAT,
    );
    return () => {
      window.clearInterval(heartbeat);
      broadcastPresentation({ kind: "end", sessionId });
    };
  }, [sessionId]);

  const draftTimerRef = useRef(0);
  const draftRef = useRef<InkStroke | null>(null);
  const onDraft = useCallback(
    (stroke: InkStroke | null) => {
      draftRef.current = stroke;
      if (!stroke) {
        // the finished stroke comes with the next state
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = 0;
        return;
      }
      draftTimerRef.current ||= window.setTimeout(() => {
        draftTimerRef.current = 0;
        broadcastPresentation(
          { kind: "draft", sessionId, stroke: draftRef.current },
          true,
        );
      }, DRAFT_BROADCAST_INTERVAL);
    },
    [sessionId],
  );
  useEffect(() => () => window.clearTimeout(draftTimerRef.current), []);

  const lastLaserBroadcastRef = useRef(0);
  const onLaserPoint = useCallback(
    (point: SlidePoint | null) => {
      const now = performance.now();
      recorderRef.current?.laser(point, now);
      if (
        point &&
        now - lastLaserBroadcastRef.current < LASER_BROADCAST_INTERVAL
      ) {
        return;
      }
      lastLaserBroadcastRef.current = now;
      // lifting must arrive, or the trail would stay
      broadcastPresentation({ kind: "laser", sessionId, point }, !!point);
    },
    [sessionId],
  );

  return (
    <div
      ref={rootRef}
      className={`presentation-mode${
        // keep the cursor while drawing/pointing
        controlsVisible || tool ? "" : " presentation-mode--idle"
      }${clean ? " presentation-mode--clean" : ""}`}
      tabIndex={-1}
      role="dialog"
      // taps on slides shouldn't close an undocked sidebar underneath
      data-prevent-outside-click
      aria-label="Presentation"
      onPointerMove={showControls}
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {canReplay && visit.play ? (
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

      <InkLayer
        key={slideId}
        slide={slides[index]}
        strokes={slideInk}
        active={tool === "pen"}
        onStroke={addStroke}
        onDraft={onDraft}
      />
      <LaserLayer
        key={`laser:${slideId}`}
        slide={slides[index]}
        active={tool === "laser"}
        onPoint={onLaserPoint}
      />

      {!!flash && <div className="presentation-mode__flash" />}
      {cleanHint && (
        <div className="presentation-mode__hint">
          Double-tap the top-right corner to show the controls
        </div>
      )}
      {clean && recordingStart !== null && (
        <div
          className="presentation-mode__recording-dot"
          aria-label="Recording"
        />
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
          disabled={!canReplay}
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
        <span className="presentation-mode__divider" />
        <button
          type="button"
          className="presentation-mode__pill"
          onClick={() => toggleTool("pen")}
          aria-pressed={tool === "pen"}
          title="Pen: draw on the slide (D)"
        >
          Pen
        </button>
        <button
          type="button"
          className="presentation-mode__pill"
          onClick={() => toggleTool("laser")}
          aria-pressed={tool === "laser"}
          title="Laser pointer (L)"
        >
          Laser
        </button>
        {hasUnkeptInk && (
          <>
            <button
              type="button"
              className="presentation-mode__pill"
              onClick={clearInk}
              title="Clear this slide's ink (E; Ctrl+Z undoes a stroke)"
            >
              Clear
            </button>
            <button
              type="button"
              className="presentation-mode__pill"
              onClick={keepSlideInk}
              title="Save this slide's ink into the drawing (K)"
            >
              Keep
            </button>
          </>
        )}
        <span className="presentation-mode__divider" />
        <button
          type="button"
          className="presentation-mode__pill"
          onClick={toggleClean}
          title="Clean mode: hide the controls, for screen recording (C). Double-tap the top-right corner to bring them back."
        >
          Clean
        </button>
        <button
          type="button"
          className="presentation-mode__pill"
          onClick={sync}
          title="Sync: flash and chirp, to line up with your camera recording (S)"
        >
          Sync
        </button>
        <button
          type="button"
          className="presentation-mode__pill presentation-mode__record"
          onClick={toggleRecording}
          aria-pressed={recordingStart !== null}
          title={
            recordingStart === null
              ? "Record the presentation, to export it as a video later (Shift+R). Starts with a sync chirp."
              : "Stop recording (Shift+R)"
          }
        >
          {recordingStart === null
            ? "● Rec"
            : `■ ${formatDuration(performance.now() - recordingStart)}`}
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

  const setRecordingsChanged = useSetAtom(recordingsChangedAtom);
  const onRecording = useCallback(
    async (recording: PresentationRecording) => {
      try {
        await saveRecording(recording);
        setRecordingsChanged((count) => count + 1);
        excalidrawAPI?.setToast({
          message: `Recording saved (${formatDuration(
            recording.duration,
          )}). Export it as a video from the Presentation sidebar.`,
          closable: true,
        });
      } catch (error: any) {
        console.error(error);
        excalidrawAPI?.setToast({
          message: `Couldn't save the recording: ${error?.message || error}`,
          closable: true,
        });
      }
    },
    [excalidrawAPI, setRecordingsChanged],
  );

  const onKeepInk = useCallback(
    (slide: Slide, strokes: readonly InkStroke[]) => {
      if (excalidrawAPI) {
        keepInk(excalidrawAPI, slide, strokes);
        excalidrawAPI.setToast({ message: "Ink saved to the slide" });
      }
    },
    [excalidrawAPI],
  );

  const remote = useRemotePresentation();
  const [leftSessionId, setLeftSessionId] = useState<string | null>(null);
  const following =
    !presentation &&
    !!remote &&
    remote.presentation.state.sessionId !== leftSessionId;

  // the scene as of when following started (re-taken for slides it lacks,
  // e.g. ones that synced later)
  const [followSnapshot, setFollowSnapshot] = useState<{
    slides: Slide[];
    input: SlideRenderInput;
  } | null>(null);
  const followedSlideId = remote?.presentation.state.slideId;
  useEffect(() => {
    if (!following || !excalidrawAPI) {
      setFollowSnapshot(null);
      return;
    }
    setFollowSnapshot((prevSnapshot) => {
      if (prevSnapshot?.slides.some((slide) => slide.id === followedSlideId)) {
        return prevSnapshot;
      }
      const input = getSlideRenderInput(excalidrawAPI);
      return { slides: getSlides(input.elements), input };
    });
  }, [following, excalidrawAPI, followedSlideId, remote?.receivedAt]);

  const onLeave = useCallback(
    () => setLeftSessionId(remote?.presentation.state.sessionId ?? null),
    [remote?.presentation.state.sessionId],
  );

  if (presentation && snapshot) {
    return createPortal(
      <Presenter
        slides={snapshot.slides}
        input={snapshot.input}
        startIndex={presentation.startIndex}
        onExit={onExit}
        onKeepInk={onKeepInk}
        onRecording={onRecording}
      />,
      document.body,
    );
  }

  if (following && followSnapshot && remote) {
    return createPortal(
      <PresentationFollower
        slides={followSnapshot.slides}
        input={followSnapshot.input}
        remote={remote.presentation}
        draft={remote.draft}
        onLeave={onLeave}
      />,
      document.body,
    );
  }

  if (!presentation && remote) {
    return createPortal(
      <button
        type="button"
        className="presentation-rejoin"
        onClick={() => setLeftSessionId(null)}
      >
        ▶ Watch {getPresenterName(remote.presentation)}'s presentation
      </button>,
      document.body,
    );
  }

  return null;
};

/** The presentation someone in the collaboration room is giving, if any. */
const useRemotePresentation = () => {
  const [remote, setRemote] = useState<{
    presentation: RemotePresentation;
    draft: InkStroke | null;
    receivedAt: number;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = onPresentationMessage((message) => {
      setRemote((prev) => {
        const sessionId = prev?.presentation.state.sessionId;
        switch (message.kind) {
          case "state": {
            const { state } = message;
            // a stroke being drawn ends up in the state when finished
            const draft =
              prev?.draft &&
              sessionId === state.sessionId &&
              prev.presentation.state.slideId === state.slideId
                ? prev.draft
                : null;
            return {
              presentation: {
                socketId: message.socketId,
                username: message.username,
                state,
              },
              draft,
              receivedAt: Date.now(),
            };
          }
          case "draft":
            return prev && message.sessionId === sessionId
              ? { ...prev, draft: message.stroke, receivedAt: Date.now() }
              : prev;
          case "end":
            return message.sessionId === sessionId ? null : prev;
          default:
            return prev;
        }
      });
    });

    // the presenter left (or lost connection) without saying so
    const timeout = window.setInterval(
      () =>
        setRemote((prev) =>
          prev && Date.now() - prev.receivedAt > PRESENTATION_TIMEOUT
            ? null
            : prev,
        ),
      1000,
    );

    return () => {
      unsubscribe();
      window.clearInterval(timeout);
    };
  }, []);

  return remote;
};
