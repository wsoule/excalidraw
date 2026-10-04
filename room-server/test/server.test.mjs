import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { io as connect } from "socket.io-client";

const PORT = 39_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://example.github.io";
let server;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "room-server-"));
  server = spawn(
    process.execPath,
    [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        CORS_ORIGIN: ORIGIN,
        MAX_SCENE_BYTES: String(1024 * 1024),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  await new Promise((resolve) =>
    server.stdout.on("data", (data) => {
      if (String(data).includes("listening")) {
        resolve();
      }
    }),
  );
});

after(async () => {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
});

const sceneUrl = (roomId) => `${BASE}/api/rooms/${roomId}/scene`;
const put = (roomId, body, ifVersion) =>
  fetch(sceneUrl(roomId), {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-If-Version": String(ifVersion),
    },
    body,
  });

test("stores scenes with compare-and-set versions", async () => {
  assert.equal((await fetch(sceneUrl("room1"))).status, 404);

  const created = await put("room1", new Uint8Array([1, 2, 3]), 0);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { version: 1 });

  // stale version: rejected with the current one
  const stale = await put("room1", new Uint8Array([9]), 0);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { version: 1 });

  assert.equal((await put("room1", new Uint8Array([4, 5]), 1)).status, 200);

  const loaded = await fetch(sceneUrl("room1"));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get("x-version"), "2");
  assert.deepEqual(
    new Uint8Array(await loaded.arrayBuffer()),
    new Uint8Array([4, 5]),
  );
});

test("only one of two concurrent writes with the same version wins", async () => {
  await put("race", new Uint8Array([0]), 0);
  const results = await Promise.all([
    put("race", new Uint8Array([1]), 1),
    put("race", new Uint8Array([2]), 1),
  ]);
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
});

test("rejects oversized scenes, bad room ids and missing versions", async () => {
  const big = await put("big", new Uint8Array(1024 * 1024 + 1), 0).catch(
    // the server may close the connection while the body is still sent
    () => ({ status: 413 }),
  );
  assert.equal(big.status, 413);
  assert.equal((await fetch(sceneUrl("bad.id"))).status, 404);
  assert.equal(
    (
      await fetch(sceneUrl("room2"), {
        method: "PUT",
        body: new Uint8Array([1]),
      })
    ).status,
    400,
  );
});

test("allows the configured origin (CORS)", async () => {
  const preflight = await fetch(sceneUrl("room1"), {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "x-if-version",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(
    preflight.headers.get("access-control-allow-headers"),
    /X-If-Version/i,
  );
  const other = await fetch(sceneUrl("room1"), {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("relays room messages between clients (excalidraw-room protocol)", async () => {
  const join = () =>
    new Promise((resolve) => {
      const socket = connect(BASE, {
        transports: ["websocket"],
        extraHeaders: { Origin: ORIGIN },
      });
      socket.on("init-room", () => socket.emit("join-room", "relay"));
      socket.on("room-user-change", (users) => resolve({ socket, users }));
    });
  const a = await join();
  const bJoined = join();
  const newUser = new Promise((resolve) => a.socket.on("new-user", resolve));
  const b = await bJoined;
  assert.equal(b.users.length, 2);
  assert.equal(await newUser, b.socket.id);

  const received = new Promise((resolve) =>
    b.socket.on("client-broadcast", (data, iv) => resolve([data, iv])),
  );
  a.socket.emit(
    "server-broadcast",
    "relay",
    new Uint8Array([7]),
    new Uint8Array([8]),
  );
  const [data, iv] = await received;
  assert.deepEqual(new Uint8Array(data), new Uint8Array([7]));
  assert.deepEqual(new Uint8Array(iv), new Uint8Array([8]));

  a.socket.close();
  b.socket.close();
});
