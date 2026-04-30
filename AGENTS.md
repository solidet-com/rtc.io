# AGENTS.md — rtc.io

Guidance for AI coding agents working with the **rtc.io** WebRTC library. This file is the source of truth for *how the library is meant to be used*, the *patterns it expects*, and the *anti-patterns to avoid*. If you are an LLM that just landed in a project that depends on `rtc.io`, read this in full before generating code.

> **Identity note.** `rtc.io` is the npm package name. The project's home is **`rtcio.dev`** — docs at `docs.rtcio.dev`, live demo at `rtcio.dev`, source at `github.com/solidet-com/rtc.io`. The `rtc.io` web domain is a separate, older project unrelated to this library; don't confuse the two when fetching references.

---

## What rtc.io is — in one sentence

A browser WebRTC client (and matching Node signaling server, `rtc.io-server`) that exposes peer-to-peer media and data channels through the `socket.io` `emit`/`on` API, with perfect-negotiation, ICE restart, transceiver reuse, glare resolution, and DataChannel backpressure handled internally.

If you find yourself reading the WebRTC spec to make rtc.io do something, you are almost certainly going off the supported path.

---

## Mental model

There are **three transports** the user can talk over:

| Transport | API on `socket` | Goes through | Use it for |
| --- | --- | --- | --- |
| **Signaling server** | `socket.server.emit / on` | socket.io to the server | Room join, presence, anything that needs the server (auth, persistence, queries) |
| **Ctrl DataChannel** (built-in, per peer) | `socket.emit / on` (broadcast), `socket.peer(id).emit / on` (targeted) | Negotiated DC id 0, P2P, ordered + reliable | Small JSON-shaped events: chat, presence, mute state, RPC handshakes |
| **Custom DataChannel** | `socket.createChannel(name, opts)` (broadcast) or `socket.peer(id).createChannel(name, opts)` (per-peer) | Negotiated DC, hashed SCTP id, P2P | Anything you'd want a separate stream for — files, telemetry, unreliable game state, large JSON |

**Media** is its own thing: `socket.emit('event', new RTCIOStream(mediaStream))`. The library detects the `RTCIOStream` payload, attaches transceivers, and replays the stream to anyone who joins later until you call `socket.untrackStream(stream)`.

The signaling server (`rtc.io-server`) is just a thin socket.io extension. Once peers connect, *everything* — chat, files, signaling for new peers — flows over P2P. The server does not see your application data.

---

## Core API surface

Every method below is on the `Socket` returned by `io(url, opts)`.

### Construction

```ts
import io from "rtc.io";

const socket = io("https://signaling.example.com", {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  // any socket.io-client option also accepted
  debug: false, // turn on for verbose internal logging
});
```

### Broadcast emit/on (all peers)

```ts
socket.emit("chat", { from: socket.id, text: "hi" });
socket.on("chat", (msg) => { ... });
```

### Per-peer emit/on/createChannel

```ts
socket.peer(peerId).emit("rpc:request", { id: 1, method: "echo", params: ["hi"] });
socket.peer(peerId).on("rpc:response", (res) => { ... });
const file = socket.peer(peerId).createChannel("file", { ordered: true });
```

### Broadcast custom channel (every peer, late joiners auto-included)

```ts
const chat = socket.createChannel("chat", { ordered: true });
chat.emit("msg", text);
chat.on("msg", (text) => { ... });
chat.on("peer-left", (peerId) => { ... });
```

### Streams

```ts
const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const stream = new RTCIOStream(local);
socket.emit("camera", stream);

// Later: stop replaying to future peers
socket.untrackStream(stream);

// Receive
socket.on("camera", (remote: RTCIOStream) => {
  videoEl.srcObject = remote.mediaStream;
});

// Hot-swap a track without renegotiation
const newCam = (await navigator.mediaDevices.getUserMedia({ video: { deviceId } })).getVideoTracks()[0];
const old = stream.replaceTrack(newCam);
old?.stop();
```

### Streams + arbitrary metadata

