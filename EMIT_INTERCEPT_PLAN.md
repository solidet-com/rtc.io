# Seamless emit() Intercept — Design Plan

> Goal: make `socket.emit("camera", { userId, stream: rtcioStream, streamId: "main" })` transparently handle WebRTC stream transport so that `socket.on("camera", ({ userId, stream, streamId }) => {})` receives the full payload with a real `MediaStream` on the other side.

---

## Problem Statement

The current API forces callers to use two separate concerns:

```typescript
// WebRTC stream setup (separate)
socket.stream("main", mediaStream);

// Payload with metadata (separate, and named event has no metadata)
socket.on("main", ({ id, stream }) => { /* only peerId and stream — no app metadata */ })
```

This means the caller cannot pass application-level data (e.g., `userId`, `streamId`) alongside the stream. They must maintain a separate mapping from peerId → userId.

The desired API is a single, unified call:

```typescript
// Sender
socket.emit("camera", { userId: currentUser.id, stream: rtcioStream, streamId: "main" });

// Receiver — full payload reconstructed
socket.on("camera", ({ userId, stream, streamId }) => { /* stream is MediaStream */ });
```

---

## Architecture Overview

The trick is that `MediaStream` cannot be serialized over Socket.IO. The library must intercept `emit`, split the payload into two parallel channels, and reunite them on the receiver:

```
SENDER                          NETWORK                         RECEIVER

socket.emit("camera", {         ─── socket.io ──────────────►  socket.on receives
  userId, stream: RTCIOStream,        { userId, streamId }       { userId, streamId }
  streamId })                                                     stored in pendingMeta
      │
      ├── detects RTCIOStream   ─── WebRTC (ICE/DTLS) ──────►  ontrack fires
      │   in payload                 MediaStream tracks           stream stored in pendingTracks
      │
      └── sends #stream-meta    ─── socket.io (unicast) ────►  handleStreamMeta receives
              { streamId,              to target peer             correlates both halves
                name: "camera",                                   emits locally:
                fieldKey: "stream",                               "camera" { userId, stream,
                meta: { userId,                                             streamId }
                        streamId }}
```

The correlation key is `mediaStream.id` (the WebRTC `MediaStream.id`).

---

## Changes Required

### 1. `lib/rtc.ts` — Socket class

#### 1a. New internal storage for emit-originated streams

Current:
```typescript
private localStreams: Record<string, MediaStream>; // name → MediaStream
```

The `localStreams` map supports `initializeConnection` replaying streams to newly joined peers. With the emit-intercept approach, we need to store additional context so that when a new peer joins mid-session, we can replay with full metadata.

Add a second map alongside `localStreams`:

```typescript
// Keyed by mediaStream.id — stores metadata for emit-based streams
private localEmitStreams: Map<string, {
    rtcStream: RTCIOStream;
    eventName: string;   // "camera"
    fieldKey: string;    // "stream"
    meta: Record<string, any>;  // { userId, streamId }
}> = new Map();
```

`localStreams` (name → MediaStream) is kept for the `socket.stream(name, ms)` path.

#### 1b. Updated `streamNameMap` type

The map currently stores `{ peerId, name }`. It needs to carry the extra meta for reconstructing the full payload:

```typescript
private streamNameMap: Record<string, {
    peerId: string;
    name: string;
    fieldKey: string;   // which key in the payload held the RTCIOStream
    meta: Record<string, any> | null;  // null → legacy socket.stream() path
}> = {};
```

#### 1c. Override `emit()`

Override the Socket's `emit()` to detect `RTCIOStream` instances in the payload.

```typescript
emit(event: string, ...args: any[]): this {
    // Never intercept internal signaling events
    if (event.startsWith("#")) {
        return super.emit(event, ...args);
    }

    const [data, ...rest] = args;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const extracted = this.extractRTCIOStreams(data);
        if (extracted.streams.length > 0) {
            extracted.streams.forEach(({ key, rtcStream }) => {
                this.scheduleEmitStream(event, key, rtcStream, extracted.sanitized);
            });
            // Send the stripped payload (no RTCIOStream) via socket.io
            // so the server can relay app-level metadata to other clients
            return super.emit(event, extracted.sanitized, ...rest);
        }
    }

    return super.emit(event, ...args);
}
```

**Note on `super.emit`**: `Socket.emit` in socket.io-client sends to the server. `super.emit` here means the parent class's `emit`, which does the serialization and wire send. This is correct.

#### 1d. `extractRTCIOStreams()` helper

Walks top-level keys of the payload object. Top-level only — deeply nested is explicitly out of scope.

