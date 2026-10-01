import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createImagePdf } from "../presentation/pdf";
import { getSlides, moveSlide } from "../presentation/slides";

// `API.createElement()` doesn't support `customData`
const withCustomData = <T extends ExcalidrawElement>(
  element: T,
  customData: ExcalidrawElement["customData"],
): T => ({ ...element, customData });

const frame = (id: string, presentationIndex?: number) =>
  withCustomData(
    API.createElement({ type: "frame", id }),
    presentationIndex === undefined ? undefined : { presentationIndex },
  );

const ids = (elements: readonly ExcalidrawElement[]) =>
  elements.map((element) => element.id);

describe("getSlides", () => {
  it("uses scene order for frames without an explicit order", () => {
    const elements = [
      frame("a"),
      API.createElement({ type: "rectangle", id: "rect" }),
      frame("b"),
      frame("c"),
    ];
    expect(ids(getSlides(elements))).toEqual(["a", "b", "c"]);
  });

  it("puts explicitly ordered frames first, then the rest in scene order", () => {
    const elements = [frame("a"), frame("b", 1), frame("c", 0), frame("d")];
    expect(ids(getSlides(elements))).toEqual(["c", "b", "a", "d"]);
  });

  it("skips deleted frames", () => {
    const elements = [
      frame("a"),
      API.createElement({ type: "frame", id: "b", isDeleted: true }),
    ];
    expect(ids(getSlides(elements))).toEqual(["a"]);
  });
});

describe("moveSlide", () => {
  const createAPI = (initial: ExcalidrawElement[]) => {
    let elements: readonly ExcalidrawElement[] = initial;
    const updateScene = vi.fn(
      ({ elements: next }: { elements: readonly ExcalidrawElement[] }) => {
        elements = next;
      },
    );
    const api = {
      getSceneElementsIncludingDeleted: () => elements,
      updateScene,
    } as unknown as ExcalidrawImperativeAPI;
    return { api, updateScene, getElements: () => elements };
  };

  it("reorders slides and persists the order on every frame", () => {
    const rect = API.createElement({ type: "rectangle", id: "rect" });
    const { api, getElements } = createAPI([
      frame("a"),
      rect,
      frame("b"),
      frame("c"),
    ]);

    moveSlide(api, "c", 0);

    expect(ids(getSlides(getElements()))).toEqual(["c", "a", "b"]);
    // scene (z-)order is untouched
    expect(ids(getElements())).toEqual(["a", "rect", "b", "c"]);
    // non-frames are passed through as is
    expect(getElements()[1]).toBe(rect);
    expect(
      getElements()
        .filter((element) => element.type === "frame")
        .map((element) => element.customData?.presentationIndex),
    ).toEqual([1, 2, 0]);
  });

  it("keeps other customData and bumps versions so changes sync", () => {
    const a = withCustomData(API.createElement({ type: "frame", id: "a" }), {
      foo: "bar",
    });
    const { api, getElements } = createAPI([a, frame("b")]);

    moveSlide(api, "a", 1);

    const nextA = getElements()[0];
    expect(nextA.customData).toEqual({ foo: "bar", presentationIndex: 1 });
    expect(nextA.version).toBeGreaterThan(a.version);
  });

  it("keeps the order when saved to and loaded from a .excalidraw file", () => {
    const { api, getElements } = createAPI([frame("a"), frame("b")]);
    moveSlide(api, "b", 0);

    const json = JSON.parse(serializeAsJSON(getElements(), {}, {}, "local"));
    const restored = restoreElements(json.elements, null);

    expect(ids(getSlides(restored))).toEqual(["b", "a"]);
  });

  it("is a no-op when the slide doesn't move", () => {
    const { api, updateScene } = createAPI([frame("a"), frame("b")]);
    moveSlide(api, "a", 0);
    moveSlide(api, "a", -1);
    moveSlide(api, "missing", 1);
    expect(updateScene).not.toHaveBeenCalled();
  });
});

describe("createImagePdf", () => {
  // jsdom's Blob has no `arrayBuffer()`
  const readText = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(new TextDecoder("latin1").decode(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });

  it("writes one page per image with a valid xref table", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const blob = createImagePdf(
      [
        {
          jpeg,
          imageWidth: 4,
          imageHeight: 3,
          pageWidth: 960,
          pageHeight: 720,
        },
        {
          jpeg,
          imageWidth: 1,
          imageHeight: 1,
          pageWidth: 500.5,
          pageHeight: 500.5,
        },
      ],
      { title: "Hi" },
    );
    const text = await readText(blob);

    expect(blob.type).toBe("application/pdf");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text).toContain("/MediaBox [0 0 960 720]");
    expect(text).toContain("/MediaBox [0 0 500.50 500.50]");
    expect(text).toContain("/Title <FEFF00480069>");

    // every xref entry must point at the start of its object
    const xrefStart = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe("xref");
    const entries = text
      .slice(xrefStart)
      .split("\n")
      .filter((line) => / 00000 n $/.test(line));
    expect(entries).toHaveLength(9);
    entries.forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true);
    });
  });

  it("throws without pages", () => {
    expect(() => createImagePdf([])).toThrow();
  });
});
