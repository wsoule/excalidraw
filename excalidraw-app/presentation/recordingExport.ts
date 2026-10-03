import {
  applyDarkModeFilter,
  easeOut,
  getSvgPathFromStroke,
} from "@excalidraw/common";
import { exportToSvg } from "@excalidraw/excalidraw";
import { getFreeDrawSvgPath } from "@excalidraw/element";
import { LaserPointer } from "@excalidraw/laser-pointer";
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { INK_COLOR } from "./inkStrokes";
import { LASER_FADE_TIME, RecordingPlayback } from "./presentationRecording";
import { getSlideReplayTimeline, SlideReplay } from "./slideReplay";
import { getSlides } from "./slides";
import { SYNC_FLASH_DURATION, createChirpSamples } from "./syncChirp";

import type { AudioCodec, VideoCodec } from "mediabunny";

import type {
  LaserTrailRecord,
  PresentationRecording,
  RecordingFrame,
} from "./presentationRecording";
import type { Slide, SlideRenderInput } from "./slides";

export type VideoExportOptions = {
  /** output height (16:9) */
  height: 1080 | 2160;
  fps: 30 | 60;
  /**
   * - slide: the slides' background color
   * - green: green screen (only the drawing is opaque)
   * - transparent: WebM with alpha (only the drawing is opaque)
   */
  background: "slide" | "green" | "transparent";
};

export type ExportedVideo = { blob: Blob; extension: string };

const SVG_NS = "http://www.w3.org/2000/svg";
const GREEN_SCREEN = "#00ff00";
const AUDIO_SAMPLE_RATE = 48_000;

// the presenter's laser (sizes in px at 1080p)
const LASER_SIZE = 4;
const LASER_DECAY_LENGTH = 50;

type EncodingSetup = {
  format: Mp4OutputFormat | WebMOutputFormat;
  extension: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
  alpha: boolean;
};

/** MP4 (H.264/HEVC) for editors where possible, else WebM. */
const getEncodingSetup = async (
  width: number,
  height: number,
  background: VideoExportOptions["background"],
): Promise<EncodingSetup> => {
  if (background === "transparent") {
    for (const codec of ["vp9", "av1"] as const) {
      if (await canEncodeVideo(codec, { width, height, alpha: "keep" })) {
        return {
          format: new WebMOutputFormat(),
          extension: ".webm",
          videoCodec: codec,
          audioCodec: await getFirstEncodableAudioCodec(["opus"]),
          alpha: true,
        };
      }
    }
    throw new Error(
      "This browser can't export transparent video. Try Chrome, or use the green screen background.",
    );
  }

  const mp4Codec = await getFirstEncodableVideoCodec(["avc", "hevc"], {
    width,
    height,
  });
  if (mp4Codec) {
    return {
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      extension: ".mp4",
      videoCodec: mp4Codec,
      audioCodec: await getFirstEncodableAudioCodec(["aac", "opus"]),
      alpha: false,
    };
  }
  const webmCodec = await getFirstEncodableVideoCodec(["vp9", "vp8", "av1"], {
    width,
    height,
  });
  if (webmCodec) {
    return {
      format: new WebMOutputFormat(),
      extension: ".webm",
      videoCodec: webmCodec,
      audioCodec: await getFirstEncodableAudioCodec(["opus"]),
      alpha: false,
    };
  }
  throw new Error("This browser can't export video. Try a recent Chrome.");
};

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Couldn't render a frame"));
    image.src = url;
  });

/** One slide visit, rendered as SVG and animated like when presenting. */
type VisitRender = {
  token: number;
  slide: Slide;
  svg: SVGSVGElement;
  replay: SlideReplay;
  ink: SVGGElement;
  laser: SVGPathElement;
};

/** Renders recording frames onto a canvas. */
class FrameRenderer {
  private readonly container: HTMLDivElement;
  private readonly slides: Slide[];
  private readonly input: SlideRenderInput;
  private readonly templates = new Map<string, Promise<SVGSVGElement>>();
  private visit: VisitRender | null = null;
  private lastSignature: string | null = null;