`socket.emit` deep-walks the args looking for any `RTCIOStream`. The rest of the payload is preserved verbatim, so you can ship app-level metadata alongside the stream in the same emit — no separate ctrl event needed:

```ts
// ✅ Works — the library finds the RTCIOStream nested inside the object
socket.emit("stream", {
  screen: new RTCIOStream(displayStream),
  metadata: { userId: "abc123", displayName: "Alice", dummyKey:"dummyData"},
});



### Server escape hatch

```ts
socket.server.emit("join-room", { roomId: "demo", name: userName });
socket.server.on("user-connected", ({ id }) => { ... });
```

### Stats (per-peer)

```ts
const stats = await socket.getStats(peerId);            // raw RTCStatsReport, grouped by type
const session = await socket.getSessionStats(peerId);   // bitrate / RTT / loss summary
const ice = await socket.getIceCandidateStats(peerId);  // candidate-pair info
```

### Reserved events

These fire from the library itself and are **filtered on receive** so peers cannot spoof them. Do not emit them from your code.

| Event | Fires when | Args |
| --- | --- | --- |
| `peer-connect` | The ctrl DataChannel to a peer is open and usable | `{ id: peerId }` |
| `peer-disconnect` | A peer that previously fired `peer-connect` is being torn down | `{ id: peerId }` |
| `track-added` | A new track arrived on an *existing* remote stream | `{ peerId, stream, track }` |
| `track-removed` | A track was dropped from an *existing* remote stream | `{ peerId, stream, track }` |

Anything starting with `#rtcio:` is also reserved (internal signaling).

`peer-disconnect` only fires if `peer-connect` fired first. Apps that use the acquire-on-connect / release-on-disconnect pattern can rely on this — no spurious release without a matching acquire.

---

## Patterns to follow

### 1. Pick the right transport

| You want to | Use |
| --- | --- |
| Tell every peer something small | `socket.emit(ev, data)` |
| Tell one peer something small | `socket.peer(id).emit(ev, data)` |
| Open a sustained stream of bytes/messages to all peers | `socket.createChannel(name)` |
| Open a sustained stream of bytes/messages to one peer | `socket.peer(id).createChannel(name)` |
| Send video/audio | `socket.emit(ev, new RTCIOStream(media))` |
| Talk to the server (room join, auth, presence) | `socket.server.emit(...)` |

If you find yourself sending JSON over a custom channel for a one-off event, you probably want `socket.emit`. If you find yourself sending a 5 MB chunk via `socket.emit`, you probably want a custom channel.

### 2. Always wrap MediaStreams in `RTCIOStream`

```ts
// ✅ correct
socket.emit("screen", new RTCIOStream(screenStream));

// ❌ wrong — bypasses the library's transceiver mgmt and late-joiner replay
socket.emit("screen", screenStream);
```

A bare `MediaStream` will be JSON-serialised to `{}` and the receiver will get nothing useful.

### 3. Untrack streams when they end

Stopping the underlying tracks (`track.stop()`) does **not** stop replay to late joiners — the library still has a reference. Always pair with:

```ts
socket.untrackStream(stream);
```

Otherwise users joining after a screen share ended will see a dead stream attached for a few seconds.

### 4. Respect backpressure on big sends

```ts
const file = socket.peer(id).createChannel("file", { ordered: true });

for (const chunk of chunks) {
  if (!file.send(chunk)) {
    await new Promise((r) => file.once("drain", r));
  }
}
```

`channel.send()` returning `false` means the chunk was queued (or refused if the queue budget is exceeded — listen for `error` to detect that). Wait for `drain` before pushing more. The library will not protect you from filling the queue beyond `queueBudget`; that's your job.

**Three knobs, all per-channel:**

| Option | Default | Role |
|---|---|---|
| `queueBudget` | 1 MB | Hard cap on the JS-side queue (bytes held while the DC is connecting or above high-water). Exceeding fires `error`. |
| `highWatermark` | 16 MB | `bufferedAmount` threshold above which `send()` returns `false` and the library queues. |
| `lowWatermark` | 1 MB | `bufferedAmount` value at which `'drain'` fires. Wired to `RTCDataChannel.bufferedAmountLowThreshold`. |

