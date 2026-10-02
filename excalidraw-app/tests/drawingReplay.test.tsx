import {
  createRedoAction,
  createUndoAction,
} from "@excalidraw/excalidraw/actions/actionHistory";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard, Pointer, UI } from "@excalidraw/excalidraw/tests/helpers/ui";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import { pointFrom } from "@excalidraw/math";
import { vi } from "vitest";

import type { LocalPoint } from "@excalidraw/math";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import ExcalidrawApp from "../App";
import {
  DrawingRecorder,
  REPLAY_MAX_GAP,
  REPLAY_START_DELAY,
  REPLAY_UNTIMED_GAP,
  buildReplayTimeline,
  getDrawingTiming,
  getPartialFreedraw,
  getStrokePosition,
} from "../presentation/drawingTiming";
import { SlideReplay, renderSlideForReplay } from "../presentation/slideReplay";

import type { DrawingTiming } from "../presentation/drawingTiming";

const { h } = window;

const withTiming = <T extends ExcalidrawElement>(
  element: T,
  timing: DrawingTiming,
): T => ({ ...element, customData: { drawing: timing } });

const freedraw = (
  points: [number, number][],
  opts: Partial<ExcalidrawFreeDrawElement> = {},
) =>
  ({
    ...API.createElement({ type: "freedraw", x: 0, y: 0 }),
    points: points.map(([x, y]) => pointFrom<LocalPoint>(x, y)),
    pressures: [],
    simulatePressure: true,
    ...opts,
  } as ExcalidrawFreeDrawElement);

describe("getDrawingTiming", () => {
  it("ignores missing or malformed timing", () => {
    const rect = API.createElement({ type: "rectangle" });
    expect(getDrawingTiming(rect)).toBe(null);
    expect(
      getDrawingTiming({ ...rect, customData: { drawing: { t: "x", d: 1 } } }),
    ).toBe(null);
    expect(
      getDrawingTiming({ ...rect, customData: { drawing: { t: 1, d: -5 } } }),
    ).toBe(null);
    expect(
      getDrawingTiming(withTiming(rect, { t: 10, d: 20, p: [0, 20] })),
    ).toEqual({ t: 10, d: 20, p: [0, 20] });
  });
});

describe("DrawingRecorder", () => {
  it("records when each freedraw point was drawn", () => {
    const recorder = new DrawingRecorder();
    let stroke = freedraw([[0, 0]]);
    const get = () => stroke;

    expect(recorder.update([stroke], get, 1000).size).toBe(0);
    stroke = freedraw(
      [
        [0, 0],
        [5, 0],
        [10, 0],
      ],
      { id: stroke.id },
    );
    expect(recorder.update([stroke], get, 1100).size).toBe(0);
    // the last point is added on pointer up, together with finishing
    stroke = freedraw(
      [
        [0, 0],
        [5, 0],
        [10, 0],
        [15, 0],
      ],
      { id: stroke.id },
    );
    const finished = recorder.update([null], get, 1250);

    expect(finished.get(stroke.id)).toEqual({
      t: 1000,
      d: 250,
      p: [0, 100, 100, 250],
    });
  });

  it("doesn't record frames, already recorded elements or re-edited text", () => {
    const recorder = new DrawingRecorder();
    const frame = API.createElement({ type: "frame" });
    const recorded = withTiming(API.createElement({ type: "rectangle" }), {
      t: 1,
      d: 1,
    });
    const text = API.createElement({ type: "text", text: "existing" });
    const elements = new Map(
      [frame, recorded, text].map((element) => [element.id, element]),
    );

    recorder.update([frame, recorded, text], (id) => elements.get(id), 0);
    expect(recorder.update([], (id) => elements.get(id), 100).size).toBe(0);
  });

  it("drops elements that were deleted or left empty", () => {
    const recorder = new DrawingRecorder();
    const rect = API.createElement({ type: "rectangle" });
    const text = API.createElement({ type: "text", text: "" });

    recorder.update([rect, text], () => undefined, 0);
    expect(recorder.update([], () => undefined, 100).size).toBe(0);

    recorder.update([text], () => text, 200);
    expect(recorder.update([], () => text, 300).size).toBe(0);
  });
});

describe("buildReplayTimeline", () => {
  it("plays untimed elements first, then recorded ones in drawing order with shortened pauses", () => {
    const old = API.createElement({ type: "rectangle", id: "old" });
    const second = withTiming(API.createElement({ type: "ellipse", id: "2" }), {
      t: 10_000,
      d: 1000,
    });
    const first = withTiming(API.createElement({ type: "arrow", id: "1" }), {
      t: 5_000,
      d: 400,
    });
    const third = withTiming(API.createElement({ type: "text", id: "3" }), {
      t: 11_100,
      d: 5_000,
    });
    const frame = API.createElement({ type: "frame", id: "frame" });

    const timeline = buildReplayTimeline([frame, second, old, first, third]);

    expect(
      timeline.map(({ element, kind, start, duration }) => [
        element.id,
        kind,
        start,
        duration,
      ]),
    ).toEqual([
      ["old", "trace", REPLAY_START_DELAY, 500],
      ["1", "trace", REPLAY_START_DELAY + 500 + REPLAY_UNTIMED_GAP, 400],
      [
        "2",
        "trace",
        // 4.6s pause shortened
        REPLAY_START_DELAY + 500 + REPLAY_UNTIMED_GAP + 400 + REPLAY_MAX_GAP,
        1000,
      ],
      [
        "3",
        "fade",
        // 100ms pause kept; typing time capped for the fade
        REPLAY_START_DELAY +
          500 +
          REPLAY_UNTIMED_GAP +
          400 +
          REPLAY_MAX_GAP +
          1000 +
          100,
        500,
      ],
    ]);
  });
});