  constructor(
    private readonly recording: PresentationRecording,
    private readonly canvas: HTMLCanvasElement,
    private readonly options: VideoExportOptions,
  ) {
    const { scene } = recording;
    this.input = {
      elements: scene.elements as NonDeletedExcalidrawElement[],
      files: scene.files,
      appState: {
        viewBackgroundColor: scene.viewBackgroundColor,
        theme: scene.theme,
      },
    };
    this.slides = getSlides(this.input.elements);
    // in the document (path lengths need layout), but invisible
    this.container = document.createElement("div");
    this.container.style.cssText =
      "position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden;pointer-events:none";
    document.body.appendChild(this.container);
  }

  destroy() {
    this.container.remove();
  }

  private getTemplate(slide: Slide) {
    let template = this.templates.get(slide.id);
    if (!template) {
      template = exportToSvg({
        elements: this.input.elements,
        appState: {
          // painted on the canvas instead (or not at all)
          exportBackground: false,
          viewBackgroundColor: this.input.appState.viewBackgroundColor,
          exportWithDarkMode: this.input.appState.theme === "dark",
        },
        files: this.input.files,
        exportingFrame: slide,
        exportPadding: 0,
        markElementIds: true,
      });
      this.templates.set(slide.id, template);
    }
    return template;
  }

  private async getVisit(frame: RecordingFrame): Promise<VisitRender | null> {
    const { state } = frame;
    if (
      this.visit?.token === state.token &&
      this.visit.slide.id === state.slideId
    ) {
      return this.visit;
    }
    this.visit?.svg.remove();
    this.visit = null;

    const slide = this.slides.find(
      (candidate) => candidate.id === state.slideId,
    );
    if (!slide) {
      return null;
    }
    const svg = (await this.getTemplate(slide)).cloneNode(
      true,
    ) as SVGSVGElement;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    this.container.appendChild(svg);

    const replay = new SlideReplay(
      svg,
      getSlideReplayTimeline(slide, this.input),
    );
    const ink = document.createElementNS(SVG_NS, "g");
    const laser = document.createElementNS(SVG_NS, "path");
    laser.setAttribute("fill", INK_COLOR);
    svg.append(ink, laser);

    this.visit = { token: state.token, slide, svg, replay, ink, laser };
    return this.visit;
  }

  /** where the slide goes on the canvas (fit, centered) */
  private getSlideRect(slide: Slide) {
    const { width, height } = this.canvas;
    const scale = Math.min(width / slide.width, height / slide.height);
    return {
      x: (width - slide.width * scale) / 2,
      y: (height - slide.height * scale) / 2,
      width: slide.width * scale,
      height: slide.height * scale,
      scale,
    };
  }

  private renderLaser(
    visit: VisitRender,
    trails: readonly LaserTrailRecord[],
    time: number,
    pxPerUnit: number,
  ) {
    const outputScale = this.canvas.height / 1080;
    const size = (LASER_SIZE * outputScale) / pxPerUnit;
    const decayLength = (LASER_DECAY_LENGTH * outputScale) / pxPerUnit;
    const paths: string[] = [];

    for (const trail of trails) {
      const laser = new LaserPointer({
        size,
        simplify: 0,
        streamline: 0.4,
        sizeMapping: (c) => {
          const t = Math.max(0, 1 - (time - c.pressure) / LASER_FADE_TIME);
          const l =
            (decayLength -
              Math.min(decayLength, c.totalLength - c.currentIndex)) /
            decayLength;
          return Math.min(easeOut(l), easeOut(t));
        },
      });
      for (const point of trail.points) {
        if (point[2] > time) {
          break;
        }
        laser.addPoint(point);
      }
      if (trail.end <= time) {
        laser.close();
      }
      const outline = laser.getStrokeOutline();
      if (outline.length) {
        paths.push(getSvgPathFromStroke(outline, true));
      }
    }
    visit.laser.setAttribute("d", paths.join(" "));
    return paths.length;
  }

