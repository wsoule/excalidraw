import { createStore, del, entries, get, set } from "idb-keyval";

import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
} from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { atom } from "../app-jotai";

import { getPartialFreedraw, getStrokePosition } from "./drawingTiming";

import type { InkStroke } from "./inkStrokes";
import type { PresentationState, SlidePoint } from "./presentationSync";

/**
 * A recorded presentation: what was shown when (slides, replays, ink, laser),
 * replayable at exactly the same pace, e.g. to export it as a video that
 * lines up with a separately recorded camera/voice track.
 *
 * Time 0 is when the sync chirp played.
 */
export type PresentationRecording = {
  version: 1;
  id: string;
  /** epoch ms */
  createdAt: number;
  /** ms */
  duration: number;
  /** epoch ms at time 0 (ink stroke times are epoch based) */
  startEpoch: number;
  /** the scene as presented */
  scene: {
    elements: readonly ExcalidrawElement[];
    files: BinaryFiles;
    viewBackgroundColor: AppState["viewBackgroundColor"];
    theme: AppState["theme"];
  };
  /** in time order */
  events: RecordingEvent[];
};

export type RecordingEvent =
  /** ms since time 0 */
  | { t: number; kind: "state"; state: PresentationState }
  /** a laser trail point (slide coordinates), `null` when lifted */
  | { t: number; kind: "laser"; point: SlidePoint | null };

export type RecordingMeta = Pick<
  PresentationRecording,
  "id" | "createdAt" | "duration"
> & { slideCount: number };

// -----------------------------------------------------------------------------
// recording
// -----------------------------------------------------------------------------

export class PresentationRecorder {
  private readonly events: RecordingEvent[] = [];
  private lastState: PresentationState | null = null;

  constructor(
    /** `performance.now()` time of time 0 */
    private readonly start: number,
    private readonly startEpoch: number,
    private readonly scene: PresentationRecording["scene"],
  ) {}

  private time(now: number) {
    return Math.max(0, Math.round(now - this.start));
  }

  state(state: PresentationState, now = performance.now()) {
    if (state === this.lastState) {
      return;
    }
    this.lastState = state;
    this.events.push({ t: this.time(now), kind: "state", state });
  }

  laser(point: SlidePoint | null, now = performance.now()) {
    this.events.push({ t: this.time(now), kind: "laser", point });
  }

  finish(id: string, now = performance.now()): PresentationRecording {
    return {
      version: 1,
      id,
      createdAt: this.startEpoch,
      duration: this.time(now),
      startEpoch: this.startEpoch,
      scene: this.scene,
      events: this.events,
    };
  }
}

// -----------------------------------------------------------------------------
// playback
// -----------------------------------------------------------------------------

export type LaserTrailRecord = {
  /** x, y (slide coordinates), t (ms) */
  points: [number, number, number][];
  /** when the pointer was lifted (ms), `Infinity` if never */
  end: number;
};

/** What the recording shows at a time. */
export type RecordingFrame = {
  state: PresentationState;
  /** ms into the current visit's replay (`Infinity`: finished) */
  replayTime: number;
  /** ink at this time (strokes being drawn are partial) */
  strokes: ExcalidrawFreeDrawElement[];
  /** laser trails still visible at this time */
  laserTrails: LaserTrailRecord[];
};

export const LASER_FADE_TIME = 1000;

/** Precomputed lookups for evaluating a recording at any time. */
export class RecordingPlayback {
  private readonly states: { t: number; state: PresentationState }[];
  /** when each visit (by token) started, and when its replay was skipped */
  private readonly visits = new Map<
    number,
    { start: number; finished: number }
  >();
  /** each stroke's first appearance in a state (after being drawn) */
  private readonly strokeFirstSeen = new Map<
    string,
    { t: number; stroke: InkStroke; slideId: string; token: number }
  >();
  readonly laserTrails: LaserTrailRecord[] = [];

  constructor(readonly recording: PresentationRecording) {
    this.states = [];
    let trail: LaserTrailRecord | null = null;

    for (const event of recording.events) {
      if (event.kind === "state") {
        const { state } = event;
        this.states.push({ t: event.t, state });
        const visit = this.visits.get(state.token);
        if (!visit) {
          this.visits.set(state.token, {
            start: event.t,
            finished: state.finished ? event.t : Infinity,
          });
        } else if (state.finished && visit.finished === Infinity) {
          visit.finished = event.t;
        }
        for (const stroke of state.strokes) {
          if (!this.strokeFirstSeen.has(stroke.element.id)) {
            this.strokeFirstSeen.set(stroke.element.id, {
              t: event.t,
              stroke,
              slideId: state.slideId,
              token: state.token,
            });
          }
        }
      } else if (event.point) {
        if (!trail) {
          trail = { points: [], end: Infinity };
          this.laserTrails.push(trail);
        }
        trail.points.push([event.point[0], event.point[1], event.t]);
      } else if (trail) {
        trail.end = event.t;
        trail = null;
      }
    }
  }