describe("partial strokes", () => {
  const stroke = freedraw([
    [0, 0],
    [10, 0],
    [20, 0],
    [30, 0],
  ]);

  it("follows recorded point times", () => {
    // fast first segment, slow last one
    const timing = { t: 0, d: 1000, p: [0, 100, 200, 1000] };
    expect(getStrokePosition(stroke, timing, 0)).toBe(0);
    expect(getStrokePosition(stroke, timing, 0.15)).toBeCloseTo(1.5);
    expect(getStrokePosition(stroke, timing, 0.6)).toBeCloseTo(2.5);
    expect(getStrokePosition(stroke, timing, 1)).toBe(3);
  });

  it("falls back to an even speed when point times don't match the points", () => {
    const timing = { t: 0, d: 1000, p: [0, 100] };
    expect(getStrokePosition(stroke, timing, 0.5)).toBeCloseTo(1.5);
    expect(getStrokePosition(stroke, null, 0.5)).toBeCloseTo(1.5);
  });

  it("cuts the stroke at a fractional point", () => {
    expect(getPartialFreedraw(stroke, 1.5).points).toEqual([
      [0, 0],
      [10, 0],
      [15, 0],
    ]);
    expect(getPartialFreedraw(stroke, 3)).toBe(stroke);
  });
});

describe("recording in the editor", () => {
  let now = 1_000_000;

  beforeEach(async () => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await render(<ExcalidrawApp />);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores how a stroke was drawn, without an extra undo step", async () => {
    const mouse = new Pointer("mouse");
    UI.clickTool("freedraw");

    now = 1_000_000;
    mouse.downAt(100, 100);
    now += 100;
    mouse.moveTo(110, 100);
    now += 200;
    mouse.moveTo(130, 100);
    now += 300;
    mouse.upAt(160, 100);

    const stroke = () => h.elements[0] as ExcalidrawFreeDrawElement;
    await waitFor(() => expect(getDrawingTiming(stroke())).not.toBe(null));

    const timing = getDrawingTiming(stroke())!;
    expect(timing.t).toBe(1_000_000);
    expect(timing.d).toBe(600);
    expect(timing.p).toHaveLength(stroke().points.length);
    expect(timing.p![0]).toBe(0);
    expect(timing.p![timing.p!.length - 1]).toBe(600);

    // one undo removes the stroke; redo brings it back with its timing
    const undo = createUndoAction(h.history);
    const redo = createRedoAction(h.history);
    act(() => h.app.actionManager.executeAction(undo));
    expect(stroke().isDeleted).toBe(true);
    act(() => h.app.actionManager.executeAction(redo));
    expect(stroke().isDeleted).toBe(false);
    expect(getDrawingTiming(stroke())).toEqual(timing);
  });

  it("records typed text", async () => {
    UI.clickTool("text");
    const mouse = new Pointer("mouse");
    now = 2_000_000;
    mouse.clickAt(200, 200);

    const editor = await waitFor(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".excalidraw-textEditorContainer > textarea",
      );
      expect(textarea).not.toBe(null);
      return textarea!;
    });
    now += 1500;
    fireEvent.change(editor, { target: { value: "hello" } });
    Keyboard.exitTextEditor(editor);

    await waitFor(() =>
      expect(getDrawingTiming(h.elements[0])).toEqual({
        t: 2_000_000,
        d: 1500,
      }),
    );
  });
});

describe("SlideReplay", () => {
  it("hides elements until their turn and grows strokes point by point", async () => {
    const frame = API.createElement({
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
    const rect = API.createElement({
      type: "rectangle",
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      frameId: frame.id,
    });
    const stroke = withTiming(
      freedraw(
        [
          [0, 0],
          [20, 0],
          [40, 0],
          [60, 0],
        ],
        { x: 20, y: 100, frameId: frame.id },
      ),
      { t: 0, d: 600, p: [0, 200, 400, 600] },
    );

    const elements = [frame, rect, stroke] as NonDeletedExcalidrawElement[];
    const input = {
      elements,
      files: {},
      appState: { viewBackgroundColor: "#ffffff", theme: "light" as const },
    };
    const svg = await renderSlideForReplay(frame, input);
    document.body.appendChild(svg);

    const replay = new SlideReplay(svg, buildReplayTimeline(elements));
    const node = (id: string) =>
      svg.querySelector<SVGElement>(`[data-id="${id}"]`)!;
    const strokePath = () =>
      node(stroke.id).querySelector("path:last-of-type")!;
    const finalD = strokePath().getAttribute("d");

    // untimed rectangle first, then the stroke
    const strokeStart = REPLAY_START_DELAY + 500 + REPLAY_UNTIMED_GAP;
    expect(replay.duration).toBe(strokeStart + 600);

    replay.seek(0);
    expect(node(rect.id).style.visibility).toBe("hidden");
    expect(node(stroke.id).style.visibility).toBe("hidden");

    replay.seek(strokeStart + 300);
    expect(node(rect.id).style.visibility).toBe("");
    expect(node(stroke.id).style.visibility).toBe("");
    const partialD = strokePath().getAttribute("d")!;
    expect(partialD).not.toBe(finalD);
    expect(partialD.length).toBeLessThan(finalD!.length);

    replay.seek(Infinity);
    expect(strokePath().getAttribute("d")).toBe(finalD);

    svg.remove();
  });
});