  /** @returns whether the canvas changed */
  async render(frame: RecordingFrame | null, time: number): Promise<boolean> {
    const context = this.canvas.getContext("2d")!;
    const { width, height } = this.canvas;
    const { background } = this.options;
    const fillBackground = () => {
      context.clearRect(0, 0, width, height);
      if (background !== "transparent") {
        context.fillStyle =
          background === "green"
            ? GREEN_SCREEN
            : applyDarkModeFilter(
                this.input.appState.viewBackgroundColor,
                this.input.appState.theme === "dark",
              );
        context.fillRect(0, 0, width, height);
      }
    };

    // the sync flash (keyed backgrounds keep it out of the picture)
    if (time < SYNC_FLASH_DURATION && background === "slide") {
      if (this.lastSignature === "flash") {
        return false;
      }
      this.lastSignature = "flash";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      return true;
    }

    const visit = frame && (await this.getVisit(frame));
    if (!frame || !visit) {
      if (this.lastSignature === "empty") {
        return false;
      }
      this.lastSignature = "empty";
      fillBackground();
      return true;
    }

    const rect = this.getSlideRect(visit.slide);
    const replayTime =
      frame.state.replay && frame.state.play ? frame.replayTime : Infinity;
    const replaying = replayTime < visit.replay.duration;
    const laserCount = frame.laserTrails.length;

    // unchanged frames (most of them, while talking) reuse the canvas
    const signature = [
      visit.slide.id,
      visit.token,
      replaying ? Math.round(replayTime) : "done",
      frame.strokes
        .map((stroke) => `${stroke.id}:${stroke.points.length}`)
        .join(","),
      laserCount ? time : "",
    ].join("|");
    if (signature === this.lastSignature) {
      return false;
    }
    this.lastSignature = signature;

    visit.replay.seek(replayTime);
    visit.ink.replaceChildren(
      ...frame.strokes.map((stroke) => {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", getFreeDrawSvgPath(stroke));
        path.setAttribute("fill", stroke.strokeColor);
        path.setAttribute(
          "transform",
          `translate(${stroke.x - visit.slide.x} ${stroke.y - visit.slide.y})`,
        );
        return path;
      }),
    );
    this.renderLaser(visit, frame.laserTrails, time, rect.scale);

    // rasterized at the output size (crisp, not a scaled bitmap)
    visit.svg.setAttribute("width", `${rect.width}`);
    visit.svg.setAttribute("height", `${rect.height}`);
    const markup = new XMLSerializer().serializeToString(visit.svg);
    visit.svg.removeAttribute("width");
    visit.svg.removeAttribute("height");

    const url = URL.createObjectURL(
      new Blob([markup], { type: "image/svg+xml" }),
    );
    try {
      const image = await loadImage(url);
      fillBackground();
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  }
}

/** The audio track: the sync chirp at time 0, then silence. */
const createAudioBuffer = () => {
  const chirp = createChirpSamples(AUDIO_SAMPLE_RATE);
  const buffer = new AudioBuffer({
    length: AUDIO_SAMPLE_RATE, // 1s
    numberOfChannels: 1,
    sampleRate: AUDIO_SAMPLE_RATE,
  });
  buffer.copyToChannel(chirp, 0);
  return buffer;
};

/**
 * Renders a recording as a video: the presentation exactly as shown (pace,
 * replays, ink, laser), starting with the sync chirp/flash.
 */
export const exportRecordingToVideo = async (
  recording: PresentationRecording,
  options: VideoExportOptions,
  opts: {
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ExportedVideo> => {
  const height = options.height;
  const width = Math.round((height * 16) / 9);
  const setup = await getEncodingSetup(width, height, options.background);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const output = new Output({
    format: setup.format,
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, {
    codec: setup.videoCodec,
    bitrate: QUALITY_HIGH,
    alpha: setup.alpha ? "keep" : "discard",
  });
  output.addVideoTrack(videoSource, { frameRate: options.fps });
  const audioSource = setup.audioCodec
    ? new AudioBufferSource({ codec: setup.audioCodec, bitrate: QUALITY_HIGH })
    : null;
  if (audioSource) {
    output.addAudioTrack(audioSource);
  }

  const playback = new RecordingPlayback(recording);
  const renderer = new FrameRenderer(recording, canvas, options);

  try {
    await output.start();
    if (audioSource) {
      await audioSource.add(createAudioBuffer());
      audioSource.close();
    }

    const frameCount = Math.max(
      1,
      Math.ceil((playback.duration / 1000) * options.fps),
    );
    for (let index = 0; index < frameCount; index++) {
      if (opts.signal?.aborted) {
        throw new DOMException("Export cancelled", "AbortError");
      }
      const time = (index * 1000) / options.fps;
      await renderer.render(playback.getFrame(time), time);
      await videoSource.add(index / options.fps, 1 / options.fps);
      opts.onProgress?.((index + 1) / frameCount);
    }
    videoSource.close();
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    renderer.destroy();
  }

  const buffer = (output.target as BufferTarget).buffer!;
  return {
    blob: new Blob([buffer], { type: await output.getMimeType() }),
    extension: setup.extension,
  };
};
