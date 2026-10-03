import type { InkStroke } from "./inkStrokes";

/**
 * Presenting to the people in a live-collaboration room: the presenter
 * broadcasts what they're showing (over the room's end-to-end encrypted
 * socket), and everyone else renders the same slides from their own copy of
 * the scene.
 */

export type PresentationState = {
  /** a presentation session (changes when presenting starts again) */
  sessionId: string;
  slideId: string;
  slideNumber: number;
  slideCount: number;
  /** replay the drawing on this visit of the slide */
  play: boolean;
  /** changes whenever the slide is (re)entered or replayed */
  token: number;
  /** the presenter finished this visit's replay early */
  finished: boolean;
  /** replay is on (for the presenter, and for the slide) */
  replay: boolean;
  /** finished ink on this slide */
  strokes: readonly InkStroke[];
};

/** a point in slide coordinates (frame-local) */
export type SlidePoint = readonly [number, number];

export type PresentationMessage =
  | { kind: "state"; state: PresentationState }
  /** ink being drawn */
  | { kind: "draft"; sessionId: string; stroke: InkStroke | null }
  | {
      kind: "laser";
      sessionId: string;
      /** a trail's next point, or `null` when the pointer is lifted */
      point: SlidePoint | null;
    }
  | { kind: "end"; sessionId: string };

export type RemotePresentationMessage = PresentationMessage & {
  socketId: string;
  username: string;
};

type Sender = (message: PresentationMessage, volatile: boolean) => void;
type Listener = (message: RemotePresentationMessage) => void;

let sender: Sender | null = null;
const listeners = new Set<Listener>();

/** set by the collaboration session while connected */
export const setPresentationSender = (nextSender: Sender | null) => {
  sender = nextSender;
};

export const canBroadcastPresentation = () => !!sender;

/**
 * @param volatile may be dropped (frequent updates that the next one
 *   supersedes)
 */
export const broadcastPresentation = (
  message: PresentationMessage,
  volatile = false,
) => {
  sender?.(message, volatile);
};

export const receivePresentationMessage = (
  message: RemotePresentationMessage,
) => {
  listeners.forEach((listener) => listener(message));
};

export const onPresentationMessage = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** the presenter repeats the state at least this often (for late joiners) */
export const PRESENTATION_HEARTBEAT = 2_000;
/** stop following when the presenter has been silent for this long */
export const PRESENTATION_TIMEOUT = 8_000;
