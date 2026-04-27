# rtc.io

WebRTC peer-to-peer media and data channels with socket.io-style ergonomics.

```bash
npm install rtc.io rtc.io-server
```

`rtc.io` ships a browser client and a Node signaling server. The client extends `socket.io-client`, so if you already speak socket.io you'll feel at home — `io()`, `socket.emit`, `socket.on`. On top of that you get peer-to-peer media streams, broadcast and per-peer DataChannels, and built-in handling for the gnarly parts (perfect negotiation, ICE restarts, glare, transceiver reuse, flow control).

## Why rtc.io

- **WebRTC done right.** Perfect-negotiation pattern (W3C). Polite/impolite roles, stale-answer detection, manual rollback fallback for older browsers, automatic ICE restart on failure.
- **Socket.io ergonomics.** `socket.emit('chat', msg)` works like socket.io — but messages flow over a peer-to-peer DataChannel, not the server. Server stays a thin signaling relay.
- **Multiple channels per peer.** `socket.createChannel('telemetry', { ordered: false })` for unreliable, low-latency. `socket.peer(id).createChannel('rpc')` for one-to-one. Built-in flow control with high/low watermarks and a backpressure-aware queue.
- **Streams as first-class.** `socket.emit('camera', new RTCIOStream(mediaStream))` — replays to late joiners automatically. Toggle tracks at runtime; transceivers are reused, no orphan senders.
- **Broadcast channels.** One channel object, all peers, `peer-left` events, automatic cleanup. Like socket.io rooms but P2P.
- **No SDP wrangling.** You never see an offer, answer, or candidate.

## Quick start

### Server

```ts
// server.ts
import { Server } from "rtc.io-server";

const server = new Server({ cors: { origin: "*" } });

server.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }) => {
    socket.data.name = name;
    socket.join(roomId);
    // Tell every existing peer in the room to initiate an offer to the new one.
    socket.to(roomId).emit("#rtcio:init-offer", { source: socket.id });
  });
});

server.listen(3001);
```

### Client — basic peer connection

```ts
import io, { RTCIOStream } from "rtc.io";

const socket = io("http://localhost:3001", {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});

socket.server.emit("join-room", { roomId: "demo", name: "alice" });

// Get local media.
const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
socket.emit("camera", new RTCIOStream(local));

// Receive remote streams.
socket.on("camera", (stream: RTCIOStream) => {
  videoEl.srcObject = stream.mediaStream;
});

socket.on("peer-connect", ({ id }) => console.log("peer joined:", id));
socket.on("peer-disconnect", ({ id }) => console.log("peer left:", id));
```

### Per-peer messaging

```ts
socket.peer(peerId).emit("hello", { from: "alice" });
socket.peer(peerId).on("hello", (msg) => console.log(msg));
```

### Broadcast channel (every peer, ordered or unordered)

```ts
const chat = socket.createChannel("chat", { ordered: true });
chat.on("msg", (text: string) => console.log(text));
chat.emit("msg", "hi everyone");
```

### Custom DataChannel with backpressure

```ts
const file = socket.peer(peerId).createChannel("file", { ordered: true });

file.on("open", () => {
  // Send chunks; the channel will pause and emit 'drain' when full.
  for (const chunk of chunks) {
    if (!file.send(chunk)) {
      await new Promise((r) => file.once("drain", r));
    }
  }
});
```

## API surface

| API | Use |
|---|---|
| `io(url, opts)` | Create a Socket; opts include `iceServers` and any socket.io-client option |
| `socket.emit(ev, ...args)` | Broadcast over the ctrl DataChannel to all connected peers |
| `socket.on(ev, handler)` | Listen to events from any peer |
| `socket.peer(id).emit/on/off` | Targeted, per-peer messaging over the same ctrl channel |
| `socket.peer(id).createChannel(name, opts)` | Open a custom DataChannel to one peer |
| `socket.createChannel(name, opts)` | Broadcast DataChannel — every peer (and late joiners) shares it |
| `socket.server.emit/on` | Escape hatch to talk to the signaling server directly |
| `RTCIOStream(mediaStream)` | Wrap a MediaStream so it can be `emit`-ed and replayed to late joiners |
| `socket.untrackStream(stream)` | Stop replaying a stream to future peers (already-connected peers unaffected; signal them at app level) |
| `socket.getStats(id)`, `getSessionStats(id)`, `getIceCandidateStats(id)` | Per-peer WebRTC stats |

### Reserved events

These are emitted by the library and **filtered on receive** so peers can't spoof them:

- `peer-connect` — fires when a peer's ctrl DataChannel opens
- `peer-disconnect` — fires when a peer's connection is torn down (only after `peer-connect` fired)
- `track-added` — late-arriving track on an existing remote stream

Any event prefixed with `#rtcio:` is also reserved for internal signaling.

## How it compares

| | rtc.io | peerjs |
|---|---|---|
| Perfect negotiation (W3C) | ✅ | ⚠️ basic |
| Multiple channels per peer | ✅ | ⚠️ |
| Broadcast channel | ✅ | ❌ |
| DataChannel backpressure | ✅ high/low watermarks + queue | ❌ |
| Auto stream replay to late joiners | ✅ | ⚠️ manual |
| Typed events | ⏳ planned | ⚠️ partial |
| Signaling | self-host (any socket.io server) | self-host or hosted |
| Bundle size | ~60kB min+gzip with socket.io-client | smaller |

## Channel semantics

Custom channels (`createChannel`) use `negotiated:true` DataChannels with a deterministic SCTP stream id derived from the channel name. Both peers must call `createChannel(name)` for two-way communication — broadcast channels handle this automatically (every side that calls `socket.createChannel(name)` participates), per-peer channels need both ends to register.

If two channel names hash-collide on the same peer (rare; ~0.08% probability for under 100 names), `createChannel` throws a clear error naming both. Pick a different name.

## License

MIT
