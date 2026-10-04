// Excalidraw collaboration server: relays end-to-end encrypted room messages
// over socket.io (a port of excalidraw/excalidraw-room, MIT), and stores each
// room's encrypted scene so rooms survive everyone leaving.
//
// The server never sees plaintext: clients encrypt with the room key (which
// is only in the share link's #hash) before sending anything.

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { Server as SocketIO } from "socket.io";

const PORT = Number(process.env.PORT) || 3002;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DATA_DIR = process.env.DATA_DIR || "./data";
/** largest encrypted scene accepted (bytes) */
const MAX_SCENE_BYTES =
  Number(process.env.MAX_SCENE_BYTES) || 256 * 1024 * 1024;

const SCENES_DIR = path.join(DATA_DIR, "scenes");
const ROOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// -----------------------------------------------------------------------------
// scene storage
// -----------------------------------------------------------------------------

const scenePath = (roomId) => path.join(SCENES_DIR, `${roomId}.bin`);
const metaPath = (roomId) => path.join(SCENES_DIR, `${roomId}.json`);

const readVersion = async (roomId) => {
  try {
    return JSON.parse(await readFile(metaPath(roomId), "utf8")).version;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
};

/** atomic: readers see the old or the new file, never half of one */
const writeAtomic = async (file, data) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
};

// one write at a time per room (compare-and-set on the version)
const roomLocks = new Map();
const withRoomLock = (roomId, task) => {
  const previous = roomLocks.get(roomId) || Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => {});
  roomLocks.set(roomId, settled);
  settled.then(() => {
    if (roomLocks.get(roomId) === settled) {
      roomLocks.delete(roomId);
    }
  });
  return next;
};

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------

const setCors = (req, res) => {
  const origin = req.headers.origin;
  if (CORS_ORIGIN === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && CORS_ORIGIN.split(",").includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-If-Version");
  res.setHeader("Access-Control-Expose-Headers", "X-Version");
  res.setHeader("Access-Control-Max-Age", "86400");
};

const sendJSON = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const handleScene = async (req, res, roomId) => {
  if (req.method === "GET") {
    const version = await readVersion(roomId);
    if (!version) {
      return sendJSON(res, 404, { error: "not found" });
    }
    const data = await readFile(scenePath(roomId));
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Version": String(version),
    });
    return res.end(data);
  }

  if (req.method === "PUT") {
    const ifVersion = Number(req.headers["x-if-version"]);
    if (!Number.isInteger(ifVersion) || ifVersion < 0) {
      return sendJSON(res, 400, { error: "X-If-Version required" });
    }
    const data = await readBody(req, MAX_SCENE_BYTES);
    if (!data.length) {
      return sendJSON(res, 400, { error: "empty" });
    }
    return withRoomLock(roomId, async () => {
      const version = await readVersion(roomId);
      if (version !== ifVersion) {
        // someone else saved first: the client reconciles and retries
        return sendJSON(res, 409, { version });
      }
      const nextVersion = version + 1;
      await writeAtomic(scenePath(roomId), data);
      await writeAtomic(
        metaPath(roomId),
        JSON.stringify({
          version: nextVersion,
          size: data.length,
          updated: Date.now(),
        }),
      );
      log(`scene ${roomId} v${nextVersion} (${data.length} bytes)`);
      return sendJSON(res, 200, { version: nextVersion });
    });
  }

  return sendJSON(res, 405, { error: "method not allowed" });
};

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Excalidraw collaboration server is up :)");
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/scene$/);
    if (match && ROOM_ID.test(match[1])) {
      return await handleScene(req, res, match[1]);
    }
    return sendJSON(res, 404, { error: "not found" });
  } catch (error) {
    if (error.status) {
      return sendJSON(res, error.status, { error: error.message });
    }
    console.error(error);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: "internal error" });
    }
  }
});

// -----------------------------------------------------------------------------
// socket.io (same protocol as excalidraw-room)
// -----------------------------------------------------------------------------

const io = new SocketIO(server, {
  transports: ["websocket", "polling"],
  cors: {
    allowedHeaders: ["Content-Type", "Authorization"],
    origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(","),
    credentials: true,
  },
  allowEIO3: true,
  // scene syncs of large drawings go through here too
  maxHttpBufferSize: MAX_SCENE_BYTES,
});

io.on("connection", (socket) => {
  io.to(`${socket.id}`).emit("init-room");

  socket.on("join-room", async (roomID) => {
    await socket.join(roomID);
    const sockets = await io.in(roomID).fetchSockets();
    if (sockets.length <= 1) {
      io.to(`${socket.id}`).emit("first-in-room");
    } else {
      socket.broadcast.to(roomID).emit("new-user", socket.id);
    }
    io.in(roomID).emit(
      "room-user-change",
      sockets.map((roomSocket) => roomSocket.id),
    );
  });

  socket.on("server-broadcast", (roomID, encryptedData, iv) => {
    socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
  });

  socket.on("server-volatile-broadcast", (roomID, encryptedData, iv) => {
    socket.volatile.broadcast
      .to(roomID)
      .emit("client-broadcast", encryptedData, iv);
  });

  socket.on("user-follow", async (payload) => {
    const roomID = `follow@${payload.userToFollow.socketId}`;
    if (payload.action === "FOLLOW") {
      await socket.join(roomID);
    } else if (payload.action === "UNFOLLOW") {
      await socket.leave(roomID);
    } else {
      return;
    }
    const sockets = await io.in(roomID).fetchSockets();
    io.to(payload.userToFollow.socketId).emit(
      "user-follow-room-change",
      sockets.map((roomSocket) => roomSocket.id),
    );
  });

  socket.on("disconnecting", async () => {
    for (const roomID of Array.from(socket.rooms)) {
      const otherClients = (await io.in(roomID).fetchSockets()).filter(
        (roomSocket) => roomSocket.id !== socket.id,
      );
      const isFollowRoom = roomID.startsWith("follow@");
      if (!isFollowRoom && otherClients.length > 0) {
        socket.broadcast.to(roomID).emit(
          "room-user-change",
          otherClients.map((roomSocket) => roomSocket.id),
        );
      }
      if (isFollowRoom && otherClients.length === 0) {
        io.to(roomID.replace("follow@", "")).emit("broadcast-unfollow");
      }
    }
  });

  socket.on("disconnect", () => {
    socket.removeAllListeners();
    socket.disconnect();
  });
});

// -----------------------------------------------------------------------------

await mkdir(SCENES_DIR, { recursive: true });
// leftovers of writes interrupted by a restart
await Promise.all(
  (await readdir(SCENES_DIR))
    .filter((file) => file.endsWith(".tmp"))
    .map((file) => rm(path.join(SCENES_DIR, file), { force: true })),
);
server.listen(PORT, () => {
  log(
    `listening on ${PORT} (data: ${path.resolve(
      DATA_DIR,
    )}, CORS: ${CORS_ORIGIN})`,
  );
});