```typescript
private extractRTCIOStreams(data: Record<string, any>): {
    sanitized: Record<string, any>;
    streams: Array<{ key: string; rtcStream: RTCIOStream }>;
} {
    const streams: Array<{ key: string; rtcStream: RTCIOStream }> = [];
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(data)) {
        if (value instanceof RTCIOStream) {
            streams.push({ key, rtcStream: value });
        } else {
            sanitized[key] = value;
        }
    }

    return { sanitized, streams };
}
```

#### 1e. `scheduleEmitStream()` — stores and dispatches per peer

Analogous to the existing `stream()` method but carries event metadata.

```typescript
private scheduleEmitStream(
    eventName: string,
    fieldKey: string,
    rtcStream: RTCIOStream,
    meta: Record<string, any>,
) {
    // Store so new peers joining later can receive this stream too
    this.localEmitStreams.set(rtcStream.mediaStream.id, {
        rtcStream, eventName, fieldKey, meta,
    });

    if (!this.connected) return;

    Object.values(this.rtcpeers).forEach((peer) => {
        this.dispatchEmitStreamToPeer(peer, eventName, fieldKey, rtcStream, meta);
    });
}

private dispatchEmitStreamToPeer(
    peer: RTCPeer,
    eventName: string,
    fieldKey: string,
    rtcStream: RTCIOStream,
    meta: Record<string, any>,
) {
    rtcStream._handleStream(peer.connection, peer.socketId);
    this.sendStreamMeta(peer.socketId, eventName, fieldKey, rtcStream.mediaStream, meta);
}
```

#### 1f. Updated `sendStreamMeta()` — extended `#stream-meta` payload

Current signature only sends `{ streamId, name }`. Extend to carry `fieldKey` and `meta`:

```typescript
private sendStreamMeta(
    targetId: string,
    name: string,
    fieldKey: string,
    stream: MediaStream,
    meta: Record<string, any> | null = null,
) {
    super.emit("#stream-meta", {
        source: this.id,
        target: targetId,
        data: { streamId: stream.id, name, fieldKey, meta },
    });
}
```

The existing `stream()` method calls this with `fieldKey = "stream"` and `meta = null` (legacy mode — receiver emits `{ id, stream }`).

#### 1g. Updated `handleStreamMeta()` — reconstruct or buffer

```typescript
handleStreamMeta = (
    payload: MessagePayload<{
        streamId: string;
        name: string;
        fieldKey: string;
        meta: Record<string, any> | null;
    }>,
) => {
    const { source, data: { streamId, name, fieldKey, meta } } = payload;

    const pending = this.pendingTracks[streamId];
    if (pending) {
        delete this.pendingTracks[streamId];
        this.emitStreamEvent(name, fieldKey, meta, source, pending.stream);
    } else {
        this.streamNameMap[streamId] = { peerId: source, name, fieldKey, meta };
    }
};
```

#### 1h. Updated `ontrack` handler — reconstruct or buffer

```typescript
peer.connection.ontrack = ({ transceiver, streams: [stream] }) => {
    if (!stream) return;
    peer.streams[transceiver.mid ?? transceiver.receiver.track.id] = stream;

    if (peer.emittedStreamIds.has(stream.id)) return;
    peer.emittedStreamIds.add(stream.id);

    const metaEntry = this.streamNameMap[stream.id];
    if (metaEntry) {
        delete this.streamNameMap[stream.id];
        this.emitStreamEvent(
            metaEntry.name,
            metaEntry.fieldKey,
            metaEntry.meta,
            source,
            stream,
        );
    } else {
        this.pendingTracks[stream.id] = { peerId: source, stream };
    }
};
```

#### 1i. `emitStreamEvent()` — unified local event emission

```typescript
private emitStreamEvent(
    eventName: string,
    fieldKey: string,
    meta: Record<string, any> | null,
    peerId: string,
    stream: MediaStream,
) {
    const payload = meta !== null
        ? { ...meta, [fieldKey]: stream }          // new path: { userId, streamId, stream: MediaStream }
        : { id: peerId, stream };                  // legacy path: { id, stream }

    // Fire local listeners registered via socket.on("camera", ...) 
    // WITHOUT sending to server (call listeners directly, bypass emit send path)
    this.listeners(eventName).forEach((listener: any) => {
        listener(payload);
    });
}
```

**Critical detail**: `this.listeners(eventName)` gives the registered callbacks from `socket.on("camera", cb)`. Calling them directly fires the local handlers without triggering a send to the server. This is the same pattern already used in `handleStreamMeta` and `ontrack` today.

#### 1j. Updated `initializeConnection()` — replay emit streams to new peers

