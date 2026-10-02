import {
  CaptureUpdateAction,
  exportToCanvas,
  exportToSvg,
  newElementWith,
} from "@excalidraw/excalidraw";
import { isFrameLikeElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { createImagePdf } from "./pdf";

import type { PdfImagePage } from "./pdf";

/**
 * Slide order is persisted on each frame's `customData`, so it travels with
 * the scene (saved .excalidraw files, share links, collaboration).
 */
const SLIDE_ORDER_KEY = "presentationIndex";

export type Slide = NonDeleted<ExcalidrawFrameLikeElement>;

const getSlideOrder = (frame: ExcalidrawFrameLikeElement): number | null => {
  const value = frame.customData?.[SLIDE_ORDER_KEY];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * Frames in presentation order: frames with an explicit order first, then the
 * rest in scene order (i.e. order of creation, for frames that were never
 * reordered).
 */
export const getSlides = (elements: readonly ExcalidrawElement[]): Slide[] => {
  return elements
    .filter(
      (element): element is Slide =>
        !element.isDeleted && isFrameLikeElement(element),
    )
    .map((frame, sceneIndex) => ({
      frame,
      sceneIndex,
      order: getSlideOrder(frame),
    }))
    .sort((a, b) => {
      if (a.order !== null && b.order !== null && a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.order !== null && b.order === null) {
        return -1;
      }
      if (a.order === null && b.order !== null) {
        return 1;
      }
      return a.sceneIndex - b.sceneIndex;
    })
    .map(({ frame }) => frame);
};

/** Moves a slide to `toIndex` and persists the order of all slides. */
export const moveSlide = (
  api: ExcalidrawImperativeAPI,
  slideId: string,
  toIndex: number,
) => {
  const allElements = api.getSceneElementsIncludingDeleted();
  const slides = getSlides(allElements);
  const fromIndex = slides.findIndex((slide) => slide.id === slideId);
  if (fromIndex === -1) {
    return;
  }
  const clampedToIndex = Math.max(0, Math.min(slides.length - 1, toIndex));
  if (clampedToIndex === fromIndex) {
    return;
  }

  const [moved] = slides.splice(fromIndex, 1);
  slides.splice(clampedToIndex, 0, moved);

  const nextOrder = new Map(slides.map((slide, index) => [slide.id, index]));

  api.updateScene({
    elements: allElements.map((element) => {
      const order = nextOrder.get(element.id);
      if (
        order === undefined ||
        !isFrameLikeElement(element) ||
        getSlideOrder(element) === order
      ) {
        return element;
      }
      return newElementWith(element, {
        customData: { ...element.customData, [SLIDE_ORDER_KEY]: order },
      });
    }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

export type SlideRenderInput = {
  elements: readonly NonDeletedExcalidrawElement[];
  files: BinaryFiles;
  appState: Pick<AppState, "viewBackgroundColor" | "theme">;
};

export const getSlideRenderInput = (
  api: ExcalidrawImperativeAPI,
): SlideRenderInput => {
  const appState = api.getAppState();
  return {
    elements: api.getSceneElements(),
    files: api.getFiles(),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      theme: appState.theme,
    },
  };
};

export const getExportAppState = (input: SlideRenderInput) => ({
  exportBackground: true,
  viewBackgroundColor: input.appState.viewBackgroundColor,
  exportWithDarkMode: input.appState.theme === "dark",
});

/** Renders a slide as SVG (vector, crisp at any screen size). */
export const renderSlideToSvgUrl = async (
  slide: Slide,
  input: SlideRenderInput,
): Promise<string> => {
  const svg = await exportToSvg({
    elements: input.elements,
    appState: getExportAppState(input),
    files: input.files,
    exportingFrame: slide,
    exportPadding: 0,
  });
  // let the <img> scale the slide to fit the screen
  svg.removeAttribute("width");
  svg.removeAttribute("height");

  const blob = new Blob([new XMLSerializer().serializeToString(svg)], {
    type: "image/svg+xml",
  });
  return URL.createObjectURL(blob);
};

/** Longest PDF page side in points (13.33in, the size of a 16:9 slide deck) */
const PDF_PAGE_MAX_SIDE = 960;
/** Keep below mobile Safari's canvas limits. */
const PDF_IMAGE_MAX_SIDE = 4096;
const PDF_IMAGE_MAX_AREA = 4096 * 4096 * 0.9;
const PDF_IMAGE_SCALE = 2;
const PDF_JPEG_QUALITY = 0.92;

const canvasToJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error("Couldn't render slide"));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/jpeg",
      PDF_JPEG_QUALITY,
    );
  });

export const exportSlidesToPdf = async (
  slides: readonly Slide[],
  input: SlideRenderInput,
  opts: {
    title: string;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<Blob> => {
  const pages: PdfImagePage[] = [];

  for (const slide of slides) {
    opts.onProgress?.(pages.length, slides.length);

    const canvas = await exportToCanvas({
      elements: input.elements,
      appState: getExportAppState(input),
      files: input.files,
      exportingFrame: slide,
      getDimensions: (width, height) => {
        const scale = Math.min(
          PDF_IMAGE_SCALE,
          PDF_IMAGE_MAX_SIDE / Math.max(width, height),
          Math.sqrt(PDF_IMAGE_MAX_AREA / (width * height)),
        );
        return {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          scale,
        };
      },
    });

    const jpeg = await canvasToJpeg(canvas);
    const pageScale =
      PDF_PAGE_MAX_SIDE / Math.max(slide.width, slide.height, 1);
    pages.push({
      jpeg,
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      pageWidth: Math.max(1, slide.width * pageScale),
      pageHeight: Math.max(1, slide.height * pageScale),
    });

    // release canvas memory early (matters on iPad)
    canvas.width = 0;
    canvas.height = 0;
  }

  opts.onProgress?.(pages.length, slides.length);

  return createImagePdf(pages, { title: opts.title });
};

export const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // give the browser time to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/** Exports all slides of the current scene and downloads the PDF. */
export const exportPresentationToPdf = async (api: ExcalidrawImperativeAPI) => {
  const input = getSlideRenderInput(api);
  const slides = getSlides(input.elements);

  if (!slides.length) {
    api.setToast({
      message: "Add a frame (F) for each slide before exporting to PDF.",
      closable: true,
    });
    return;
  }

  const title = api.getName() || "Presentation";

  try {
    const blob = await exportSlidesToPdf(slides, input, {
      title,
      onProgress: (done, total) =>
        api.setToast({
          message: `Exporting PDF… ${done}/${total}`,
          duration: Infinity,
        }),
    });
    downloadBlob(blob, `${title}.pdf`);
    api.setToast({
      message: `Exported ${slides.length} slide${
        slides.length === 1 ? "" : "s"
      } to PDF`,
    });
  } catch (error: any) {
    console.error(error);
    api.setToast({
      message: `Couldn't export PDF: ${error?.message || error}`,
      closable: true,
    });
  }
};
