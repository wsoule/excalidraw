import { arrayToMap } from "@excalidraw/common";
import { exportToSvg } from "@excalidraw/excalidraw";
import {
  getElementsOverlappingFrame,
  getFreeDrawSvgPath,
} from "@excalidraw/element";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import {
  buildReplayTimeline,
  getPartialFreedraw,
  getStrokePosition,
  getTimelineDuration,
} from "./drawingTiming";
import { getExportAppState } from "./slides";

import type { TimelineEntry } from "./drawingTiming";
import type { Slide, SlideRenderInput } from "./slides";

/**
 * Renders a slide as an inline SVG whose element nodes are tagged with their
 * ids, so they can be animated individually.
 */
export const renderSlideForReplay = async (
  slide: Slide,
  input: SlideRenderInput,
): Promise<SVGSVGElement> => {
  const svg = await exportToSvg({
    elements: input.elements,
    appState: getExportAppState(input),
    files: input.files,
    exportingFrame: slide,
    exportPadding: 0,
    markElementIds: true,
  });
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  return svg;
};

export const getSlideReplayTimeline = (slide: Slide, input: SlideRenderInput) =>
  buildReplayTimeline(
    getElementsOverlappingFrame(
      input.elements,
      slide,
      arrayToMap(input.elements),
    ),
  );

type TracedPath = { path: SVGGeometryElement; length: number };

type AnimatedEntry = TimelineEntry & {
  /** the element's root nodes (usually one) */
  nodes: SVGElement[];
  /** "trace": outline paths drawn on */
  traced: TracedPath[];
  /** "trace"/"stroke": paths faded in instead (fills) */
  faded: SVGElement[];
  /** "stroke": the stroke path, and its final shape */
  strokePath: SVGPathElement | null;
  strokeD: string | null;
  /** last applied progress (to skip redundant DOM updates) */
  applied: number | null;
};

const ROOT_NODE_EXCLUDED_TAGS = new Set(["clipPath", "mask", "symbol"]);

const isStroked = (node: Element) => {
  const stroke = node.getAttribute("stroke");
  return !!stroke && stroke !== "none";
};

/**
 * Plays a slide's timeline on its SVG (rendered by `renderSlideForReplay`
 * and attached to the document, so path lengths can be measured).
 */
export class SlideReplay {
  readonly duration: number;
  private readonly entries: AnimatedEntry[];

  constructor(svg: SVGSVGElement, timeline: readonly TimelineEntry[]) {
    this.entries = [];

    for (const entry of timeline) {
      const nodes = Array.from(
        svg.querySelectorAll<SVGElement>(
          `[data-id="${CSS.escape(entry.element.id)}"]`,
        ),
      ).filter(
        (node) =>
          !ROOT_NODE_EXCLUDED_TAGS.has(node.tagName) && !node.closest("defs"),
      );
      if (!nodes.length) {
        // not rendered (e.g. outside the frame, invisible)
        continue;
      }

      const animated: AnimatedEntry = {
        ...entry,
        nodes,
        traced: [],
        faded: [],
        strokePath: null,
        strokeD: null,
        applied: null,
      };

      const paths = nodes.flatMap((node) =>
        Array.from(node.querySelectorAll<SVGPathElement>("path")),
      );

      if (entry.kind === "stroke" && entry.element.type === "freedraw") {
        // rendered as [background fill paths..., stroke path]
        animated.strokePath = paths.pop() ?? null;
        animated.strokeD = animated.strokePath?.getAttribute("d") ?? null;
        animated.faded = paths;
      } else if (entry.kind === "trace") {
        for (const path of paths) {
          let length = 0;
          try {
            length = path.getTotalLength();
          } catch {}
          // keep the element's own dash pattern; fade those in instead
          if (
            isStroked(path) &&
            !path.getAttribute("stroke-dasharray") &&
            length > 0
          ) {
            animated.traced.push({ path, length });
          } else {
            animated.faded.push(path);
          }
        }
      }

      this.entries.push(animated);
    }

    this.duration = getTimelineDuration(this.entries);
  }

  /** Shows the replay at `time` ms. */
  seek(time: number) {
    for (const entry of this.entries) {
      const progress =
        time <= entry.start
          ? 0
          : time >= entry.start + entry.duration
          ? 1
          : (time - entry.start) / entry.duration;
      if (progress !== entry.applied) {
        this.apply(entry, progress);
        entry.applied = progress;
      }
    }
  }

  private apply(entry: AnimatedEntry, progress: number) {
    const hidden = progress <= 0;
    for (const node of entry.nodes) {
      node.style.visibility = hidden ? "hidden" : "";
      node.style.opacity =
        entry.kind === "fade" && progress < 1 ? `${progress}` : "";
    }
    if (hidden) {
      return;
    }

    for (const { path, length } of entry.traced) {
      if (progress >= 1) {
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
      } else {
        // +1: no dot of the next dash at the end
        path.style.strokeDasharray = `${length} ${length + 1}`;
        path.style.strokeDashoffset = `${length * (1 - progress)}`;
      }
    }

    for (const node of entry.faded) {
      // fills appear once the outline is (almost) complete
      const opacity =
        entry.kind === "stroke"
          ? progress >= 1
            ? 1
            : 0
          : Math.max(0, (progress - 0.6) / 0.4);
      node.style.opacity = opacity >= 1 ? "" : `${opacity}`;
    }

    if (entry.strokePath && entry.strokeD) {
      if (progress >= 1) {
        entry.strokePath.setAttribute("d", entry.strokeD);
      } else {
        const element = entry.element as ExcalidrawFreeDrawElement;
        const position = getStrokePosition(element, entry.timing, progress);
        entry.strokePath.setAttribute(
          "d",
          getFreeDrawSvgPath(getPartialFreedraw(element, position)),
        );
      }
    }
  }
}
