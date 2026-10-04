import { generateEncryptionKey } from "@excalidraw/excalidraw/data/encryption";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { pointFrom } from "@excalidraw/math";
import { vi } from "vitest";

import type { LocalPoint } from "@excalidraw/math";
import type { AppState } from "@excalidraw/excalidraw/types";

import type { SyncableExcalidrawElement } from "../data";

vi.stubEnv("VITE_APP_ROOM_STORAGE_URL", "https://collab.test/api");

const { decodeRoomScene, encodeRoomScene, saveRoomScene } = await import(
  "../data/roomStorage"
);

const appState = {} as AppState;

/** a minimal stand-in for /room-server's scene API */
const createServer = () => {
  const rooms = new Map<string, { version: number; data: Uint8Array }>();
  let conflictCount = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const roomId = url.match(/rooms\/([^/]+)\/scene/)![1];
    const room = rooms.get(roomId);
    if (!init.method || init.method === "GET") {
      return room
        ? new Response(room.data.slice(), {
            headers: { "X-Version": String(room.version) },
          })
        : new Response("{}", { status: 404 });
    }
    const ifVersion = Number(
      (init.headers as Record<string, string>)["X-If-Version"],
    );
    const version = room?.version ?? 0;
    if (ifVersion !== version) {
      conflictCount++;
      return new Response(JSON.stringify({ version }), { status: 409 });
    }
    rooms.set(roomId, {
      version: version + 1,
      data: new Uint8Array(init.body as Uint8Array),
    });
    return new Response(JSON.stringify({ version: version + 1 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { rooms, fetchMock, conflicts: () => conflictCount };
};

const rect = (id: string, version = 1) =>
  ({
    ...API.createElement({ type: "rectangle", id }),
    version,
  } as unknown as SyncableExcalidrawElement);

describe("room storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encrypts (and compresses) scenes so only the key can read them", async () => {
    const key = (await generateEncryptionKey())!;
    const elements = [rect("a"), rect("b")];
    const blob = await encodeRoomScene(elements, key);

    expect(new TextDecoder().decode(blob)).not.toContain('"rectangle"');
    expect(await decodeRoomScene(blob, key)).toEqual(
      JSON.parse(JSON.stringify(elements)),
    );
    await expect(
      decodeRoomScene(blob, (await generateEncryptionKey())!),
    ).rejects.toThrow();
  });

  it("keeps heavy freehand drawings small", async () => {
    expect(typeof CompressionStream).toBe("function");
    const key = (await generateEncryptionKey())!;
    // 500 strokes x 200 points, with drawing timing
    const strokes = Array.from({ length: 500 }, (_, i) => ({
      ...API.createElement({ type: "freedraw", id: `s${i}` }),
      points: Array.from({ length: 200 }, (_, p) =>
        pointFrom<LocalPoint>(p * 1.37, Math.sin(p / 7) * 40.123),
      ),
      customData: {
        drawing: {
          t: 1,
          d: 2000,
          p: Array.from({ length: 200 }, (_, p) => p * 10),
        },
      },
    }));
    const json = JSON.stringify(strokes).length;
    const blob = await encodeRoomScene(strokes, key);
    // over the old ~1 MB Firestore limit as JSON; the server takes far more
    expect(json).toBeGreaterThan(1_048_576);
    expect(blob.length).toBeLessThan(json / 2);
  });

  it("merges in what others saved meanwhile and retries", async () => {
    const { conflicts } = createServer();
    const key = (await generateEncryptionKey())!;

    // client A creates the room (version 1)
    await saveRoomScene("room", key, [rect("a")], appState, async () => null);

    // client B (another browser) loads it and saves (version 2)
    vi.resetModules();
    const clientB = await import("../data/roomStorage");
    await clientB.loadRoomScene("room", key);
    await clientB.saveRoomScene(
      "room",
      key,
      [rect("a"), rect("b")],
      appState,
      async () => null,
    );

    // A still thinks it's version 1: rejected, reloads, merges, retries
    const saved = await saveRoomScene(
      "room",
      key,
      [rect("a"), rect("c")],
      appState,
      async () => null,
    );
    expect(conflicts()).toBe(1);
    expect(saved.map((element) => element.id).sort()).toEqual(["a", "b", "c"]);
    expect(
      (await clientB.loadRoomScene("room", key))!
        .map((element) => element.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges a room that's still in Firebase on its first save", async () => {
    createServer();
    const key = (await generateEncryptionKey())!;
    const saved = await saveRoomScene(
      "legacy",
      key,
      [rect("new")],
      appState,
      async () => [rect("old")],
    );
    expect(saved.map((element) => element.id).sort()).toEqual(["new", "old"]);
  });
});