```typescript
initializeConnection(
    payload: MessagePayload,
    options: { polite: boolean } = { polite: true },
): RTCPeer | undefined {
    try {
        const peer = this.createPeerConnection(payload, options);

        // Replay socket.stream() streams
        for (const [name, mediaStream] of Object.entries(this.localStreams)) {
            this.addTransceiverPeerConnection(peer.connection, mediaStream);
            this.sendStreamMeta(peer.socketId, name, "stream", mediaStream, null);
        }

        // Replay socket.emit() streams (with metadata)
        for (const { rtcStream, eventName, fieldKey, meta } of this.localEmitStreams.values()) {
            this.dispatchEmitStreamToPeer(peer, eventName, fieldKey, rtcStream, meta);
        }

        return peer;
    } catch (error) {
        console.error(error);
        return undefined;
    }
}
```

---

### 2. `lib/stream.ts` — RTCIOStream

No changes needed to the class itself.

**One thing to verify**: `_handleStream` must NOT add duplicate transceivers if called twice for the same peer (e.g., if the user calls emit twice). A guard `if (this.videoTransceivers[socketId]) return;` should be added at the top of `_handleStream`:

```typescript
_handleStream(peerConnection: RTCPeerConnection, socketId: string) {
    // Guard: don't add duplicate transceivers for the same peer
    if (this.videoTransceivers[socketId] || this.audioTransceivers[socketId]) return;

    const videoTrack = this.mediaStream.getVideoTracks()[0];
    const audioTrack = this.mediaStream.getAudioTracks()[0];
    // ... existing logic
}
```

---

### 3. Server — `srtc.io` `defaulthandlers.ts`

The current `addDefaultListeners` only handles `#offer`, `#answer`, `#candidate` (old protocol). The client uses `#rtc-message` (combined) and `#stream-meta` (targeted). Neither is relayed. **WebRTC signaling is broken without this fix.**

```typescript
function addDefaultListeners(socket: Socket) {
    // New unified WebRTC signaling relay
    socket.on("#rtc-message", (data) => {
        socket.to(data.target).emit("#rtc-message", data);
    });

    // Stream metadata relay (unicast: source → target)
    socket.on("#stream-meta", (data) => {
        socket.to(data.target).emit("#stream-meta", data);
    });

    // Legacy handlers kept for backward compatibility
    socket.on("#offer", (data) => socket.to(data.target).emit("#offer", data));
    socket.on("#answer", (data) => socket.to(data.target).emit("#answer", data));
    socket.on("#candidate", (data) => socket.to(data.target).emit("#candidate", data));
}
```

This is a pure relay — the server never interprets the WebRTC content, just forwards to the target socket ID.

---

### 4. discord-clone changes (consequence of above)

These are the caller-side changes that become possible once the library is updated.

**socket.ts** — point to local rtc.io:
```json
"srtc.io-client": "file:../../rtc.io"
```

**meet/page.tsx** — replace custom emit with new unified emit:
```typescript
// Before (broken — RTCIOStream not serializable, and bypasses WebRTC)
const rtcioStream = new RTCIOStream(stream);
socket.emit("camera", { userId: currentUser.id, stream: rtcioStream, streamId: "main" });

// After (library intercepts, handles WebRTC internally)
const rtcioStream = new RTCIOStream("main", stream);
socket.emit("camera", { userId: currentUser.id, stream: rtcioStream, streamId: "main" });
```

**UserContext.tsx** — receive full reconstructed payload:
```typescript
// Before (relying on custom server relay, stream is RTCIOStream instance)
socket.on("camera", ({ userId, stream }) => { ... });

// After (stream is real MediaStream, full payload restored)
socket.on("camera", ({ userId, stream, streamId }) => {
    setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, streams: { ...u.streams, [streamId]: stream } } : u
    ));
});
```

Note: `userId` in the payload means no peerId→userId mapping is needed anymore.

**Server** — no custom event relay needed. The server doesn't need to know about "camera" at all:
```typescript
// Can be removed from server:
// socket.on("camera", (data) => socket.to(roomId).emit("camera", data));

// Server only needs:
addDefaultListeners(socket);  // handles #rtc-message, #stream-meta
socket.on("join-room", ...);  // existing room logic
```

---

## Data Flow Diagram (Complete)

