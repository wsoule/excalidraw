import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newElementWith, newFreeDrawElement } from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { DRAWING_TIMING_KEY } from "./drawingTiming";

import type { DrawingTiming } from "./drawingTiming";
import type { Slide } from "./slides";

/** Ink drawn on a slide while presenting, in scene coordinates. */
export type InkStroke = {
  element: ExcalidrawFreeDrawElement;
  /** when drawing started (epoch ms) */
  start: number;
  /** when each point was drawn (ms since `start`) */
  pointTimes: number[];
  /** saved into the drawing */
  kept: boolean;
};

export const INK_COLOR = "#e03131";

export const startInkStroke = (opts: {
  x: number;
  y: number;
  /** `PointerEvent.pressure` (0.5 for mice, which then get simulated) */
  pressure: number;
  strokeWidth: number;
  now: number;
}): InkStroke => {
  // same as the editor's freedraw tool
  const simulatePressure = opts.pressure === 0.5;
  return {
    element: newFreeDrawElement({
      type: "freedraw",
      x: opts.x,
      y: opts.y,
      strokeColor: INK_COLOR,
      strokeWidth: opts.strokeWidth,
      roughness: 0,
      roundness: null,
      simulatePressure,
      points: [pointFrom<LocalPoint>(0, 0)],
      pressures: simulatePressure ? [] : [opts.pressure],
    }),
    start: opts.now,
    pointTimes: [0],
    kept: false,
  };
};

export const addInkPoint = (
  stroke: InkStroke,
  point: { x: number; y: number; pressure: number },
  now: number,
): InkStroke => {
  const { element } = stroke;
  const dx = point.x - element.x;
  const dy = point.y - element.y;
  const last = element.points[element.points.length - 1];
  if (last && last[0] === dx && last[1] === dy) {
    return stroke;
  }
  return {
    ...stroke,
    // not `newElementWith`: no version bumps for every point of a draft
    element: {
      ...element,
      points: [...element.points, pointFrom<LocalPoint>(dx, dy)],
      pressures: element.simulatePressure
        ? element.pressures
        : [...element.pressures, point.pressure],
    },
    pointTimes: [...stroke.pointTimes, now - stroke.start],
  };
};

/** The finished stroke as a scene element in the slide (drawn as recorded). */
export const inkStrokeToElement = (
  stroke: InkStroke,
  slide: Slide,
): ExcalidrawFreeDrawElement => {
  const { element, pointTimes } = stroke;
  // a single point would be "infinitely small" (as in the editor)
  const points =
    element.points.length === 1
      ? [...element.points, pointFrom<LocalPoint>(0.0001, 0.0001)]
      : element.points;
  const pressures =
    !element.simulatePressure && element.pressures.length < points.length
      ? [...element.pressures, element.pressures[element.pressures.length - 1]]
      : element.pressures;
  const times =
    pointTimes.length < points.length
      ? [...pointTimes, pointTimes[pointTimes.length - 1]]
      : pointTimes;

  const timing: DrawingTiming = {
    t: stroke.start,
    d: times[times.length - 1],
    p: times,
  };

  return newElementWith(element, {
    points,
    pressures,
    frameId: slide.id,
    customData: { ...element.customData, [DRAWING_TIMING_KEY]: timing },
  });
};

/**
 * Inserts elements just below their frame (where the editor keeps a frame's
 * children), or at the end if the frame is gone.
 */
export const insertIntoFrame = (
  elements: readonly ExcalidrawElement[],
  newElements: readonly ExcalidrawElement[],
  frameId: string,
): ExcalidrawElement[] => {
  const frameIndex = elements.findIndex(
    (element) => element.id === frameId && !element.isDeleted,
  );
  if (frameIndex === -1) {
    return [
      ...elements,
      ...newElements.map((element) =>
        newElementWith(element, { frameId: null }),
      ),
    ];
  }
  return [
    ...elements.slice(0, frameIndex),
    ...newElements,
    ...elements.slice(frameIndex),
  ];
};

/** Saves a slide's ink into the drawing (undoable). */
export const keepInk = (
  api: ExcalidrawImperativeAPI,
  slide: Slide,
  strokes: readonly InkStroke[],
) => {
  const elements = strokes
    .filter((stroke) => !stroke.kept)
    .map((stroke) => inkStrokeToElement(stroke, slide));
  if (!elements.length) {
    return;
  }
  api.updateScene({
    elements: insertIntoFrame(
      api.getSceneElementsIncludingDeleted(),
      elements,
      slide.id,
    ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};
