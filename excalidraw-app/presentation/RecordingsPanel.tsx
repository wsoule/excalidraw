import { useCallback, useEffect, useRef, useState } from "react";

import { useAtomValue, useSetAtom } from "../app-jotai";

import {
  RECORDING_FILE_EXTENSION,
  deleteRecording,
  formatDuration,
  listRecordings,
  loadRecording,
  parseRecordingFile,
  recordingsChangedAtom,
  saveRecording,
} from "./presentationRecording";
import { downloadBlob } from "./slides";

import type { RecordingMeta } from "./presentationRecording";
import type { VideoExportOptions } from "./recordingExport";

const DEFAULT_EXPORT_OPTIONS: VideoExportOptions = {
  height: 1080,
  fps: 30,
  background: "slide",
};

const getFileName = (meta: RecordingMeta) => {
  const date = new Date(meta.createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `presentation-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

const ExportForm = ({
  meta,
  onDone,
}: {
  meta: RecordingMeta;
  onDone: () => void;
}) => {
  const [options, setOptions] = useState(DEFAULT_EXPORT_OPTIONS);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setProgress(0);
    try {
      const recording = await loadRecording(meta.id);
      if (!recording) {
        throw new Error("Recording not found");
      }
      // loaded on demand: the encoder is only needed here
      const { exportRecordingToVideo } = await import("./recordingExport");
      const video = await exportRecordingToVideo(recording, options, {
        onProgress: setProgress,
        signal: abort.signal,
      });
      downloadBlob(video.blob, `${getFileName(meta)}${video.extension}`);
      onDone();
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        console.error(error);
        setError(error?.message || String(error));
      }
      setProgress(null);
    } finally {
      abortRef.current = null;
    }
  };

  if (progress !== null) {
    return (
      <div className="presentation-panel__export">
        <progress value={progress} max={1} />
        <div className="presentation-panel__actions">
          <span className="presentation-panel__hint">
            Rendering… {Math.round(progress * 100)}%
          </span>
          <button
            type="button"
            className="presentation-panel__button"
            onClick={() => abortRef.current?.abort()}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="presentation-panel__export">
      <label>
        Size
        <select
          value={options.height}
          onChange={(event) =>
            setOptions({
              ...options,
              height: Number(
                event.target.value,
              ) as VideoExportOptions["height"],
            })
          }
        >
          <option value={1080}>1080p (1920×1080)</option>
          <option value={2160}>4K (3840×2160)</option>
        </select>
      </label>
      <label>
        Frame rate
        <select
          value={options.fps}
          onChange={(event) =>
            setOptions({
              ...options,
              fps: Number(event.target.value) as VideoExportOptions["fps"],
            })
          }
        >
          <option value={30}>30 fps</option>
          <option value={60}>60 fps</option>
        </select>
      </label>
      <label>
        Background
        <select
          value={options.background}
          onChange={(event) =>
            setOptions({
              ...options,
              background: event.target
                .value as VideoExportOptions["background"],
            })
          }
        >
          <option value="slide">Slide color</option>
          <option value="green">Green screen</option>
          <option value="transparent">Transparent (WebM)</option>
        </select>
      </label>
      <p className="presentation-panel__hint">
        MP4 where this browser can encode it (Chrome, Edge, Safari), otherwise
        WebM.
      </p>
      {error && <p className="presentation-panel__error">{error}</p>}
      <div className="presentation-panel__actions">
        <button
          type="button"
          className="presentation-panel__button presentation-panel__button--primary"
          onClick={start}
        >
          Export video
        </button>
        <button
          type="button"
          className="presentation-panel__button"
          onClick={onDone}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

/** Recorded presentations (in this browser), exportable as videos. */
export const RecordingsPanel = () => {
  const changed = useAtomValue(recordingsChangedAtom);
  const setChanged = useSetAtom(recordingsChangedAtom);
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    listRecordings()
      .then((list) => !cancelled && setRecordings(list))
      .catch((error) => console.error(error));
    return () => {
      cancelled = true;
    };
  }, [changed]);

  const download = useCallback(async (meta: RecordingMeta) => {
    const recording = await loadRecording(meta.id);
    if (recording) {
      downloadBlob(
        new Blob([JSON.stringify(recording)], { type: "application/json" }),
        `${getFileName(meta)}${RECORDING_FILE_EXTENSION}`,
      );
    }
  }, []);

  const remove = useCallback(
    async (meta: RecordingMeta) => {
      if (window.confirm("Delete this recording?")) {
        await deleteRecording(meta.id);
        setChanged((count) => count + 1);
      }
    },
    [setChanged],
  );

  const open = async (file: File) => {
    setError(null);
    try {
      await saveRecording(parseRecordingFile(await file.text()));
      setChanged((count) => count + 1);
    } catch (error: any) {
      setError(error?.message || String(error));
    }
  };

  return (
    <section className="presentation-panel__recordings">
      <h3 className="presentation-panel__heading">Recordings</h3>
      {recordings.length ? (
        <ul className="presentation-panel__list">
          {recordings.map((meta) => (
            <li key={meta.id} className="presentation-panel__recording">
              <div className="presentation-panel__item">
                <span className="presentation-panel__recording-name">
                  {new Date(meta.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {" · "}
                  {formatDuration(meta.duration)}
                  {" · "}
                  {meta.slideCount} slide{meta.slideCount === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  className="presentation-panel__icon-button"
                  aria-label="Export video"
                  title="Export video"
                  onClick={() =>
                    setExportingId(exportingId === meta.id ? null : meta.id)
                  }
                >
                  🎬
                </button>
                <button
                  type="button"
                  className="presentation-panel__icon-button"
                  aria-label="Download recording file"
                  title="Download the recording file (to export it on another device)"
                  onClick={() => download(meta)}
                >
                  ⤓
                </button>
                <button
                  type="button"
                  className="presentation-panel__icon-button"
                  aria-label="Delete recording"
                  title="Delete"
                  onClick={() => remove(meta)}
                >
                  ✕
                </button>
              </div>
              {exportingId === meta.id && (
                <ExportForm meta={meta} onDone={() => setExportingId(null)} />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="presentation-panel__hint">
          Press ● Rec while presenting to record your slides, replays, ink and
          laser at your pace. It starts with a sync chirp, so the exported video
          lines up with your camera recording by audio.
        </p>
      )}
      <button
        type="button"
        className="presentation-panel__link"
        onClick={() => fileInputRef.current?.click()}
      >
        Open a recording file…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            open(file);
          }
        }}
      />
      {error && <p className="presentation-panel__error">{error}</p>}
    </section>
  );
};