All three are accepted by `createChannel`:

```ts
// Bulk LAN transfer — deeper pipeline, more memory, smoother throughput.
const bulk = socket.peer(id).createChannel("bulk", {
  ordered: true,
  queueBudget:   64 * 1024 * 1024,
  highWatermark: 64 * 1024 * 1024,
  lowWatermark:  16 * 1024 * 1024,
});

// Tight memory / latency-sensitive — pause early, drain fully.
const tight = socket.peer(id).createChannel("ctrl-stream", {
  highWatermark: 1 * 1024 * 1024,
  lowWatermark:  256 * 1024,
});
```

Constraint: `lowWatermark < highWatermark`, otherwise `'drain'` fires every send and the throttling defeats itself. The library doesn't enforce it.

### 5. Both ends of a per-peer custom channel must call `createChannel`

`createChannel` uses `negotiated:true` DataChannels with a deterministic SCTP id. If only one side calls it, packets vanish at the remote SCTP layer with no error.

`socket.createChannel(name)` (broadcast) handles this for you — every peer that has called it participates.

### 6. Clean up listeners on unmount / disconnect

The library does not magically detach app listeners. Mirror the React/Vue/Svelte pattern:

```ts
useEffect(() => {
  const onChat = (msg) => setMessages((m) => [...m, msg]);
  socket.on("chat", onChat);
  return () => socket.off("chat", onChat);
}, []);
```

### 7. Use `peer-connect` for "send my state to the new peer"

Don't rely on `connect` (socket.io connect) or `user-connected` (server event) — those fire before the DataChannels are open. Use `peer-connect`:

```ts
socket.on("peer-connect", ({ id }) => {
  socket.peer(id).emit("hello", { name: userName, mutedState });
});
```

### 8. Hot-swap tracks via `RTCIOStream.replaceTrack`

```ts
const newAudio = (await navigator.mediaDevices.getUserMedia({ audio: { deviceId } })).getAudioTracks()[0];
const oldAudio = rtcioStream.replaceTrack(newAudio);
oldAudio?.stop();
```

The library calls `RTCRtpSender.replaceTrack` on every peer — no SDP renegotiation, no audible glitch. Do **not** stop tracks on the original `MediaStream` and add new ones manually if you can avoid it; you'll trigger renegotiation rounds.

---

## Anti-patterns to avoid

| Anti-pattern | Why it's wrong | Do this instead |
| --- | --- | --- |
| Calling `new RTCPeerConnection()` directly | The library owns peer lifecycle | `socket.peer(id)` |
| `socket.server.emit("chat", msg)` for app messages | Round-trips through the server, defeats the point | `socket.emit("chat", msg)` |
| Emitting `peer-connect` / `peer-disconnect` / `track-added` / `track-removed` from app code | Reserved events; the library filters them on receive | Pick a different name |
| Looping `getStats` every 100 ms | Allocates RTCStatsReport per call | Poll on a 1–3 s interval |
| Recreating `socket = io(...)` on every render | Drops all connections | Create once at module scope (or in a `useRef`/`useState` initialiser) |
| Sending a `File` directly via `socket.emit` | Files JSON-serialise to `{}` | Read into `ArrayBuffer` chunks and send via `createChannel(name).send(buf)` |
| Manually building offers/answers/candidates | The library does this | Use `socket.emit` / `socket.peer(id).emit` |
| Forgetting `socket.off` on cleanup | Listener leak across re-mounts | Pair every `on` with an `off` |

---

## Internal channel layout

You almost never need to know this, but if you're debugging:

| SCTP stream id | Channel | Direction |
| --- | --- | --- |
| `0` | `rtcio:ctrl` (built-in ctrl channel) | both |
| `1..1023` | `rtcio:ch:<name>` (custom channels) | both — id = `FNV-1a(name) % 1023 + 1` |

