import { easeOut, getSvgPathFromStroke } from "@excalidraw/common";
import { getFreeDrawSvgPath } from "@excalidraw/element";
import { LaserPointer } from "@excalidraw/laser-pointer";
import { useEffect, useRef, useState } from "react";

import type { LaserPointerOptions } from "@excalidraw/laser-pointer";

import { INK_COLOR, addInkPoint, startInkStroke } from "./inkStrokes";
import { onPresentationMessage } from "./presentationSync";

import type { InkStroke } from "./inkStrokes";
import type { SlidePoint } from "./presentationSync";
import type { Slide } from "./slides";

/** stroke width on screen (px), whatever the slide's size */
const INK_SCREEN_WIDTH = 1.5;

/**
 * An SVG laid out like the slide (fit and centered in the same box), in the
 * slide's coordinates, so what's drawn in it lines up at any screen size.
 */
const SlideSvg = ({
  slide,
  className,
  svgRef,
  children,
  ...handlers
}: {
  slide: Slide;
  className: string;
  svgRef: React.RefObject<SVGSVGElement | null>;
  children?: React.ReactNode;
} & React.DOMAttributes<SVGSVGElement>) => (
  <svg
    ref={svgRef}
    className={className}
    viewBox={`0 0 ${slide.width} ${slide.height}`}
    preserveAspectRatio="xMidYMid meet"
    {...handlers}
  >
    {children}
  </svg>
);

/** client coordinates → slide coordinates, and slide units per screen px */
const toSlidePoint = (
  svg: SVGSVGElement | null,
  event: { clientX: number; clientY: number },
) => {
  const matrix = svg?.getScreenCTM()?.inverse();
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    matrix,
  );
  return {
    x: point.x,
    y: point.y,
    scale: matrix ? Math.hypot(matrix.a, matrix.b) : 1,
  };
};

const InkPath = ({ stroke, slide }: { stroke: InkStroke; slide: Slide }) => (
  <path
    d={getFreeDrawSvgPath(stroke.element)}
    fill={stroke.element.strokeColor}
    transform={`translate(${stroke.element.x - slide.x} ${
      stroke.element.y - slide.y
    })`}
  />
);

