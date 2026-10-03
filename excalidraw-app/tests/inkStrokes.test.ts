import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { vi } from "vitest";

import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  buildReplayTimeline,
  getDrawingTiming,
} from "../presentation/drawingTiming";
import {
  addInkPoint,
  inkStrokeToElement,
  insertIntoFrame,
  keepInk,
  startInkStroke,
} from "../presentation/inkStrokes";

import type { Slide } from "../presentation/slides";

const frame = API.createElement({
  type: "frame",
  id: "frame",
  x: 100,
  y: 100,
  width: 400,
  height: 300,
}) as Slide;

const drawStroke = (pressure = 0.5) => {
  let stroke = startInkStroke({
    x: 150,
    y: 150,
    pressure,
    strokeWidth: 2,
    now: 1000,
  });
  stroke = addInkPoint(stroke, { x: 160, y: 150, pressure }, 1100);
  // same position: ignored
  stroke = addInkPoint(stroke, { x: 160, y: 150, pressure }, 1150);
  stroke = addInkPoint(stroke, { x: 180, y: 170, pressure }, 1300);
  return stroke;
};

describe("ink strokes", () => {
  it("records points relative to the stroke start, with their times", () => {
    const stroke = drawStroke();
    expect(stroke.element.x).toBe(150);
    expect(stroke.element.points).toEqual([
      [0, 0],
      [10, 0],
      [30, 20],
    ]);
    expect(stroke.pointTimes).toEqual([0, 100, 300]);
    // mouse: simulated pressure, like the editor
    expect(stroke.element.simulatePressure).toBe(true);
    expect(stroke.element.pressures).toEqual([]);
  });

  it("keeps real pen pressure", () => {
    const stroke = drawStroke(0.8);
    expect(stroke.element.simulatePressure).toBe(false);
    expect(stroke.element.pressures).toEqual([0.8, 0.8, 0.8]);
  });

  it("becomes a recorded element in the slide's frame", () => {
    const stroke = drawStroke();
    const element = inkStrokeToElement(stroke, frame);

    expect(element.frameId).toBe("frame");
    expect(element.version).toBeGreaterThan(stroke.element.version);
    expect(getDrawingTiming(element)).toEqual({
      t: 1000,
      d: 300,
      p: [0, 100, 300],
    });
    // replays like anything drawn in the editor
    expect(buildReplayTimeline([element])[0]).toMatchObject({
      kind: "stroke",
      duration: 300,
    });
  });

  it("turns a dot into a valid stroke", () => {
    const dot = startInkStroke({
      x: 0,
      y: 0,
      pressure: 0.7,
      strokeWidth: 2,
      now: 0,
    });
    const element = inkStrokeToElement(dot, frame);
    expect(element.points).toHaveLength(2);
    expect(element.pressures).toHaveLength(2);
    expect(getDrawingTiming(element)!.p).toHaveLength(2);
  });
});

describe("insertIntoFrame", () => {
  const ids = (elements: readonly ExcalidrawElement[]) =>
    elements.map((element) => element.id);

  it("puts new elements right below their frame", () => {
    const before = API.createElement({ type: "rectangle", id: "before" });
    const after = API.createElement({ type: "rectangle", id: "after" });
    const ink = API.createElement({ type: "freedraw", id: "ink" });

    expect(
      ids(insertIntoFrame([before, frame, after], [ink], "frame")),
    ).toEqual(["before", "ink", "frame", "after"]);
  });

  it("appends outside any frame if the frame is gone", () => {
    const ink = {
      ...API.createElement({ type: "freedraw", id: "ink" }),
      frameId: "frame",
    };
    const result = insertIntoFrame([], [ink], "frame");
    expect(ids(result)).toEqual(["ink"]);
    expect(result[0].frameId).toBe(null);
  });
});

describe("keepInk", () => {
  it("saves only ink that wasn't kept yet, in one undoable update", () => {
    let elements: readonly ExcalidrawElement[] = [frame];
    const updateScene = vi.fn(
      (scene: { elements: readonly ExcalidrawElement[] }) => {
        elements = scene.elements;
      },
    );
    const api = {
      getSceneElementsIncludingDeleted: () => elements,
      updateScene,
    } as unknown as ExcalidrawImperativeAPI;

    const kept = { ...drawStroke(), kept: true };
    const fresh = drawStroke();
    keepInk(api, frame, [kept, fresh]);

    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ captureUpdate: "IMMEDIATELY" }),
    );
    expect(elements.map((element) => element.id)).toEqual([
      fresh.element.id,
      "frame",
    ]);
    expect((elements[0] as ExcalidrawFreeDrawElement).frameId).toBe("frame");

    keepInk(api, frame, [kept]);
    expect(updateScene).toHaveBeenCalledTimes(1);
  });
});