  get duration() {
    return this.recording.duration;
  }

  /** the state shown at `time` (ms) */
  getState(time: number): PresentationState | null {
    let low = 0;
    let high = this.states.length - 1;
    let found: PresentationState | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.states[mid].t <= time) {
        found = this.states[mid].state;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found ?? this.states[0]?.state ?? null;
  }

  getFrame(time: number): RecordingFrame | null {
    const state = this.getState(time);
    if (!state) {
      return null;
    }

    const visit = this.visits.get(state.token);
    const replayTime =
      !visit || time >= visit.finished
        ? Infinity
        : Math.max(0, time - visit.start);

    // finished ink, then ink still being drawn at this time (it only shows
    // up in a state once finished)
    const epoch = this.recording.startEpoch + time;
    const strokes = state.strokes.map((stroke) => stroke.element);
    for (const [, seen] of this.strokeFirstSeen) {
      if (
        seen.t > time &&
        seen.slideId === state.slideId &&
        seen.token === state.token &&
        seen.stroke.start <= epoch
      ) {
        strokes.push(getInkAt(seen.stroke, epoch));
      }
    }

    const laserTrails = this.laserTrails.filter(
      (trail) =>
        trail.points[0][2] <= time &&
        (trail.end > time ||
          trail.points[trail.points.length - 1][2] > time - LASER_FADE_TIME),
    );

    return { state, replayTime, strokes, laserTrails };
  }
}

/** a stroke as drawn up to `epoch` (ms) */
export const getInkAt = (
  stroke: InkStroke,
  epoch: number,
): ExcalidrawFreeDrawElement => {
  const { element, pointTimes } = stroke;
  const elapsed = epoch - stroke.start;
  const total = pointTimes[pointTimes.length - 1] ?? 0;
  if (elapsed >= total) {
    return element;
  }
  const position = getStrokePosition(
    element,
    { t: stroke.start, d: total, p: pointTimes },
    total > 0 ? elapsed / total : 1,
  );
  return getPartialFreedraw(element, position);
};

// -----------------------------------------------------------------------------
// storage (this browser)
// -----------------------------------------------------------------------------

// separate databases: listing shouldn't load every recording's scene
const metaStore = createStore("excalidraw-presentation-recordings", "meta");
const dataStore = createStore(
  "excalidraw-presentation-recordings-data",
  "recordings",
);

export const getRecordingMeta = (
  recording: PresentationRecording,
): RecordingMeta => ({
  id: recording.id,
  createdAt: recording.createdAt,
  duration: recording.duration,
  slideCount: new Set(
    recording.events.flatMap((event) =>
      event.kind === "state" ? [event.state.slideId] : [],
    ),
  ).size,
});

export const saveRecording = async (recording: PresentationRecording) => {
  await set(recording.id, recording, dataStore);
  await set(recording.id, getRecordingMeta(recording), metaStore);
};

export const loadRecording = (id: string) =>
  get<PresentationRecording>(id, dataStore);

export const deleteRecording = async (id: string) => {
  await del(id, dataStore);
  await del(id, metaStore);
};

export const listRecordings = async (): Promise<RecordingMeta[]> =>
  (await entries<string, RecordingMeta>(metaStore))
    .map(([, meta]) => meta)
    .sort((a, b) => b.createdAt - a.createdAt);

/** for exporting on another device */
export const parseRecordingFile = (text: string): PresentationRecording => {
  const recording = JSON.parse(text);
  if (
    recording?.version !== 1 ||
    typeof recording.id !== "string" ||
    !Array.isArray(recording.events) ||
    !Array.isArray(recording.scene?.elements)
  ) {
    throw new Error("Not a presentation recording");
  }
  return recording;
};

export const RECORDING_FILE_EXTENSION = ".excalidrawrec.json";

/** m:ss */
export const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** bumped when recordings are added or removed (to refresh lists) */
export const recordingsChangedAtom = atom(0);