/** Pen ink over the slide. */
export const InkLayer = ({
  slide,
  strokes,
  active,
  onStroke,
  onDraft,
  remoteDraft,
}: {
  slide: Slide;
  strokes: readonly InkStroke[];
  /** pen on: pointer input draws instead of navigating */
  active: boolean;
  onStroke?: (stroke: InkStroke) => void;
  /** the stroke being drawn (`null` when done) */
  onDraft?: (stroke: InkStroke | null) => void;
  /** a stroke being drawn by the presenter (when following) */
  remoteDraft?: InkStroke | null;
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<InkStroke | null>(null);
  const draftRef = useRef<InkStroke | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const setDraftStroke = (stroke: InkStroke | null) => {
    draftRef.current = stroke;
    setDraft(stroke);
    onDraft?.(stroke);
  };

  const finish = () => {
    const stroke = draftRef.current;
    pointerIdRef.current = null;
    setDraftStroke(null);
    if (stroke) {
      onStroke?.(stroke);
    }
  };

  // pen turned off mid-stroke
  useEffect(() => {
    if (!active && draftRef.current) {
      finish();
    }
  });

  const toScene = (event: { clientX: number; clientY: number }) => {
    const { x, y, scale } = toSlidePoint(svgRef.current, event);
    return { x: slide.x + x, y: slide.y + y, scale };
  };

  return (
    <SlideSvg
      slide={slide}
      svgRef={svgRef}
      className={`presentation-mode__ink${
        active ? " presentation-mode__ink--active" : ""
      }`}
      onPointerDown={(event) => {
        if (!active || event.button > 0 || pointerIdRef.current !== null) {
          return;
        }
        // drawing, not navigating
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        pointerIdRef.current = event.pointerId;
        const { x, y, scale } = toScene(event);
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
          const { x, y } = toScene(pointerEvent);
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
      {remoteDraft && <InkPath stroke={remoteDraft} slide={slide} />}
    </SlideSvg>
  );
};

// the editor's laser trail
const LASER_SCREEN_SIZE = 4;
const LASER_DECAY_TIME = 1000;
const LASER_DECAY_LENGTH = 50;

/**
 * Fading laser trails, in slide coordinates (sized for the screen).
 */
class LaserTrails {
  private trails: LaserPointer[] = [];
  private current: LaserPointer | null = null;
  private frame = 0;

  constructor(
    private getPath: () => SVGPathElement | null,
    /** slide units per screen px */
    private getScale: () => number,
  ) {}

  private options(): Partial<LaserPointerOptions> {
    // decay length is in slide units too
    const decayLength = LASER_DECAY_LENGTH * this.getScale();
    return {
      size: LASER_SCREEN_SIZE,
      simplify: 0,
      streamline: 0.4,
      sizeMapping: (c) => {
        const t = Math.max(
          0,
          1 - (performance.now() - c.pressure) / LASER_DECAY_TIME,
        );
        const l =
          (decayLength -
            Math.min(decayLength, c.totalLength - c.currentIndex)) /
          decayLength;
        return Math.min(easeOut(l), easeOut(t));
      },
    };
  }

  add(point: SlidePoint) {
    if (!this.current) {
      this.current = new LaserPointer(this.options());
      this.trails.push(this.current);
    }
    this.current.addPoint([point[0], point[1], performance.now()]);
    this.schedule();
  }

  end() {
    this.current?.close();
    this.current = null;
    this.schedule();
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule() {
    this.frame ||= requestAnimationFrame(this.render);
  }

  private render = () => {
    this.frame = 0;
    const size = LASER_SCREEN_SIZE * this.getScale();
    const outlines = new Map(
      this.trails.map((trail) => [trail, trail.getStrokeOutline(size)]),
    );
    this.trails = this.trails.filter(
      (trail) => trail === this.current || outlines.get(trail)!.length > 0,
    );
    this.getPath()?.setAttribute(
      "d",
      this.trails
        .map((trail) => getSvgPathFromStroke(outlines.get(trail)!, true))
        .join(" "),
    );
    if (this.trails.length) {
      this.schedule();
    }
  };
}

const useLaserTrails = () => {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const trailsRef = useRef<LaserTrails | null>(null);
  trailsRef.current ??= new LaserTrails(
    () => pathRef.current,
    () => toSlidePoint(svgRef.current, { clientX: 0, clientY: 0 }).scale,
  );
  useEffect(() => () => trailsRef.current?.stop(), []);
  return { svgRef, pathRef, trails: trailsRef.current };
};

/** The presenter's laser pointer. */
export const LaserLayer = ({
  slide,
  active,
  onPoint,
}: {
  slide: Slide;
  active: boolean;
  /** each trail point (slide coordinates), `null` when lifted */
  onPoint?: (point: SlidePoint | null) => void;
}) => {
  const { svgRef, pathRef, trails } = useLaserTrails();
  const pointerIdRef = useRef<number | null>(null);

  const end = () => {
    pointerIdRef.current = null;
    trails.end();
    onPoint?.(null);
  };

  return (
    <SlideSvg
      slide={slide}
      svgRef={svgRef}
      className={`presentation-mode__laser${
        active ? " presentation-mode__laser--active" : ""
      }`}
      onPointerDown={(event) => {
        if (!active || event.button > 0 || pointerIdRef.current !== null) {
          return;
        }
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        pointerIdRef.current = event.pointerId;
        const { x, y } = toSlidePoint(svgRef.current, event);
        trails.add([x, y]);
        onPoint?.([x, y]);
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerIdRef.current) {
          return;
        }
        event.stopPropagation();
        const { x, y } = toSlidePoint(svgRef.current, event);
        trails.add([x, y]);
        onPoint?.([x, y]);
      }}
      onPointerUp={(event) => {
        if (event.pointerId === pointerIdRef.current) {
          event.stopPropagation();
          end();
        }
      }}
      onPointerCancel={(event) => {
        if (event.pointerId === pointerIdRef.current) {
          end();
        }
      }}
    >
      <path ref={pathRef} fill={INK_COLOR} />
    </SlideSvg>
  );
};

/** The laser pointer of the presenter being followed. */
export const RemoteLaserLayer = ({
  slide,
  sessionId,
}: {
  slide: Slide;
  sessionId: string;
}) => {
  const { svgRef, pathRef, trails } = useLaserTrails();

  useEffect(
    () =>
      onPresentationMessage((message) => {
        if (message.kind === "laser" && message.sessionId === sessionId) {
          if (message.point) {
            trails.add(message.point);
          } else {
            trails.end();
          }
        }
      }),
    [sessionId, trails],
  );

  return (
    <SlideSvg
      slide={slide}
      svgRef={svgRef}
      className="presentation-mode__laser"
    >
      <path ref={pathRef} fill={INK_COLOR} />
    </SlideSvg>
  );
};