Custom channel hash collisions are detected per peer and surface as a thrown `Error` from `createChannel` naming both names. Pick a different one.

The 1023 cap is set by Chromium's `kMaxSctpStreams = 1024`; Firefox is more permissive. We pick the lowest common denominator.

---

## Lifecycle quick reference

```
io(url, opts)
  → Socket.connected = true        (socket.io transport up)
  → server: emit("join-room", ...)
  → server: emits "#rtcio:init-offer" to existing peers
  → existing peers: createPeerConnection(polite: true) for new peer
  → new peer: createPeerConnection(polite: false) on first SDP
  → SDP/ICE flows over the signaling channel
  → ctrl DataChannel opens (negotiated id:0)
  → "peer-connect" fires
  → app emits / on / createChannel work
  → user emits stream → addTransceiver → ontrack on remote → "ev" fires with RTCIOStream
  → ICE failure → connection.restartIce() automatic, watchdog armed (12 s)
  → no recovery → watchdog forces close → "peer-disconnect" → cleanupPeer
```

## Disconnect detection

Peer departure is detected by a per-peer **liveness watchdog** in the library — not by socket signals alone. When `connectionState` becomes `disconnected` or `failed`, the watchdog arms for a bounded grace window (~12 s default). If the connection hasn't returned to `connected` by then, the peer is force-closed and `peer-disconnect` fires.

