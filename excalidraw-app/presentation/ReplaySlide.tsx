import { useEffect, useRef } from "react";

import { getSlideReplayTimeline, SlideReplay } from "./slideReplay";

import type { Slide, SlideRenderInput } from "./slides";

export type ReplayController = {
  isPlaying: () => boolean;
  finish: () => void;
};

/** A slide that replays how it was drawn. */
export const ReplaySlide = ({
  slide,
  input,
  getSvg,
  controllerRef,
  label,
  onError,
  finished = false,
}: {
  slide: Slide;
  input: SlideRenderInput;
  getSvg: (slide: Slide) => Promise<SVGSVGElement>;
  controllerRef: React.MutableRefObject<ReplayController | null>;
  label: string;
  onError: () => void;
  /** show the end of the replay (now, or as soon as it's loaded) */
  finished?: boolean;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(finished);
  finishedRef.current = finished;

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
        if (finishedRef.current) {
          replay.seek(Infinity);
          return;
        }
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

  useEffect(() => {
    if (finished) {
      controllerRef.current?.finish();
    }
  }, [finished, controllerRef]);

  return (
    <div
      ref={containerRef}
      className="presentation-mode__slide presentation-mode__slide--replay"
      role="img"
      aria-label={label}
    />
  );
};
