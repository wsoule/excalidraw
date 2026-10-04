import { reconcileElements } from "@excalidraw/excalidraw";
import {
  decryptData,
  encryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";

/**
 * Collaboration rooms stored on our own server (see /room-server), instead of
 * a Firestore document, which is capped at ~1 MB: the scene is compressed,
 * encrypted with the room key, and saved as one blob with a version for
 * compare-and-set.
 */

/** e.g. https://collab.example.com/api — unset: rooms are kept in Firebase */
export const ROOM_STORAGE_URL: string | null =
  import.meta.env.VITE_APP_ROOM_STORAGE_URL || null;

// blob: [format][flags][iv (12)][ciphertext]
const FORMAT = 1;
const FLAG_GZIP = 1;
const IV_LENGTH = 12;
const MAX_SAVE_ATTEMPTS = 5;

const canCompress = () =>
  typeof CompressionStream !== "undefined" &&
  typeof DecompressionStream !== "undefined";

const pipeThrough = async (
  data: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
) =>
  new Uint8Array(
    await new Response(
      new Response(data).body!.pipeThrough(stream),
    ).arrayBuffer(),
  );

export const encodeRoomScene = async (
  elements: readonly ExcalidrawElement[],
  roomKey: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  let data = new TextEncoder().encode(JSON.stringify(elements));
  let flags = 0;
  if (canCompress()) {
    data = await pipeThrough(data, new CompressionStream("gzip"));
    flags |= FLAG_GZIP;
  }
  const { encryptedBuffer, iv } = await encryptData(roomKey, data);
  const blob = new Uint8Array(2 + IV_LENGTH + encryptedBuffer.byteLength);
  blob[0] = FORMAT;
  blob[1] = flags;
  blob.set(iv, 2);
  blob.set(new Uint8Array(encryptedBuffer), 2 + IV_LENGTH);
  return blob;
};

export const decodeRoomScene = async (
  blob: Uint8Array<ArrayBuffer>,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  if (blob[0] !== FORMAT) {
    throw new Error("Unknown room scene format");
  }
  const flags = blob[1];
  const iv = blob.slice(2, 2 + IV_LENGTH);
  const ciphertext = blob.slice(2 + IV_LENGTH);
  let data = new Uint8Array(await decryptData(iv, ciphertext, roomKey));
  if (flags & FLAG_GZIP) {
    data = await pipeThrough(data, new DecompressionStream("gzip"));
  }
  return JSON.parse(new TextDecoder().decode(data));
};

const sceneUrl = (roomId: string) =>
  `${ROOM_STORAGE_URL!.replace(/\/$/, "")}/rooms/${encodeURIComponent(
    roomId,
  )}/scene`;

type StoredRoomScene = {
  version: number;
  elements: readonly SyncableExcalidrawElement[];
};

/** `null` if the room was never saved here */
export const fetchRoomScene = async (
  roomId: string,
  roomKey: string,
): Promise<StoredRoomScene | null> => {
  const response = await fetch(sceneUrl(roomId), { cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Couldn't load the room (${response.status})`);
  }
  const version = Number(response.headers.get("X-Version"));
  const elements = await decodeRoomScene(
    new Uint8Array(await response.arrayBuffer()),
    roomKey,
  );
  return {
    version,
    elements: getSyncableElements(
      restoreElements(elements, null, { deleteInvisibleElements: true }),
    ),
  };
};

// what this client last read or wrote, per room
const knownScenes = new Map<string, StoredRoomScene>();

/**
 * Saves the room, merged with whatever others saved meanwhile.
 *
 * @param getLegacyScene the room as stored before (Firebase), merged in on
 *   the first save here so nothing is lost when a room moves over
 * @returns the elements as stored
 */
export const saveRoomScene = async (
  roomId: string,
  roomKey: string,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
  getLegacyScene: () => Promise<readonly SyncableExcalidrawElement[] | null>,
): Promise<readonly SyncableExcalidrawElement[]> => {
  let known: StoredRoomScene | null | undefined = knownScenes.get(roomId);
  if (!known) {
    known = await fetchRoomScene(roomId, roomKey);
    if (!known) {
      const legacy = await getLegacyScene().catch(() => null);
      known = { version: 0, elements: legacy ?? [] };
    }
  }

  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    const reconciled = getSyncableElements(
      reconcileElements(
        elements,
        known.elements as readonly OrderedExcalidrawElement[] as readonly RemoteExcalidrawElement[],
        appState,
      ),
    );
    const response = await fetch(sceneUrl(roomId), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-If-Version": String(known.version),
      },
      body: await encodeRoomScene(reconciled, roomKey),
    });

    if (response.ok) {
      const { version } = await response.json();
      knownScenes.set(roomId, { version, elements: reconciled });
      return reconciled;
    }
    if (response.status !== 409) {
      throw new Error(
        response.status === 413
          ? "The scene is larger than the collaboration server allows"
          : `Couldn't save the room (${response.status})`,
      );
    }
    // someone saved first: merge their version and try again
    known = (await fetchRoomScene(roomId, roomKey)) ?? {
      version: 0,
      elements: [],
    };
  }
  throw new Error("Couldn't save the room: too many conflicting saves");
};

/** for loading: also remembers the version, for the next save */
export const loadRoomScene = async (roomId: string, roomKey: string) => {
  const stored = await fetchRoomScene(roomId, roomKey);
  if (stored) {
    knownScenes.set(roomId, stored);
  }
  return stored?.elements ?? null;
};
