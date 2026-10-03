import { easeOut, getSvgPathFromStroke } from "@excalidraw/common";
import { getFreeDrawSvgPath } from "@excalidraw/element";
import { LaserPointer } from "@excalidraw/laser-pointer";
import { useEffect, useRef, useState } from "react";

import type { LaserPointerOptions } from "@excalidraw/laser-pointer";

import { INK_COLOR, addInkPoint, startInkStroke } from "./inkStrokes";

import type { InkStroke } from "./inkStrokes";
import type { Slide } from "./slides";

/** stroke width on screen (px), whatever the slide's size */
const INK_SCREEN_WIDTH = 1.5;

const InkPath = ({ stroke, slide }: { stroke: InkStroke; slide: Slide }) => (
  <path
    d={getFreeDrawSvgPath(stroke.element)}
    fill={stroke.element.strokeColor}
    transform={`translate(${stroke.element.x - slide.x} ${
      stroke.element.y - slide.y
    })`}
  />
);

/**
 * Pen ink over the slide. Laid out like the slide (fit and centered in the
 * same box), in the slide's coordinates, so it lines up at any screen size.
 */
export const InkLayer = ({
  slide,
  strokes,
  active,
  onStroke,
}: {
  slide: Slide;
  strokes: readonly InkStroke[];
  /** pen on: pointer input draws instead of navigating */
  active: boolean;
  onStroke: (stroke: InkStroke) => void;
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<InkStroke | null>(null);
  const draftRef = useRef<InkStroke | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const toSlide = (event: { clientX: number; clientY: number }) => {
    const matrix = svgRef.current?.getScreenCTM()?.inverse();
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix,
    );
    return {
      x: slide.x + point.x,
      y: slide.y + point.y,
      // slide units per screen px
      scale: matrix ? Math.hypot(matrix.a, matrix.b) : 1,
    };
  };

  const setDraftStroke = (stroke: InkStroke | null) => {
    draftRef.current = stroke;
    setDraft(stroke);
  };

  const finish = () => {
    const stroke = draftRef.current;
    pointerIdRef.current = null;
    setDraftStroke(null);
    if (stroke) {
      onStroke(stroke);
    }
  };

  // pen turned off mid-stroke
  useEffect(() => {
    if (!active && draftRef.current) {
      finish();
    }
  });

  return (
    <svg
      ref={svgRef}
      className={`presentation-mode__ink${
        active ? " presentation-mode__ink--active" : ""
      }`}
      viewBox={`0 0 ${slide.width} ${slide.height}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={(event) => {
        if (!active || event.button > 0 || pointerIdRef.current !== null) {
          return;
        }
        // drawing, not navigating
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        pointerIdRef.current = event.pointerId;
        const { x, y, scale } = toSlide(event);
        setDraftStroke(
          startInkStroke({
            x,
            y,
            pressure: event.pressure,
            strokeWidth: INK_SCREEN_WIDTH * scale,
            now: Date.now(),
          }),
        );
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerIdRef.current || !draftRef.current) {
          return;
        }
        event.stopPropagation();
        // coalesced events: smoother strokes with a pen
        const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
        let stroke = draftRef.current;
        for (const pointerEvent of events.length
          ? events
          : [event.nativeEvent]) {
          const { x, y } = toSlide(pointerEvent);
          stroke = addInkPoint(
            stroke,
            { x, y, pressure: pointerEvent.pressure },
            Date.now(),
          );
        }
        setDraftStroke(stroke);
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== pointerIdRef.current) {
          return;
        }
        event.stopPropagation();
        finish();
      }}
      onPointerCancel={(event) => {
        if (event.pointerId === pointerIdRef.current) {
          finish();
        }
      }}
    >
      {strokes.map((stroke) => (
        <InkPath key={stroke.element.id} stroke={stroke} slide={slide} />
      ))}
      {draft && <InkPath stroke={draft} slide={slide} />}
    </svg>
  );
};

// the editor's laser trail
const LASER_DECAY_TIME = 1000;
const LASER_DECAY_LENGTH = 50;
const LASER_OPTIONS: Partial<LaserPointerOptions> = {
  size: 4,
  simplify: 0,
  streamline: 0.4,
  sizeMapping: (c) => {
    const t = Math.max(
      0,
      1 - (performance.now() - c.pressure) / LASER_DECAY_TIME,
    );
    const l =
      (LASER_DECAY_LENGTH -
        Math.min(LASER_DECAY_LENGTH, c.totalLength - c.currentIndex)) /
      LASER_DECAY_LENGTH;
    return Math.min(easeOut(l), easeOut(t));
  },
};

/** A laser pointer trail that fades out (in screen pixels). */
export const LaserLayer = ({ active }: { active: boolean }) => {
  const pathRef = useRef<SVGPathElement>(null);
  const trailsRef = useRef<LaserPointer[]>([]);
  const currentRef = useRef<{ trail: LaserPointer; pointerId: number } | null>(
    null,
  );
  const frameRef = useRef(0);

  const render = () => {
    frameRef.current = 0;
    const trails = trailsRef.current.filter(
      (trail) =>
        trail === currentRef.current?.trail ||
        trail.getStrokeOutline().length > 0,
    );
    trailsRef.current = trails;
    pathRef.current?.setAttribute(
      "d",
      trails
        .map((trail) => getSvgPathFromStroke(trail.getStrokeOutline(), true))
        .join(" "),
    );
    if (trails.length) {
      frameRef.current = requestAnimationFrame(render);
    }
  };

  const schedule = () => {
    frameRef.current ||= requestAnimationFrame(render);
  };

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return (
    <svg
      className={`presentation-mode__laser${
        active ? " presentation-mode__laser--active" : ""
      }`}
      onPointerDown={(event) => {
        if (!active || event.button > 0 || currentRef.current) {
          return;
        }
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const trail = new LaserPointer(LASER_OPTIONS);
        trail.addPoint([event.clientX, event.clientY, performance.now()]);
        currentRef.current = { trail, pointerId: event.pointerId };
        trailsRef.current.push(trail);
        schedule();
      }}
      onPointerMove={(event) => {
        const current = currentRef.current;
        if (current?.pointerId !== event.pointerId) {
          return;
        }
        event.stopPropagation();
        current.trail.addPoint([
          event.clientX,
          event.clientY,
          performance.now(),
        ]);
        schedule();
      }}
      onPointerUp={(event) => {
        const current = currentRef.current;
        if (current?.pointerId !== event.pointerId) {
          return;
        }
        event.stopPropagation();
        current.trail.close();
        currentRef.current = null;
        schedule();
      }}
      onPointerCancel={(event) => {
        if (currentRef.current?.pointerId === event.pointerId) {
          currentRef.current.trail.close();
          currentRef.current = null;
          schedule();
        }
      }}
    >
      <path ref={pathRef} fill={INK_COLOR} />
    </svg>
  );
};