The signaling server may emit `#rtcio:peer-left` (the `rtc.io-server`'s `addDefaultListeners` does this automatically). The library treats this as a **hint** that's cross-checked against the local WebRTC state:

- Hint + already-unhealthy P2P → clean up immediately.
- Hint + still-healthy P2P → record the hint; do not tear down. The signaling socket can drop while the P2P connection over a TURN/STUN path stays alive (server crash, mobile data → wifi handoff). If the connection later goes unhealthy within ~30 s, the watchdog uses a shortened grace (~2.5 s) because both signals now agree.

App code should listen on `peer-disconnect` for cleanup; that's the contract. `socket.server.on('user-disconnected', ...)` remains useful for *application-level* concerns like presence rosters but should not be used for tearing down per-peer media/state — let the library decide when a peer is gone.

For *partial* departures — the peer stayed but stopped a track (e.g. ended a screen share, switched off camera) — listen on `track-removed`:

```ts
socket.on("track-removed", ({ peerId, stream, track }) => {
  if (track.kind === "video" && stream.getVideoTracks().length === 0) {
    hideVideoTile(peerId);
  }
});
```

The library wires this from `MediaStream`'s `removetrack` event, so it fires when the WebRTC stack drops the track from the remote stream — not when *you* mutate your local copy programmatically.

## Signaling reconnect

socket.io-client auto-reconnects by default (infinite retries, exponential backoff) and buffers `emit` calls during the outage. So if the signaling server is briefly unreachable, the library does the right thing without app intervention:

- **Existing P2P connections survive.** They run over STUN/TURN, not the signaling server. A signaling drop does not kill an in-progress call.
- **Buffered signaling flushes on reconnect.** Offers/answers/ICE candidates emitted during the outage land when the socket comes back.
- **Stuck peers are nudged.** On every reconnect after the first, the library calls `restartIce()` on any peer that's currently in `disconnected` or `failed`, so their recovery offer rides the freshly-restored signaling path instead of a stale one.
- **The peer-left hint is still authoritative-ish.** A `#rtcio:peer-left` that arrives after a long signaling outage still cross-checks WebRTC state — if the remote came back via NAT rebind and the connection is healthy, the hint is recorded but does not tear down.

What you may still want to handle yourself:

- **Re-joining the room.** socket.io's reconnect re-establishes the transport but does not replay your `join-room` emit. Many apps re-join on the `connect` event:

  ```ts
  socket.on("connect", () => socket.server.emit("join-room", { roomId, name }));
  ```

- **Stable identity across reconnects.** socket.io v4.6+ supports `connectionStateRecovery` on the server, which preserves `socket.id` across short drops. Without it, your reconnected client gets a new id; existing peers still see the old one until their watchdog expires. Use it for production deployments where reconnect churn matters.

---

## Common questions, in agent-friendly form

**Q: Where do I send a chat message?**
`socket.emit('chat', text)`. Listen with `socket.on('chat', handler)`.

**Q: How do I send a file?**
Per-peer custom channel + chunks + backpressure:

```ts
const ch = socket.peer(peerId).createChannel("file", { ordered: true });
ch.emit("meta", { name: file.name, size: file.size, mime: file.type });
const reader = file.stream().getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (!ch.send(value.buffer)) await new Promise((r) => ch.once("drain", r));
}
ch.emit("eof", {});
```

**Q: How do I share my screen?**
```ts
const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
const screen = new RTCIOStream(display);
socket.emit("screen", screen);

// On stop:
display.getTracks().forEach((t) => t.stop());
socket.untrackStream(screen);
socket.emit("screen-stopped");
```

**Q: How do I detect a new peer?**
`socket.on('peer-connect', ({ id }) => ...)`. Don't use the socket.io `connect` event — that fires when the socket reaches the server, not when a peer is reachable.

**Q: How do I detect a peer leaving?**
`socket.on('peer-disconnect', ({ id }) => ...)`. Fires only after `peer-connect` fired, so it always pairs.

**Q: How do I switch the camera mid-call?**
```ts
const ms = await navigator.mediaDevices.getUserMedia({ video: { deviceId } });
const oldVideo = rtcioStream.replaceTrack(ms.getVideoTracks()[0]);
oldVideo?.stop();
```
The library hot-swaps the sender track on every peer. No SDP renegotiation.

**Q: I emitted a stream, the receiver gets the event but `stream.mediaStream.getTracks()` is empty. Why?**
You probably called `track.stop()` on the source tracks before emitting, or the `MediaStream` lost its tracks (e.g. `getDisplayMedia` cancelled). Inspect `stream.mediaStream.active` and the track list before emit.

**Q: My `socket.peer(id).createChannel('foo')` opens but `emit` is silently dropped on the other side. Why?**
The other side did not also call `createChannel('foo')`. Per-peer custom channels are *not* automatically replayed; both ends must register. For the auto-replay behaviour, use `socket.createChannel(name)` (broadcast).

---

## Repo conventions

When generating code that uses rtc.io:

1. **TypeScript first.** Type peer ids as `string`, channel names as string literals where possible.
2. **No try/catch around `socket.emit`.** It does not throw on user error; it logs and drops. If you need delivery confirmation, the receiver should ack with `socket.peer(senderId).emit('ack', ...)`.
3. **No manual ack callbacks.** socket.io's ack callback (`emit('ev', data, cb)`) is silently dropped by `rtc.io` because DataChannels have no ack channel. The library logs a warning. Build acks at the application layer.
4. **Don't shim `RTCPeerConnection`.** If you need access for advanced stats, use `socket.getPeer(peerId).connection`, but treat it as read-only. Mutating its transceivers will fight the library.
5. **Server-side: socket.io idioms apply.** `rtc.io-server` extends `socket.io` — `socket.join(room)`, `io.to(room).emit(...)`, `socket.data.x = y`, all work as you'd expect.

---

## Where to look next

| Topic | File |
| --- | --- |
| Public API entry | `index.ts` |
| Socket class, perfect negotiation, ctrl channel, transceiver mgmt | `lib/rtc.ts` |
| Custom channel + backpressure | `lib/channel.ts` |
| Broadcast channel | `lib/broadcast-channel.ts` |
| RTCIOStream wrapper + track hot-swap | `lib/stream.ts` |
| Reserved event names | `lib/events.ts` |
| URL parsing (lifted from socket.io-client) | `lib/url.ts` |

For the user-facing docs, see `https://docs.rtcio.dev`. For the live demo (a full React video call), see `https://rtcio.dev`. Source for the demo lives at `https://github.com/solidet-com/rtc.io` under `rtcio-web/`.
