# rtc.io

[![npm](https://img.shields.io/npm/v/rtc.io.svg?style=flat-square)](https://www.npmjs.com/package/rtc.io)
[![license](https://img.shields.io/npm/l/rtc.io.svg?style=flat-square)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-rtcio.dev-blue?style=flat-square)](https://docs.rtcio.dev)

WebRTC peer-to-peer media and data channels with socket.io-style ergonomics.

- 📦 [npm](https://www.npmjs.com/package/rtc.io) · 🐙 [GitHub](https://github.com/solidet-com/rtc.io) · 📖 [Docs](https://docs.rtcio.dev) · 🎬 [Live demo](https://rtcio.dev) · 🧠 [Why rtc.io](https://docs.rtcio.dev/why)
- Working with an LLM? Hand it [`AGENTS.md`](./AGENTS.md) — a single-file primer written for AI coding assistants.

```bash
npm install rtc.io rtc.io-server
```

`rtc.io` ships a browser client and a Node signaling server. The client extends `socket.io-client`, so if you already speak socket.io you'll feel at home — `io()`, `socket.emit`, `socket.on`. On top of that you get peer-to-peer media streams, broadcast and per-peer DataChannels, and built-in handling for the gnarly parts (perfect negotiation, ICE restarts, glare, transceiver reuse, flow control).

## What rtc.io gives you

- **Built on socket.io.** `socket.emit('chat', msg)` works exactly like socket.io — except the message rides a peer-to-peer DataChannel between browsers. Existing socket.io idioms (`io()`, `emit`, `on`, namespaces, the wire protocol) are unchanged because we extend the classes rather than re-implement them.
- **Perfect negotiation handled for you.** The W3C polite/impolite pattern, stale-answer detection, manual rollback for older browsers, automatic ICE restart on `connectionState === 'failed'`. You write `emit`/`on`; the SDP/ICE machinery never reaches your code.
- **Disconnect detection that doesn't lie.** A WebRTC liveness watchdog catches departed peers from ICE consent freshness, not from socket events alone — so a flaky signaling channel can't tear down a working P2P call. When the server *also* signals a peer-left, the watchdog tightens its window so tab-close cleanup is fast.
- **Multiple named channels per peer.** `socket.createChannel('telemetry', { ordered: false })` for unreliable low-latency, `socket.peer(id).createChannel('rpc')` for one-to-one, `socket.createChannel('chat')` for a broadcast every peer (including late joiners) shares. Built-in flow control with high/low watermarks and a backpressure-aware queue.
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


const local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const camera = new RTCIOStream(local);

socket.server.emit("join-room", { roomId: "demo", name: "alice" });
socket.emit("camera", camera);

// You can ship app-level metadata alongside the stream in the same emit.
// The library walks the args looking for any RTCIOStream and preserves
// the rest of the payload verbatim:
socket.emit("camera", {
  stream: camera,
  metadata: { displayName: "Alice", userId: "abc123" },
});

// Receive remote streams.
socket.on("camera", ({ stream, metadata }: { stream: RTCIOStream; metadata: { displayName: string; userId: string } }) => {
  videoEl.srcObject = stream.mediaStream;
  label.textContent = metadata.displayName;
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
const file = socket.peer(peerId).createChannel("file", {
  ordered: true,
  // All three knobs are per-channel and optional.
  queueBudget:   16 * 1024 * 1024,   // JS-side cap (default 1 MB)
  highWatermark: 16 * 1024 * 1024,   // pause threshold (default 16 MB)
  lowWatermark:   4 * 1024 * 1024,   // 'drain' fires at this level (default 1 MB)
});

file.on("open", () => {
  // Send chunks; the channel will pause and emit 'drain' when full.
  for (const chunk of chunks) {
    if (!file.send(chunk)) {
      await new Promise((r) => file.once("drain", r));
    }
  }
});
```

Defaults work for most apps. Lower `highWatermark` for tighter memory caps; raise it for fat-pipe LAN bulk transfers. Keep `lowWatermark` below `highWatermark` — otherwise `'drain'` fires on every send and the throttling collapses. See [Backpressure & flow control](https://docs.rtcio.dev/docs/guides/backpressure) for the tuning guide.

### Game streaming / high-motion video tuning

Default WebRTC encoder settings are tuned for talking-head video. On high-motion content (game streams, sports, fast screen-share) the encoder runs out of bitrate, falls back to `degradationPreference: 'balanced'`, and starts shedding FPS — which is exactly the wrong tradeoff for games. `RTCIOStream` accepts a one-shot config to fix that:

```ts
const display = await navigator.mediaDevices.getDisplayMedia({
  video: { frameRate: { ideal: 60, min: 30 }, width: 1920, height: 1080 },
  audio: true,
});

const game = new RTCIOStream(display, {
  videoEncoding: {
    contentHint: "motion",                    // tell the encoder this is high-motion content
    maxBitrate: 8_000_000,                    // 8 Mbps — set to ~70-80% of measured uplink
    maxFramerate: 60,
    degradationPreference: "maintain-framerate", // drop resolution before FPS under pressure
    priority: "high",                         // intra-PC scheduling
    networkPriority: "high",                  // DSCP marks where the network honours them
  },
  // Optional codec preference. VP9/AV1 cut bitrate ~30-50% vs VP8 at the same quality.
  codecPreferences: (caps, kind) => {
    if (kind !== "video") return caps;
    const order = ["video/VP9", "video/AV1", "video/VP8", "video/H264"];
    return order.flatMap(mime =>
      caps.filter(c => c.mimeType.toLowerCase() === mime.toLowerCase())
    );
  },
});

socket.emit("game", game);
```

The config applies to every peer — already-connected and late joiners. To react to network conditions at runtime without renegotiation, call `setEncoding`:

```ts
// Bandwidth alert: halve bitrate on every peer.
await game.setEncoding({ maxBitrate: 4_000_000 });

// User toggles between gameplay (motion) and stats overlay (detail).
await game.setEncoding({ contentHint: "detail", degradationPreference: "maintain-resolution" });
```

`setEncoding` calls [`RTCRtpSender.setParameters`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters) on every tracked sender — no offer/answer round trip.

`codecPreferences` is fixed at stream construction. Swapping codecs mid-stream requires renegotiation, which can disrupt audio on existing senders, so the supported pattern is to tear down the stream and create a fresh one with new options when the user picks a different codec.

To verify the tune is taking effect, poll [`getStats()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats) and watch `framesPerSecond`, `targetBitrate`, and `qualityLimitationReason` on the `outbound-rtp` report. `qualityLimitationReason: 'bandwidth'` means raise `maxBitrate` (or accept the cap); `'cpu'` means drop resolution, switch codec, or enable hardware encode.

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
| `RTCIOStream(mediaStream, opts?)` | Wrap a MediaStream so it can be `emit`-ed and replayed to late joiners. `opts` accepts `videoEncoding` (maxBitrate, maxFramerate, degradationPreference, contentHint, priority, networkPriority, scaleResolutionDownBy) and `codecPreferences(caps, kind)` for codec selection |
| `stream.setEncoding(partial)` | Update sender-side encoding params at runtime across every peer — no renegotiation |
| `stream.replaceTrack(track)` | Hot-swap a same-kind track (mic/cam picker, mute → unmute reacquire) via `RTCRtpSender.replaceTrack` on every peer — no SDP renegotiation |
| `socket.untrackStream(stream)` | Stop replaying a stream to future peers (already-connected peers unaffected; signal them at app level) |
| `socket.getStats(id)`, `getSessionStats(id)`, `getIceCandidateStats(id)` | Per-peer WebRTC stats |

### Reserved events

These are emitted by the library and **filtered on receive** so peers can't spoof them:

- `peer-connect` — fires when a peer's ctrl DataChannel opens
- `peer-disconnect` — fires when a peer's connection is torn down (only after `peer-connect` fired)
- `track-added` — late-arriving track on an existing remote stream
- `track-removed` — track was dropped from an existing remote stream (peer stopped a camera, ended a screen share, etc.)

Any event prefixed with `#rtcio:` is also reserved for internal signaling.

## Where it sits in the ecosystem

rtc.io is built **on top of** [socket.io](https://socket.io) — the client extends `socket.io-client`'s `Socket`, and `rtc.io-server` extends socket.io's `Server`. If you already use socket.io, rtc.io is additive: every existing `emit` / `on` / `namespace` / room idiom works unchanged, and rtc.io adds peer-to-peer media and DataChannels behind the same API. We're enormously grateful to the socket.io maintainers — that part of the work is theirs, not ours.

The other libraries we love and learned from each take a different shape:

- **[peerjs](https://peerjs.com)** — a lovely, friendly API that has introduced more developers to WebRTC than probably anything else. Built around one DataChannel + one media slot per connection, which is exactly right for many apps. If your app fits that shape, it's a great choice.
- **[simple-peer](https://github.com/feross/simple-peer)** — a clean, well-tested wrapper around `RTCPeerConnection` that hands you offers/answers/candidates and lets you transport them yourself. Excellent if you already have a signaling protocol you like.
- **[mediasoup](https://mediasoup.org), [LiveKit](https://livekit.io), Janus, Jitsi** — SFUs (Selective Forwarding Units). They terminate every stream on a server and forward it to subscribers. Right answer for 10+ person rooms, recording, server-side composition, simulcast, dial-in. rtc.io is happy to coexist with one in the same app.

We wrote rtc.io for a specific shape we kept building: small (≤ 8) groups of browsers that want **multiple named DataChannels** per peer (chat broadcast + cursor stream + file channel side-by-side), **streams that flow through the same emit/on as everything else**, **late-joiner replay as a default**, and **DataChannel backpressure built-in**. Those four were enough that we wanted them in the library rather than re-implemented in every app — so we wrote one. None of that means anything was wrong with the libraries above; it just means they were optimised for different shapes.

For a longer write-up of the use cases we built rtc.io for, see [Why rtc.io](https://docs.rtcio.dev/why).

## ⚠️ A note about the public signaling server

For prototyping, we host a free signaling server at `server.rtcio.dev`. **It's shared with everyone using rtc.io for demos and prototypes** — it has no authentication, no room ownership, and no notion of which app a connection came from. Anyone who joins a room with the same name will land in the same call, including strangers.

For prototyping, generate a hard-to-guess room id (a UUID, or 16+ random characters via `crypto.randomUUID()`). For anything you ship, [run your own server](https://docs.rtcio.dev/docs/server/quickstart) — it's an `npm install rtc.io-server` and a 30-line file. That gives you authentication, persistence, and full control over who joins what.

## Channel semantics

Custom channels (`createChannel`) use `negotiated:true` DataChannels with a deterministic SCTP stream id derived from the channel name. Both peers must call `createChannel(name)` for two-way communication — broadcast channels handle this automatically (every side that calls `socket.createChannel(name)` participates), per-peer channels need both ends to register.

If two channel names hash-collide on the same peer (rare; ~0.08% probability for under 100 names), `createChannel` throws a clear error naming both. Pick a different name.

## License

MIT
