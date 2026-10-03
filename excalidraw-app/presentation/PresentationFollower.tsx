import { useEffect, useMemo, useRef, useState } from "react";

import { enterFullscreen, exitFullscreen } from "./fullscreen";
import { InkLayer, RemoteLaserLayer } from "./InkLayers";
import { ReplaySlide } from "./ReplaySlide";
import { renderSlideForReplay } from "./slideReplay";
import { renderSlideToSvgUrl } from "./slides";

import type { InkStroke } from "./inkStrokes";
import type { PresentationState } from "./presentationSync";
import type { ReplayController } from "./ReplaySlide";
import type { Slide, SlideRenderInput } from "./slides";

export type RemotePresentation = {
  socketId: string;
  username: string;
  state: PresentationState;
};

export const getPresenterName = (remote: RemotePresentation) =>
  remote.username || "Someone";

/**
 * What the presenter in the collaboration room is showing, rendered from this
 * client's copy of the scene.
 */
export const PresentationFollower = ({
  slides,
  input,
  remote,
  draft,
  onLeave,
}: {
  slides: readonly Slide[];
  input: SlideRenderInput;
  remote: RemotePresentation;
  draft: InkStroke | null;
  onLeave: () => void;
}) => {
  const { state } = remote;
  const slide = slides.find((candidate) => candidate.id === state.slideId);
  const replayRef = useRef<ReplayController | null>(null);

  // static renders (when not replaying), cached per slide
  const urls = useMemo(
    () => new Map<string, Promise<string>>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slides, input],
  );
  useEffect(
    () => () =>
      urls.forEach((url) =>
        url.then((value) => URL.revokeObjectURL(value)).catch(() => {}),
      ),
    [urls],
  );
  const [url, setUrl] = useState<{ slideId: string; url: string } | null>(null);
  useEffect(() => {
    if (!slide) {
      return;
    }
    let promise = urls.get(slide.id);
    if (!promise) {
      promise = renderSlideToSvgUrl(slide, input);
      urls.set(slide.id, promise);
    }
    let cancelled = false;
    promise
      .then((value) => !cancelled && setUrl({ slideId: slide.id, url: value }))
      .catch((error) => console.error(error));
    return () => {
      cancelled = true;
    };
  }, [slide, input, urls]);

  const replaySvgs = useMemo(
    () => new Map<string, Promise<SVGSVGElement>>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slides, input],
  );
  const getReplaySvg = (target: Slide) => {
    let svg = replaySvgs.get(target.id);
    if (!svg) {
      svg = renderSlideForReplay(target, input);
      replaySvgs.set(target.id, svg);
    }
    return svg;
  };
  const [replayFailed, setReplayFailed] = useState<number | null>(null);

  // the editor underneath shouldn't get keys; Esc leaves
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onLeave();
        event.preventDefault();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onLeave]);

  const label = slide?.name || `Slide ${state.slideNumber}`;
  const showReplay =
    slide && state.replay && state.play && replayFailed !== state.token;
  const visibleDraft =
    draft &&
    !state.strokes.some((stroke) => stroke.element.id === draft.element.id)
      ? draft
      : null;

  return (
    <div
      className="presentation-mode presentation-mode--following"
      role="dialog"
      aria-label={`${getPresenterName(remote)}'s presentation`}
      data-prevent-outside-click
      onContextMenu={(event) => event.preventDefault()}
    >
      {!slide ? (
        <div className="presentation-mode__loading">Waiting for the slide…</div>
      ) : showReplay ? (
        <ReplaySlide
          key={`${slide.id}:${state.token}`}
          slide={slide}
          input={input}
          getSvg={getReplaySvg}
          controllerRef={replayRef}
          label={label}
          onError={() => setReplayFailed(state.token)}
          finished={state.finished}
        />
      ) : url?.slideId === slide.id ? (
        <img
          className="presentation-mode__slide"
          src={url.url}
          alt={label}
          draggable={false}
        />
      ) : (
        <div className="presentation-mode__loading">Loading slide…</div>
      )}

      {slide && (
        <>
          <InkLayer
            key={slide.id}
            slide={slide}
            strokes={state.strokes}
            remoteDraft={visibleDraft}
          />
          <RemoteLaserLayer
            key={`laser:${slide.id}`}
            slide={slide}
            sessionId={state.sessionId}
          />
        </>
      )}

      <div className="presentation-mode__controls">
        <span className="presentation-mode__following">
          {getPresenterName(remote)} is presenting
        </span>
        <span className="presentation-mode__counter">
          {state.slideNumber} / {state.slideCount}
        </span>
        <button
          type="button"
          className="presentation-mode__pill"
          onClick={enterFullscreen}
          title="Fullscreen"
        >
          Fullscreen
        </button>
        <button
          type="button"
          className="presentation-mode__pill"
          onClick={() => {
            exitFullscreen();
            onLeave();
          }}
          title="Stop watching (Esc)"
        >
          Leave
        </button>
      </div>
    </div>
  );
};