```
Sender: socket.emit("camera", { userId: "A", stream: RTCIOStream, streamId: "main" })

1. emit() override detects RTCIOStream at key "stream"
   ├── sanitized = { userId: "A", streamId: "main" }
   └── streams   = [{ key: "stream", rtcStream }]

2. For each peer connection:
   rtcStream._handleStream(peerConn, peerId)
     → peerConn.addTransceiver(videoTrack, { direction:"sendonly", streams:[ms] })
     → peerConn.addTransceiver(audioTrack, { direction:"sendonly", streams:[ms] })
     → stored in rtcStream.videoTransceivers[peerId], rtcStream.audioTransceivers[peerId]

3. super.emit("#stream-meta", {
       source: myId, target: peerId,
       data: { streamId: ms.id, name: "camera", fieldKey: "stream",
               meta: { userId: "A", streamId: "main" } }
   })
   → Server relays to peer

4. super.emit("camera", { userId: "A", streamId: "main" })
   → Server receives and can relay to room (for any server-side logic)
   → Other clients receive { userId: "A", streamId: "main" } via socket.io
     (but this alone is NOT used to fire the "camera" listener)

─────────────────────────────────────────────────────────

Receiver: two async channels, reunited by mediaStream.id

Channel A — WebRTC track arrives (ontrack):
  stream.id = "xyz"
  → check streamNameMap["xyz"]
  → not yet → store pendingTracks["xyz"] = { peerId, stream }

Channel B — #stream-meta arrives:
  { streamId: "xyz", name: "camera", fieldKey: "stream",
    meta: { userId: "A", streamId: "main" } }
  → check pendingTracks["xyz"] → found!
  → emitStreamEvent("camera", "stream", meta, peerId, MediaStream)
     → payload = { userId: "A", streamId: "main", stream: MediaStream }
     → this.listeners("camera").forEach(cb => cb(payload))

OR (if #stream-meta arrives first):
  → store streamNameMap["xyz"] = { peerId, name:"camera", fieldKey:"stream", meta:{...} }
  → when ontrack fires → found → same emitStreamEvent call

─────────────────────────────────────────────────────────

socket.on("camera", ({ userId, stream, streamId }) => {
    // userId: "A", streamId: "main", stream: MediaStream ← real, live media
})
```

---

## Backward Compatibility

The `socket.stream(name, mediaStream)` API is fully preserved. When called, `sendStreamMeta` is called with `meta = null`. The receiver's `emitStreamEvent` falls through to the legacy path:

```typescript
// fieldKey: "stream", meta: null → legacy
payload = { id: peerId, stream: MediaStream }
```

Old `socket.on("main", ({ id, stream }) => {})` handlers continue to work unchanged.

---

## Edge Cases and Guards

| Scenario | Handling |
|----------|----------|
| `emit()` called before socket connects | `scheduleEmitStream` stores in `localEmitStreams`, dispatches when `initializeConnection` runs for each peer |
| New peer joins after stream already emitted | `initializeConnection` replays `localEmitStreams` to the new peer |
| `#stream-meta` arrives before WebRTC `ontrack` | Stored in `streamNameMap[streamId]` |
| `ontrack` fires before `#stream-meta` arrives | Stored in `pendingTracks[streamId]` |
| Same RTCIOStream emitted twice to same peer | `_handleStream` guard (add `if already exists → return`) prevents duplicate transceivers |
| Multiple RTCIOStream fields in one payload | `extractRTCIOStreams` returns all, each dispatched separately |
| RTCIOStream nested inside array or sub-object | Not intercepted — top-level keys only (by design, to avoid recursive complexity) |

---

## Files to Change

| File | Repo | Change |
|------|------|--------|
| `lib/rtc.ts` | rtc.io (client) | Override `emit()`, add helpers, update types |
| `lib/stream.ts` | rtc.io (client) | Add duplicate transceiver guard in `_handleStream` |
| `lib/defaulthandlers.ts` | srtc.io (server) | Add relay for `#rtc-message` and `#stream-meta` |
| `src/app/socket.ts` | discord-clone | Point to local rtc.io |
| `src/app/meet/page.tsx` | discord-clone | Use unified emit |
| `src/app/contexts/UserContext.tsx` | discord-clone | Update stream reception, remove duplicates |
| `src/components/MediaControls.tsx` | discord-clone | Use RTCIOStream methods, add try/catch |

---

## Open Questions Before Implementation

1. **`super.emit` vs EventEmitter emit**: `Socket.emit` in socket.io-client is overridden to send to server. When we call `super.emit` inside our overridden `emit`, does it go to the socket.io-client's `emit` (which sends to server) or the EventEmitter's emit? Need to verify the MRO — if `RootSocket.emit` also sends to server, we're fine. If the EventEmitter base's `emit` only fires local listeners, we need to call it differently for internal events.

2. **`this.listeners()` availability**: The current code already calls `this.listeners(name)` — this works because `@socket.io/component-emitter` exposes `listeners()`. Verify this method signature matches between `socket.io-client` versions.

3. **Server `#stream-meta` routing**: `#stream-meta` carries `target: peerId` (a specific socket id). The server relay `socket.to(data.target).emit(...)` routes to exactly that peer. This is correct for P2P but means the server must be running socket.io (not a pure SFU). This is the current assumption.

4. **`socket.io` "camera" event on receiver**: Once the library intercepts `emit`, the server still relays the stripped `{ userId, streamId }` payload as a "camera" event. The receiving client will get this via socket.io before the WebRTC stream arrives. Should the library suppress this intermediate event? Or should discord-clone simply not register a duplicate listener? Current plan: the stripped socket.io event is silently ignored on the receiver (the library doesn't auto-fire "camera" from it — only the WebRTC correlation path fires the listener).
