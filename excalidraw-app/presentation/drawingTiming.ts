import { isFrameLikeElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
} from "@excalidraw/element/types";

/**
 * How an element was drawn, recorded while drawing and stored on the
 * element's `customData`, so it travels with the scene (saved files, share
 * links, collaboration) and can be replayed when presenting.
 */
export const DRAWING_TIMING_KEY = "drawing";

export type DrawingTiming = {
  /** when drawing started (epoch ms) */
  t: number;
  /** how long drawing took (ms) */
  d: number;
  /**
   * freedraw only: when each point was drawn (ms since `t`), one per point
   */
  p?: number[];
};

/**
 * `customData` flag, stored only when `false`: on a frame, the slide shows
 * finished instead of replaying; on an element, it's already there when the
 * slide appears.
 */
export const REPLAY_ENABLED_KEY = "replayDrawing";

export const isReplayEnabled = (element: ExcalidrawElement) =>
  element.customData?.[REPLAY_ENABLED_KEY] !== false;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const getDrawingTiming = (
  element: ExcalidrawElement,
): DrawingTiming | null => {
  const value = element.customData?.[DRAWING_TIMING_KEY];
  if (
    !value ||
    typeof value !== "object" ||
    !isFiniteNumber(value.t) ||
    !isFiniteNumber(value.d) ||
    value.d < 0
  ) {
    return null;
  }
  const timing: DrawingTiming = { t: value.t, d: value.d };
  if (Array.isArray(value.p) && value.p.every(isFiniteNumber)) {
    timing.p = value.p;
  }
  return timing;
};

/**
 * Per-point times, if they still match the element's points (they don't if
 * the points were edited after drawing).
 */
export const getPointTimes = (
  element: ExcalidrawFreeDrawElement,
  timing: DrawingTiming | null,
): number[] | null => {
  const times = timing?.p;
  if (!times || times.length !== element.points.length || !times.length) {
    return null;
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      return null;
    }
  }
  return times;
};

// -----------------------------------------------------------------------------
// recording
// -----------------------------------------------------------------------------

type ActiveDrawing = {
  start: number;
  /** freedraw: time of each point seen so far */
  pointTimes: number[];
};

/**
 * Tracks elements while they're being drawn (fed from the editor's onChange)
 * and reports their timing once they're done.
 *
 * Only elements drawn in this editor are recorded (a collaborator's elements
 * arrive already finished and carry their own timing).
 */
export class DrawingRecorder {
  private active = new Map<string, ActiveDrawing>();

  /**
   * @param activeElements elements currently being drawn or typed
   *   (`appState.newElement`, `multiElement`, `editingTextElement`)
   * @returns timings of the elements that were finished since the last call
   */
  update(
    activeElements: readonly (ExcalidrawElement | null | undefined)[],
    getElement: (id: string) => ExcalidrawElement | undefined,
    now: number,
  ): Map<string, DrawingTiming> {
    const activeIds = new Set<string>();

    for (const element of activeElements) {
      if (!element || activeIds.has(element.id)) {
        continue;
      }
      activeIds.add(element.id);

      let drawing = this.active.get(element.id);
      if (!drawing) {
        if (
          isFrameLikeElement(element) ||
          getDrawingTiming(element) ||
          // re-editing an existing text isn't drawing it
          (element.type === "text" && element.text !== "")
        ) {
          continue;
        }
        drawing = { start: now, pointTimes: [] };
        this.active.set(element.id, drawing);
      }

      if (element.type === "freedraw") {
        const { pointTimes } = drawing;
        while (pointTimes.length < element.points.length) {
          pointTimes.push(now - drawing.start);
        }
      }
    }

    const finished = new Map<string, DrawingTiming>();

    for (const [id, drawing] of this.active) {
      if (activeIds.has(id)) {
        continue;
      }
      this.active.delete(id);

      const element = getElement(id);
      if (!element || element.isDeleted) {
        continue;
      }
      if (element.type === "text" && !element.text.trim()) {
        continue;
      }

      const timing: DrawingTiming = {
        t: drawing.start,
        d: now - drawing.start,
      };
      if (element.type === "freedraw") {
        const pointTimes = drawing.pointTimes.slice(0, element.points.length);
        // the last point is added on pointer up
        while (pointTimes.length < element.points.length) {
          pointTimes.push(timing.d);
        }
        timing.p = pointTimes;
      }
      finished.set(id, timing);
    }

    return finished;
  }
}

// -----------------------------------------------------------------------------
// playback timeline
// -----------------------------------------------------------------------------

export type ReplayKind =
  /** freedraw: the stroke grows point by point */
  | "stroke"
  /** shapes, lines, arrows: the outline is traced */
  | "trace"
  /** text, images, ...: fades in */
  | "fade";

export type TimelineEntry = {
  element: ExcalidrawElement;
  kind: ReplayKind;
  /** ms since the start of the replay */
  start: number;
  /** playback duration (ms) */
  duration: number;
  timing: DrawingTiming | null;
};

/** pause before the first element */
export const REPLAY_START_DELAY = 300;
/** longest pause kept between two recorded elements */
export const REPLAY_MAX_GAP = 500;
/** pause between elements drawn before recording existed */
export const REPLAY_UNTIMED_GAP = 120;

