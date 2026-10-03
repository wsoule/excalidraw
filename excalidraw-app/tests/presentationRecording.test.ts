import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  PresentationRecorder,
  RecordingPlayback,
  formatDuration,
  getInkAt,
  parseRecordingFile,
} from "../presentation/presentationRecording";
import { addInkPoint, startInkStroke } from "../presentation/inkStrokes";
import { createChirpSamples } from "../presentation/syncChirp";

import type { InkStroke } from "../presentation/inkStrokes";
import type { PresentationState } from "../presentation/presentationSync";

const START_EPOCH = 1_000_000;

const state = (
  overrides: Partial<PresentationState> = {},
): PresentationState => ({
  sessionId: "session",
  slideId: "slide-1",
  slideNumber: 1,
  slideCount: 2,
  play: true,
  token: 0,
  finished: false,
  replay: true,
  strokes: [],
  ...overrides,
});

/** a stroke drawn from `start` (epoch ms) over 300ms */
const stroke = (start: number): InkStroke => {
  let ink = startInkStroke({
    x: 0,
    y: 0,
    pressure: 0.5,
    strokeWidth: 2,
    now: start,
  });
  ink = addInkPoint(ink, { x: 10, y: 0, pressure: 0.5 }, start + 100);
  ink = addInkPoint(ink, { x: 20, y: 0, pressure: 0.5 }, start + 200);
  ink = addInkPoint(ink, { x: 30, y: 0, pressure: 0.5 }, start + 300);
  return ink;
};

const record = (
  build: (recorder: PresentationRecorder) => void,
  duration: number,
) => {
  const recorder = new PresentationRecorder(0, START_EPOCH, {
    elements: [API.createElement({ type: "frame", id: "slide-1" })],
    files: {},
    viewBackgroundColor: "#fff",
    theme: "light",
  });
  build(recorder);
  return recorder.finish("recording", duration);
};

describe("sync chirp", () => {
  it("is the same sound at any sample rate it's rendered at", () => {
    const at48k = createChirpSamples(48_000);
    const at44k = createChirpSamples(44_100);
    expect(at48k.length).toBe(14_400); // 0.3s
    expect(at44k.length).toBe(13_230);
    // fades in and out (no clicks), never clips
    expect(at48k[0]).toBe(0);
    expect(Math.abs(at48k[at48k.length - 1])).toBeLessThan(0.01);
    expect(Math.max(...at48k.map(Math.abs))).toBeLessThan(0.81);
    // deterministic: the exported video's chirp matches the live one
    expect(createChirpSamples(48_000)).toEqual(at48k);
  });
});

describe("recording playback", () => {
  it("shows each state from when it happened, with replay time per visit", () => {
    const recording = record((recorder) => {
      recorder.state(state(), 0);
      recorder.state(state({ finished: true }), 1_500);
      recorder.state(
        state({ slideId: "slide-2", slideNumber: 2, token: 1 }),
        4_000,
      );
    }, 10_000);
    const playback = new RecordingPlayback(recording);

    expect(playback.getFrame(500)).toMatchObject({
      state: { slideId: "slide-1" },
      replayTime: 500,
    });
    // the presenter skipped the replay at 1.5s
    expect(playback.getFrame(2_000)!.replayTime).toBe(Infinity);
    expect(playback.getFrame(4_250)).toMatchObject({
      state: { slideId: "slide-2" },
      replayTime: 250,
    });
    expect(playback.duration).toBe(10_000);
  });

  it("draws ink in as it was drawn, before it shows up finished", () => {
    // drawn 1s..1.3s in, reported finished at 1.35s
    const ink = stroke(START_EPOCH + 1_000);
    const recording = record((recorder) => {
      recorder.state(state(), 0);
      recorder.state(state({ strokes: [ink] }), 1_350);
    }, 3_000);
    const playback = new RecordingPlayback(recording);

    expect(playback.getFrame(900)!.strokes).toEqual([]);
    const partial = playback.getFrame(1_150)!.strokes;
    expect(partial).toHaveLength(1);
    expect(partial[0].points).toEqual([
      [0, 0],
      [10, 0],
      [15, 0],
    ]);
    expect(playback.getFrame(1_320)!.strokes[0].points).toHaveLength(4);
    expect(playback.getFrame(2_000)!.strokes).toEqual([ink.element]);
  });

  it("keeps laser trails visible while held and for the fade after", () => {
    const recording = record((recorder) => {
      recorder.state(state(), 0);
      recorder.laser([10, 10], 1_000);
      recorder.laser([20, 10], 1_100);
      recorder.laser(null, 1_200);
    }, 5_000);
    const playback = new RecordingPlayback(recording);

    expect(playback.getFrame(900)!.laserTrails).toHaveLength(0);
    expect(playback.getFrame(1_150)!.laserTrails).toEqual([
      {
        points: [
          [10, 10, 1_000],
          [20, 10, 1_100],
        ],
        end: 1_200,
      },
    ]);
    expect(playback.getFrame(2_050)!.laserTrails).toHaveLength(1);
    expect(playback.getFrame(2_200)!.laserTrails).toHaveLength(0);
  });

  it("ignores repeats of the same state object", () => {
    const shown = state();
    const recording = record((recorder) => {
      recorder.state(shown, 0);
      recorder.state(shown, 100);
    }, 200);
    expect(recording.events).toHaveLength(1);
  });
});

describe("recording files", () => {
  it("round-trips through JSON and rejects other files", () => {
    const recording = record((recorder) => recorder.state(state(), 0), 1_000);
    expect(parseRecordingFile(JSON.stringify(recording))).toEqual(recording);
    expect(() => parseRecordingFile('{"type":"excalidraw"}')).toThrow(
      "Not a presentation recording",
    );
  });

  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(83_999)).toBe("1:23");
  });

  it("returns the finished stroke once its time has passed", () => {
    const ink = stroke(0);
    expect(getInkAt(ink, 1_000)).toBe(ink.element);
  });
});
