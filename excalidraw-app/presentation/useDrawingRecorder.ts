import {
  CaptureUpdateAction,
  newElementWith,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { useEffect } from "react";

import {
  DRAWING_TIMING_KEY,
  DrawingRecorder,
  getDrawingTiming,
} from "./drawingTiming";

import type { DrawingTiming } from "./drawingTiming";

/**
 * Records how each element is drawn (see `DrawingTiming`) so presentations
 * can replay it.
 */
export const useDrawingRecorder = () => {
  const excalidrawAPI = useExcalidrawAPI();

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const recorder = new DrawingRecorder();
    const pending = new Map<string, DrawingTiming>();
    let flushTimer = 0;

    const flush = () => {
      flushTimer = 0;
      if (!pending.size) {
        return;
      }
      let didChange = false;
      const elements = excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          const timing = pending.get(element.id);
          if (!timing || element.isDeleted || getDrawingTiming(element)) {
            return element;
          }
          didChange = true;
          return newElementWith(element, {
            customData: { ...element.customData, [DRAWING_TIMING_KEY]: timing },
          });
        });
      pending.clear();

      if (didChange) {
        excalidrawAPI.updateScene({
          elements,
          // metadata of the drawing that was just captured, not an action of
          // its own (and undoing/redoing the drawing keeps it)
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    };

    const unsubscribe = excalidrawAPI.onChange((elements, appState) => {
      let elementsMap: Map<string, typeof elements[number]> | null = null;

      const finished = recorder.update(
        [
          appState.newElement,
          appState.multiElement,
          appState.editingTextElement,
        ],
        (id) => {
          elementsMap ??= new Map(
            elements.map((element) => [element.id, element]),
          );
          return elementsMap.get(id);
        },
        Date.now(),
      );

      if (finished.size) {
        finished.forEach((timing, id) => pending.set(id, timing));
        // not from inside the editor's update
        flushTimer ||= window.setTimeout(flush);
      }
    });

    return () => {
      unsubscribe();
      window.clearTimeout(flushTimer);
      flush();
    };
  }, [excalidrawAPI]);
};