const DURATION_LIMITS: Record<
  ReplayKind,
  { min: number; max: number; untimed: number }
> = {
  stroke: { min: 120, max: 20_000, untimed: 600 },
  trace: { min: 400, max: 2_500, untimed: 500 },
  fade: { min: 200, max: 500, untimed: 300 },
};

export const getReplayKind = (element: ExcalidrawElement): ReplayKind => {
  switch (element.type) {
    case "freedraw":
      return "stroke";
    case "rectangle":
    case "diamond":
    case "ellipse":
    case "line":
    case "arrow":
      return "trace";
    default:
      return "fade";
  }
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/**
 * Replay order and timing of a slide's elements.
 *
 * Elements drawn with recording on replay in the order (and at the speed) they
 * were drawn, with long pauses shortened. Older elements have no timing; they
 * replay first, in z-order, at an even pace. Elements with replay turned off
 * aren't in the timeline (they're there from the start).
 */
export const buildReplayTimeline = (
  /** in z-order */
  elements: readonly ExcalidrawElement[],
): TimelineEntry[] => {
  const untimed: ExcalidrawElement[] = [];
  const timed: { element: ExcalidrawElement; timing: DrawingTiming }[] = [];

  for (const element of elements) {
    if (
      element.isDeleted ||
      isFrameLikeElement(element) ||
      // not in the timeline: never hidden
      !isReplayEnabled(element)
    ) {
      continue;
    }
    const timing = getDrawingTiming(element);
    if (timing) {
      timed.push({ element, timing });
    } else {
      untimed.push(element);
    }
  }
  // stable: ties keep z-order (e.g. duplicates share the original's timing)
  timed.sort((a, b) => a.timing.t - b.timing.t);

  const entries: TimelineEntry[] = [];
  let cursor = REPLAY_START_DELAY;

  for (const element of untimed) {
    const kind = getReplayKind(element);
    const duration = DURATION_LIMITS[kind].untimed;
    entries.push({ element, kind, start: cursor, duration, timing: null });
    cursor += duration + REPLAY_UNTIMED_GAP;
  }

  let previousEnd: number | null = null;
  for (const { element, timing } of timed) {
    const kind = getReplayKind(element);
    const { min, max } = DURATION_LIMITS[kind];
    const duration = clamp(timing.d, min, max);

    if (previousEnd !== null) {
      cursor += clamp(timing.t - previousEnd, 0, REPLAY_MAX_GAP);
    }
    entries.push({ element, kind, start: cursor, duration, timing });
    cursor += duration;
    previousEnd = timing.t + timing.d;
  }

  return entries;
};

export const getTimelineDuration = (entries: readonly TimelineEntry[]) =>
  entries.reduce(
    (end, entry) => Math.max(end, entry.start + entry.duration),
    0,
  );

// -----------------------------------------------------------------------------
// partial freedraw strokes
// -----------------------------------------------------------------------------

const getCumulativeLengths = (points: ExcalidrawFreeDrawElement["points"]) => {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(
      lengths[i - 1] +
        Math.hypot(
          points[i][0] - points[i - 1][0],
          points[i][1] - points[i - 1][1],
        ),
    );
  }
  return lengths;
};

/** index of the last value <= target in an ascending array (-1 if none) */
const findLastAtOrBelow = (values: readonly number[], target: number) => {
  let low = 0;
  let high = values.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (values[mid] <= target) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
};

/**
 * Position along the stroke at `progress` (0..1 of the playback), as a
 * fractional point index: recorded point times when available, otherwise an
 * even speed along the stroke.
 */
export const getStrokePosition = (
  element: ExcalidrawFreeDrawElement,
  timing: DrawingTiming | null,
  progress: number,
): number => {
  const { points } = element;
  if (points.length < 2) {
    return progress >= 1 ? points.length - 1 : 0;
  }

  const pointTimes = getPointTimes(element, timing);
  const scale = pointTimes ? pointTimes : getCumulativeLengths(element.points);
  const total = scale[scale.length - 1];
  if (total <= 0) {
    return progress >= 1 ? points.length - 1 : 0;
  }

  const target = clamp(progress, 0, 1) * total;
  const index = Math.max(0, findLastAtOrBelow(scale, target));
  if (index >= points.length - 1) {
    return points.length - 1;
  }
  const span = scale[index + 1] - scale[index];
  return index + (span > 0 ? (target - scale[index]) / span : 0);
};

/** The stroke as drawn up to the fractional point `position`. */
export const getPartialFreedraw = (
  element: ExcalidrawFreeDrawElement,
  position: number,
): ExcalidrawFreeDrawElement => {
  const { points, pressures } = element;
  const index = Math.floor(position);
  if (index >= points.length - 1) {
    return element;
  }

  const fraction = position - index;
  const nextPoints = points.slice(0, index + 1);
  const nextPressures = pressures.slice(0, index + 1);

  if (fraction > 0) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    nextPoints.push([
      x1 + (x2 - x1) * fraction,
      y1 + (y2 - y1) * fraction,
    ] as typeof points[number]);
    if (pressures.length > index + 1) {
      nextPressures.push(
        pressures[index] + (pressures[index + 1] - pressures[index]) * fraction,
      );
    }
  }

  return { ...element, points: nextPoints, pressures: nextPressures };
};
