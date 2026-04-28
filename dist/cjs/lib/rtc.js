"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Socket = void 0;
const socket_io_client_1 = require("socket.io-client");
const stats_js_1 = require("./stats/stats.js");
const stream_1 = require("./stream");
const events_1 = require("./events");
const channel_1 = require("./channel");
const broadcast_channel_1 = require("./broadcast-channel");
/**
 * Deterministic hash of a channel name. Both peers compute the same id for the
 * same name, so we can use `negotiated: true` DataChannels without a polite/
 * impolite handshake.
 *
 * Range is [1, 1023] — id 0 is reserved for the ctrl channel. The upper bound
 * is set by Chromium's SCTP transport, which caps stream ids at 1023 (its
 * `kMaxSctpStreams = 1024`); creating a DataChannel with `id` outside this
 * range fails with `OperationError: RTCDataChannel creation failed`. Firefox
 * is more permissive but we pick the lowest common denominator.
 *
 * Hash collisions are detected per-peer and surface as a clear error to the
 * caller (see `_getOrCreateChannel`).
 */
function hashChannelName(name) {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) % 1023) + 1;
}
class Socket extends socket_io_client_1.Socket {
    constructor(io, nsp, opts) {
        var _a, _b;
        super(io, nsp, opts);
        // True once the first socket.io `connect` event has fired. Subsequent
        // `connect` events are reconnects, and we want to react to those (nudge
        // stuck peers) rather than the initial handshake.
        this._signalingConnectedOnce = false;
        // Serializes signaling per peer — prevents concurrent messages from interleaving async steps.
        // `.finally` detaches the chain when this is the tail so the per-peer entry can be GCd
        // instead of growing without bound for long-lived peers.
        this.enqueueSignalingMessage = (payload) => {
            var _a;
            const peerId = payload.source;
            const prev = (_a = this.signalingQueues[peerId]) !== null && _a !== void 0 ? _a : Promise.resolve();
            const current = prev
                .then(() => this.handleCallServiceMessage(payload))
                .catch((err) => {
                this.log('error', 'Signaling error', { peer: peerId, err });
            })
                .finally(() => {
                if (this.signalingQueues[peerId] === current) {
                    delete this.signalingQueues[peerId];
                }
            });
            this.signalingQueues[peerId] = current;
        };
        this.addTransceiverToPeer = (peer, rtcioStream) => {
            const streamMsId = rtcioStream.mediaStream.id;
            this.log('debug', 'addTransceiverToPeer', {
                peer: peer.socketId,
                rtcioStreamId: rtcioStream.id,
                mediaStreamId: streamMsId,
                trackCount: rtcioStream.mediaStream.getTracks().length,
            });
            // Store the stream reference even if it has no tracks
            peer.streams[streamMsId] = rtcioStream;
            // Initialise transceiver list for this stream if needed
            if (!peer.streamTransceivers[streamMsId]) {
                peer.streamTransceivers[streamMsId] = [];
            }
            // Listen for track changes on this stream (e.g. user swaps mic/cam mid-call).
            // The same-kind swap path uses RTCRtpSender.replaceTrack and does NOT change
            // transceiver direction, which is the WebRTC primitive for hot-swapping a
            // track with no SDP renegotiation. Toggling direction (sendonly→inactive→
            // sendonly) would also work but would round-trip an unnecessary offer/answer
            // and briefly mute the receiver.
            rtcioStream.onTrackChanged((stream) => {
                var _a;
                const tracks = stream.getTracks();
                const trackById = new Map(tracks.map(t => [t.id, t]));
                const ownTransceivers = (_a = peer.streamTransceivers[streamMsId]) !== null && _a !== void 0 ? _a : [];
                const claimed = new Set();
                // Pass 1: keep already-wired transceivers as-is.
                ownTransceivers.forEach(t => {
                    const senderTrack = t.sender.track;
                    if (senderTrack && trackById.has(senderTrack.id)) {
                        claimed.add(senderTrack.id);
                    }
                });
                // Pass 2: rewire transceivers whose sender track was removed.
                //   - If a same-kind replacement exists in the stream, hot-swap via
                //     replaceTrack (no renegotiation).
                //   - Otherwise mark the transceiver inactive (renegotiates) so the
                //     remote stops expecting media on this m-line.
                ownTransceivers.forEach(t => {
                    var _a, _b;
                    const senderTrack = t.sender.track;
                    if (senderTrack && trackById.has(senderTrack.id))
                        return;
                    const kind = (_a = senderTrack === null || senderTrack === void 0 ? void 0 : senderTrack.kind) !== null && _a !== void 0 ? _a : (_b = t.receiver.track) === null || _b === void 0 ? void 0 : _b.kind;
                    const replacement = tracks.find(tr => tr.kind === kind && !claimed.has(tr.id));
                    if (replacement) {
                        t.sender.replaceTrack(replacement);
                        if (t.direction !== 'sendonly')
                            t.direction = 'sendonly';
                        if (t.sender.setStreams)
                            t.sender.setStreams(rtcioStream.mediaStream);
                        claimed.add(replacement.id);
                    }
                    else if (senderTrack) {
                        t.sender.replaceTrack(null);
                        t.direction = 'inactive';
                    }
                });
                // Pass 3: brand-new tracks of a kind we don't have a transceiver for.
                tracks.forEach(track => {
                    if (claimed.has(track.id))
                        return;
                    const transceiver = peer.connection.addTransceiver(track, {
                        direction: 'sendonly',
                        streams: [rtcioStream.mediaStream],
                    });
                    peer.streamTransceivers[streamMsId].push(transceiver);
                    claimed.add(track.id);
                });
            });
            const tracks = rtcioStream.mediaStream.getTracks();
            if (tracks.length === 0) {
                // No tracks yet — nothing to negotiate. onTrackChanged will fire when
                // the user adds tracks later and wire up transceivers then.
                return;
            }
            tracks.forEach((track) => {
                {
                    // Reuse an unclaimed idle transceiver of the same kind to prevent accumulation.
                    const claimedTransceiverIds = new Set(Object.values(peer.streamTransceivers).flat().map(t => t.mid));
                    const idle = peer.connection.getTransceivers().find(t => {
                        var _a;
                        return t.sender.track === null
                            && ((_a = t.receiver.track) === null || _a === void 0 ? void 0 : _a.kind) === track.kind
                            && (t.direction === 'sendonly' || t.direction === 'sendrecv' || t.direction === 'inactive')
                            && !claimedTransceiverIds.has(t.mid);
                    });
                    if (idle) {
                        idle.sender.replaceTrack(track);
                        idle.direction = "sendonly";
                        // setStreams updates a=msid in SDP so the remote ontrack receives the correct stream id.
                        if (idle.sender.setStreams) {
                            idle.sender.setStreams(rtcioStream.mediaStream);
                        }
                        peer.streamTransceivers[streamMsId].push(idle);
                        this.log('debug', 'Reused idle transceiver', { kind: track.kind, peer: peer.socketId });
                    }
                    else {
                        const transceiver = peer.connection.addTransceiver(track, {
                            direction: "sendonly",
                            streams: [rtcioStream.mediaStream],
                        });
                        peer.streamTransceivers[streamMsId].push(transceiver);
                    }
                }
            });
        };
        /**
         * Creates peer connection
         * @returns {RTCPeerConnection} instance of RTCPeerConnection.
         */
        this.createPeerConnection = (payload, options) => {
            const peerConnection = new RTCPeerConnection(this.servers);
            const { source } = payload;
            this.rtcpeers[source] = {
                connection: peerConnection,
                streams: {},
                streamTransceivers: {},
                socketId: source,
                polite: options.polite,
                connectionStatus: {
                    makingOffer: false,
                    ignoreOffer: false,
                    isSettingRemoteAnswerPending: false,
                    negotiationNeeded: false,
                    negotiationInProgress: false,
                },
                ctrlDc: null,
                ctrlQueue: [],
                channels: {},
                channelIds: new Map(),
                connectFired: false,
                unhealthyTimer: null,
                peerLeftHintAt: 0,
            };
            const peer = this.rtcpeers[source];
            this.log('debug', `Created peer connection`, { peer: source, polite: options.polite });
            // All rtc.io channels are negotiated:true — we own the SCTP stream IDs, so
            // neither side should ever receive a DC via ondatachannel. Anything that
            // shows up here came from a non-rtc.io peer or a future feature; close it.
            peer.connection.ondatachannel = ({ channel: dc }) => {
                this.log('warn', 'Unexpected non-negotiated DataChannel — closing', {
                    peer: source, label: dc.label,
                });
                dc.close();
            };
            // Uses stream.onaddtrack for late-arriving tracks; creates a synthetic stream if streams[] is empty.
            peer.connection.ontrack = ({ transceiver, track, streams }) => {
                let stream = streams[0];
                // Handle empty streams array — create synthetic MediaStream
                if (!stream) {
                    stream = new MediaStream([track]);
                    this.log('warn', 'ontrack: no associated stream, created synthetic', {
                        peer: source, trackKind: track.kind, trackId: track.id,
                    });
                }
                if (!transceiver.mid)
                    return;
                this.log('debug', 'ontrack fired', {
                    peer: source, streamId: stream.id, trackKind: track.kind, mid: transceiver.mid,
                });
                // If we already have this stream, update it with the new track
                if (peer.streams[stream.id]) {
                    const existingStream = peer.streams[stream.id].mediaStream;
                    const existingTrack = existingStream.getTracks().find(t => t.kind === track.kind);
                    if (existingTrack && existingTrack.id !== track.id) {
                        existingStream.removeTrack(existingTrack);
                    }
                    if (!existingStream.getTrackById(track.id)) {
                        existingStream.addTrack(track);
                    }
                    this.listeners("track-added").forEach((listener) => {
                        listener({
                            peerId: source,
                            stream: existingStream,
                            track: track,
                        });
                    });
                    return;
                }
                const rtcioStream = new stream_1.RTCIOStream(stream);
                peer.streams[stream.id] = rtcioStream;
                // Handle tracks that arrive after the initial ontrack (e.g. video after audio).
                // Subscribed via the wrapper so RTCIOStream.dispose() (called from
                // cleanupPeer) detaches the listener — otherwise the closure would
                // pin `peer` and `source` for the lifetime of the underlying
                // MediaStream, which can outlive the peer if the app handed it to a
                // `<video>` element.
                rtcioStream.onTrackAdded((newTrack) => {
                    this.log('debug', 'Late track arrived via stream.onaddtrack', {
                        peer: source, kind: newTrack.kind, streamId: stream.id,
                    });
                    this.listeners("track-added").forEach((listener) => {
                        listener({
                            peerId: source,
                            stream: stream,
                            track: newTrack,
                        });
                    });
                });
                // Surface platform-driven track removals (remote peer stopped a
                // track or removed it from the stream) to app code as
                // `track-removed`. Like `track-added`, this only fires from
                // platform mutations — programmatic `stream.removeTrack` on the
                // local copy does not.
                rtcioStream.onTrackRemoved((oldTrack) => {
                    this.log('debug', 'Track removed by remote peer', {
                        peer: source, kind: oldTrack.kind, streamId: stream.id,
                    });
                    this.listeners("track-removed").forEach((listener) => {
                        listener({
                            peerId: source,
                            stream: stream,
                            track: oldTrack,
                        });
                    });
                });
                // Request event metadata for this stream
                const eventPayload = {
                    source: this.id,
                    target: source,
                    data: {
                        mid: stream.id,
                    },
                };
                this.emit(events_1.RtcioEvents.MESSAGE, eventPayload);
            };
            // connectionState aggregates ICE + DTLS — primary disconnect signal.
            // We use it (rather than iceConnectionState) for the watchdog because
            // it folds DTLS failures in, and the spec is more consistent across
            // browsers about the transitions out of 'connected'.
            peer.connection.onconnectionstatechange = () => {
                const state = peer.connection.connectionState;
                this.log('debug', `Connection state: ${state}`, { peer: source });
                switch (state) {
                    case "connected":
                        // Healthy again — discard any in-flight watchdog. NAT
                        // rebinding or an ICE restart can flip us back here from
                        // 'disconnected' or 'failed'; we honour that recovery.
                        this._clearUnhealthyTimer(peer);
                        break;
                    case "disconnected":
                        // Transient: ICE has stopped getting consent-freshness
                        // responses. Browsers usually self-heal within a few
                        // seconds. Arm the watchdog for the bounded grace window.
                        this._armUnhealthyTimer(peer, "ICE consent lost");
                        break;
                    case "failed":
                        // ICE has given up. Try one restart, then enforce the
                        // watchdog — if the restart never gets answered (peer is
                        // truly gone) we close the connection and tear down.
                        try {
                            peer.connection.restartIce();
                            this.log('debug', 'Connection failed — restarting ICE', { peer: source });
                        }
                        catch (e) {
                            this.log('warn', 'restartIce failed', { peer: source, e });
                        }
                        this._armUnhealthyTimer(peer, "ICE restart did not recover");
                        break;
                    case "closed":
                        this.cleanupPeer(source);
                        break;
                }
            };
            // iceConnectionState is a secondary signal: 'closed' here can fire
            // without a matching connectionstatechange in some Firefox versions,
            // so we also catch it as a cleanup trigger. The transient states
            // ('disconnected'/'failed') are handled exclusively by the
            // connectionState path above to avoid double-arming the watchdog.
            peer.connection.oniceconnectionstatechange = () => {
                this.log('debug', `ICE state: ${peer.connection.iceConnectionState}`, { peer: source });
                if (peer.connection.iceConnectionState === "closed") {
                    this.cleanupPeer(source);
                }
            };
            peer.connection.onicecandidate = async (event) => {
                if (event.candidate) {
                    const payload = {
                        source: this.id,
                        target: source,
                        data: {
                            candidate: event.candidate,
                        },
                    };
                    this.emit(events_1.RtcioEvents.MESSAGE, payload);
                }
            };
            // Coalesces rapid-fire onnegotiationneeded into a single offer round.
            peer.connection.onnegotiationneeded = async () => {
                peer.connectionStatus.negotiationNeeded = true;
                if (peer.connectionStatus.negotiationInProgress) {
                    this.log('debug', 'onnegotiationneeded coalesced (negotiation in progress)', { peer: source });
                    return;
                }
                // Yield so any synchronous addTransceiver calls in the same tick set the flag first.
                await Promise.resolve();
                while (peer.connectionStatus.negotiationNeeded) {
                    peer.connectionStatus.negotiationNeeded = false;
                    peer.connectionStatus.negotiationInProgress = true;
                    try {
                        peer.connectionStatus.makingOffer = true;
                        this.log('debug', 'onnegotiationneeded — creating offer', { peer: source });
                        await peer.connection.setLocalDescription();
                        this.emit(events_1.RtcioEvents.MESSAGE, {
                            target: peer.socketId,
                            source: this.id,
                            data: {
                                description: peer.connection.localDescription,
                            },
                        });
                        this.log('debug', 'Sent offer', { peer: source });
                    }
                    catch (error) {
                        this.log('error', `onnegotiationneeded error: ${error === null || error === void 0 ? void 0 : error.message}`, { peer: source });
                    }
                    finally {
                        peer.connectionStatus.makingOffer = false;
                        peer.connectionStatus.negotiationInProgress = false;
                    }
                }
            };
            // Built-in ctrl channel: negotiated:true so both polite and impolite sides
            // create it independently with the same id (0) — no DC-OPEN handshake, no
            // ondatachannel race, symmetric attach. Reserves SCTP stream id 0 for ctrl;
            // custom channels get ids in [1, 1023] from hashChannelName() (Chromium
            // caps SCTP streams at 1024, so the range matches the lowest common
            // browser ceiling).
            const ctrlDc = peer.connection.createDataChannel(events_1.CTRL_CHANNEL_LABEL, {
                negotiated: true,
                id: 0,
                ordered: true,
            });
            this._setupCtrlDc(ctrlDc, peer);
            return peer;
        };
        /**
         * Server-side peer-left hint handler. The signaling socket can drop
         * independently of the WebRTC connection (server crash or restart, mobile
         * data → wifi switch, signaling-only firewall change), so this is treated
         * as advisory rather than authoritative:
         *
         *   - If the WebRTC layer already reports the connection as unhealthy
         *     ('disconnected' or 'failed'), both signals agree and we clean up
         *     immediately.
         *   - Otherwise we record the hint timestamp. If the connection later
         *     goes unhealthy within the validity window, the watchdog uses the
         *     shortened grace period to clean up faster than ICE consent alone
         *     would. If the connection stays healthy, the hint is silently
         *     discarded — so a flaky signaling channel cannot tear down a
         *     working P2P call.
         */
        /**
         * Fires every time the socket.io transport reaches `connected` — including
         * reconnects after a drop. The first connect is just startup (no peers
         * exist yet); from the second one onward, we walk the peer table and kick
         * an ICE restart on anything that's currently `disconnected` or `failed`,
         * so the recovery offer rides the freshly-restored signaling channel
         * instead of a stale one from before the drop.
         *
         * The watchdog still owns the "give up" decision — this is a recovery
         * accelerator, not a teardown trigger.
         */
        this._handleSignalingConnect = () => {
            if (!this._signalingConnectedOnce) {
                this._signalingConnectedOnce = true;
                return;
            }
            this.log('debug', 'Signaling reconnected — nudging unhealthy peers');
            Object.values(this.rtcpeers).forEach((peer) => {
                const state = peer.connection.connectionState;
                if (state !== 'disconnected' && state !== 'failed')
                    return;
                try {
                    peer.connection.restartIce();
                    this.log('debug', 'Reconnect: restartIce on peer', {
                        peer: peer.socketId, state,
                    });
                }
                catch (e) {
                    this.log('warn', 'Reconnect: restartIce failed', {
                        peer: peer.socketId, e,
                    });
                }
            });
        };
        this._handlePeerLeftHint = (payload) => {
            const id = payload === null || payload === void 0 ? void 0 : payload.id;
            if (!id)
                return;
            const peer = this.rtcpeers[id];
            if (!peer)
                return;
            const state = peer.connection.connectionState;
            if (state === "closed")
                return;
            peer.peerLeftHintAt = Date.now();
            if (state === "disconnected" || state === "failed") {
                this.log('debug', 'peer-left hint + unhealthy P2P → cleanup now', {
                    peer: id, state,
                });
                try {
                    peer.connection.close();
                }
                catch (_a) { }
                this.cleanupPeer(id);
                return;
            }
            this.log('debug', 'peer-left hint received; deferring to WebRTC liveness', {
                peer: id, state,
            });
        };
        this.broadcastPeers = (cb, ...args) => {
            if (!this.connected)
                return;
            Object.values(this.rtcpeers).forEach((peer) => {
                cb.call(this, peer, ...args);
            });
        };
        this.servers = {
            iceServers: ((_a = opts === null || opts === void 0 ? void 0 : opts.iceServers) === null || _a === void 0 ? void 0 : _a.length)
                ? opts.iceServers
                : [{ urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] }],
        };
        this.rtcpeers = {};
        this.streamEvents = {};
        this.signalingQueues = {};
        this.debug = (_b = opts === null || opts === void 0 ? void 0 : opts.debug) !== null && _b !== void 0 ? _b : false;
        this._peerListeners = new Map();
        this._channelDefs = [];
        this._broadcastChannels = new Map();
        // Capture parent class methods so the user-facing `emit/on/off` overrides
        // don't shadow them for internal signaling and the `rtc.server.*` accessor.
        this._rawEmit = (ev, ...args) => super.emit(ev, ...args);
        this._rawOn = (ev, handler) => super.on(ev, handler);
        this._rawOff = (ev, handler) => super.off(ev, handler);
        this.on(events_1.RtcioEvents.INIT_OFFER, this.initializeConnection);
        this.on(events_1.RtcioEvents.MESSAGE, this.enqueueSignalingMessage);
        // The rtc.io-server fans this out to a leaving socket's rooms so peers
        // can short-circuit ICE consent-freshness (~30 s) when a tab closes.
        // We deliberately treat it as a hint: see _handlePeerLeftHint for why.
        this._rawOn(events_1.RtcioEvents.PEER_LEFT, this._handlePeerLeftHint);
        // Backwards-compatibility with servers that emit the older app-level
        // `user-disconnected` event (including the public server.rtcio.dev and
        // the rtc.io-server-example before this contract was promoted into
        // the library). Same hint semantics as PEER_LEFT.
        this._rawOn("user-disconnected", this._handlePeerLeftHint);
        // socket.io-client auto-reconnects with infinite retries by default
        // and buffers outgoing `emit` calls while disconnected, so most
        // signaling traffic survives a transient drop without library help.
        // Two cases need a nudge though:
        //  1. A peer transitioned to 'failed' while signaling was down. Its
        //     restartIce() ran locally but the resulting offer was buffered
        //     and won't reach the remote until reconnect. The remote's view
        //     can stay stuck in 'connected' across the gap (consent freshness
        //     hasn't fired yet) — meaning when our offer finally lands, both
        //     sides resume cleanly. Calling restartIce() again on reconnect
        //     guarantees a fresh attempt is in flight at the moment signaling
        //     is usable, instead of a stale one from before the drop.
        //  2. ICE candidates that were trickling out during the drop were
        //     buffered; restartIce() resets the candidate cycle so the
        //     remote isn't trying to apply candidates from a dead generation.
        // Initial connect is skipped — there are no peers to nudge yet.
        this._rawOn("connect", this._handleSignalingConnect);
    }
    log(level, msg, data) {
        var _a, _b;
        if (level === 'debug' && !this.debug)
            return;
        const prefix = `[rtc-io][${(_b = (_a = this.id) === null || _a === void 0 ? void 0 : _a.slice(-6)) !== null && _b !== void 0 ? _b : '------'}]`;
        console[level](`${prefix} ${msg}`, data !== null && data !== void 0 ? data : '');
    }
    emit(ev, ...args) {
        const stream = this.getRTCIOStreamDeep(args);
        if (stream) {
            this.log('debug', `emit stream event: ${ev}`, { streamId: stream.id });
            if (!this.streamEvents[stream.id]) {
                this.streamEvents[stream.id] = {};
            }
            this.streamEvents[stream.id][ev] = args;
            this.broadcastPeers(this.addTransceiverToPeer, stream);
        }
        else if (this._isInternalEvent(ev)) {
            // Library signaling — always over socket.io
            this._rawEmit(ev, ...args);
        }
        else {
            // User event — broadcast over the ctrl DataChannel to all peers.
            // Strip a trailing ack callback (socket.io idiom) — DataChannels
            // have no ack channel, so silently sending it would mislead users.
            let outArgs = args;
            if (typeof args[args.length - 1] === 'function') {
                this.log('warn', `emit('${ev}'): ack callbacks are not supported over peer transport — dropping callback`);
                outArgs = args.slice(0, -1);
            }
            this._broadcastCtrl(ev, outArgs);
        }
        return this;
    }
    /**
     * Drops a stream from the replay registry so peers connecting later won't
     * receive it.  Use this when a stream is being shut down (e.g. screen share
     * stopped) — without it, late joiners see the dead stream as if it were
     * still active because the library auto-replays registered streams.
     *
     * Already-connected peers are unaffected; signal them at the application
     * level (e.g. emit a `stop-share` event over the ctrl channel).
     */
    untrackStream(stream) {
        delete this.streamEvents[stream.id];
        return this;
    }
    /**
     * Socket.io escape hatch — events emitted/received here go straight through
     * the signaling server, bypassing all DataChannel routing.
     */
    get server() {
        return {
            emit: (ev, ...args) => {
                this._rawEmit(ev, ...args);
                return this;
            },
            on: (ev, handler) => {
                this._rawOn(ev, handler);
                return this;
            },
            off: (ev, handler) => {
                this._rawOff(ev, handler);
                return this;
            },
        };
    }
    /**
     * Targeted peer messaging.  Emits/receives over the ctrl DataChannel for one
     * specific peer, and creates named custom DataChannels to that peer.
     */
    peer(peerId) {
        return {
            emit: (ev, ...args) => {
                let outArgs = args;
                if (typeof args[args.length - 1] === 'function') {
                    this.log('warn', `peer('${peerId}').emit('${ev}'): ack callbacks not supported — dropping callback`);
                    outArgs = args.slice(0, -1);
                }
                this._sendCtrl(peerId, ev, outArgs);
            },
            on: (ev, handler) => this._addPeerListener(peerId, ev, handler),
            off: (ev, handler) => this._removePeerListener(peerId, ev, handler),
            createChannel: (name, options = {}) => this._getOrCreateChannel(peerId, name, options),
        };
    }
    /**
     * Creates (or returns) a broadcast DataChannel with the given name.  All
     * connected peers — and any peers that join later — share the same logical
     * channel, matched between sides by `name`.
     */
    createChannel(name, options = {}) {
        let bch = this._broadcastChannels.get(name);
        if (!bch) {
            bch = new broadcast_channel_1.RTCIOBroadcastChannel();
            this._broadcastChannels.set(name, bch);
            this._channelDefs.push({ name, options });
        }
        Object.values(this.rtcpeers).forEach((peer) => {
            const channel = this._getOrCreateChannel(peer.socketId, name, options);
            bch._addPeer(peer.socketId, channel);
        });
        return bch;
    }
    _isInternalEvent(ev) {
        return typeof ev === "string" && ev.startsWith(events_1.INTERNAL_EVENT_PREFIX);
    }
    getRTCIOStreamDeep(obj) {
        if (!obj || typeof obj !== "object")
            return;
        if (obj instanceof stream_1.RTCIOStream)
            return obj;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const result = this.getRTCIOStreamDeep(item);
                if (result)
                    return result;
            }
        }
        else {
            for (const key in obj) {
                const result = this.getRTCIOStreamDeep(obj[key]);
                if (result)
                    return result;
            }
        }
        return;
    }
    getPeer(id) {
        return this.rtcpeers[id];
    }
    // https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
    async handleCallServiceMessage(payload) {
        const { source } = payload;
        let isNewPeer = false;
        let peer = this.getPeer(source);
        if (!peer) {
            // Impolite side: stream replay deferred until after the initial offer/answer
            // to prevent onnegotiationneeded racing with setRemoteDescription. The ctrl
            // DC is created inside createPeerConnection as negotiated:true id:0, which
            // means both sides describe the same SCTP transport in their initial SDP —
            // no DC-OPEN handshake, no glare from the ctrl channel itself.
            peer = this.createPeerConnection(payload, { polite: false });
            isNewPeer = true;
            this.log('debug', 'Created impolite peer (deferred stream replay)', { peer: source });
        }
        const { description, candidate, mid, events } = payload.data;
        if (description) {
            this.log('debug', `Received ${description.type}`, { peer: source, signalingState: peer.connection.signalingState });
            const readyForOffer = !peer.connectionStatus.makingOffer &&
                (peer.connection.signalingState === "stable" ||
                    peer.connectionStatus.isSettingRemoteAnswerPending);
            const offerCollision = description.type === "offer" && !readyForOffer;
            peer.connectionStatus.ignoreOffer = !peer.polite && offerCollision;
            if (peer.connectionStatus.ignoreOffer) {
                this.log('debug', 'Ignoring colliding offer (impolite)', { peer: source });
                return;
            }
            peer.connectionStatus.isSettingRemoteAnswerPending =
                description.type === "answer";
            try {
                await peer.connection.setRemoteDescription(description);
            }
            catch (err) {
                // If the browser doesn't support implicit rollback, do it manually
                if ((err === null || err === void 0 ? void 0 : err.name) === 'InvalidStateError' && offerCollision) {
                    this.log('debug', 'Implicit rollback not supported, doing manual rollback', { peer: source });
                    await peer.connection.setLocalDescription({ type: "rollback" });
                    await peer.connection.setRemoteDescription(description);
                }
                else if (description.type === 'answer' &&
                    peer.connection.signalingState === 'stable') {
                    // Stale answer for a superseded offer — harmless, drop it.
                    this.log('debug', 'Dropping stale answer (already stable)', { peer: source });
                    return;
                }
                else {
                    this.log('warn', `setRemoteDescription failed (state: ${peer.connection.signalingState})`, { peer: source, err: err === null || err === void 0 ? void 0 : err.message });
                    return;
                }
            }
            finally {
                peer.connectionStatus.isSettingRemoteAnswerPending = false;
            }
            if (description.type === "offer") {
                await peer.connection.setLocalDescription();
                this.emit(events_1.RtcioEvents.MESSAGE, {
                    source: this.id,
                    target: peer.socketId,
                    data: {
                        description: peer.connection.localDescription,
                    },
                });
                this.log('debug', 'Sent answer', { peer: source });
            }
            // Defer so this handler finishes before onnegotiationneeded fires on stream replay.
            // Re-check peer membership inside the microtask: between scheduling and
            // execution, ICE could have failed and cleanupPeer() could have removed
            // this peer entry, leaving us replaying onto a closed RTCPeerConnection.
            if (isNewPeer) {
                queueMicrotask(() => {
                    if (this.rtcpeers[peer.socketId] === peer)
                        this.replayStreamsToPeer(peer);
                });
                queueMicrotask(() => {
                    if (this.rtcpeers[peer.socketId] === peer)
                        this._replayChannelsToPeer(peer);
                });
            }
        }
        else if (candidate) {
            try {
                await peer.connection.addIceCandidate(candidate);
            }
            catch (err) {
                if (!peer.connectionStatus.ignoreOffer)
                    throw err;
            }
        }
        else if (events) {
            const rtcioStream = peer.streams[mid];
            this.log('debug', 'Received stream events', { mid, events, hasStream: !!rtcioStream, peerStreamKeys: Object.keys(peer.streams) });
            if (!rtcioStream) {
                this.log('warn', 'Stream not found for events — stream not yet registered via ontrack', { mid, peerStreams: Object.keys(peer.streams) });
                return;
            }
            Object.keys(events).forEach((key) => {
                this.listeners(key).forEach((listener) => {
                    // Deserialize the full args array, then spread — mirrors how socket.io
                    // dispatches events and correctly handles multi-arg emits.
                    // .call(this) so once wrappers can call this.off() to unsubscribe.
                    const args = events[key].map((arg) => this.deserializeStreamEvent(arg, rtcioStream));
                    listener.call(this, ...args);
                });
            });
        }
        else if (mid) {
            const rtcioStream = peer.streams[mid];
            if (!rtcioStream) {
                this.log('warn', `Stream metadata request for unknown mid — peer may not have this stream yet`, {
                    mid, peer: source, peerStreams: Object.keys(peer.streams),
                    localStreamEvents: Object.keys(this.streamEvents),
                });
                return;
            }
            const events = this.streamEvents[rtcioStream.id];
            if (!events || Object.keys(events).length === 0) {
                // No events yet — sender will push them via replayStreamsToPeer when emit() is called.
                this.log('debug', 'No events for stream yet, skipping metadata response', { mid });
                return;
            }
            const payload = {
                source: this.id,
                target: peer.socketId,
                data: this.serializeStreamEvent({
                    mid,
                    events,
                }),
            };
            this.emit(events_1.RtcioEvents.MESSAGE, payload);
        }
    }
    replayStreamsToPeer(peer) {
        for (const streamKey in this.streamEvents) {
            const events = this.streamEvents[streamKey];
            const stream = this.getRTCIOStreamDeep(events);
            if (stream) {
                this.addTransceiverToPeer(peer, stream);
            }
        }
        this.log('debug', 'Replayed streams to peer', {
            peer: peer.socketId,
            streamCount: Object.keys(this.streamEvents).length,
        });
    }
    /** Polite path: initiates the offer and replays any local streams immediately. */
    initializeConnection(payload, options = { polite: true }) {
        try {
            const peer = this.createPeerConnection(payload, options);
            // Replay streams before channels: media is the primary use case, and
            // a per-channel failure (e.g. a future browser tightening SCTP id
            // rules) must not silently strand the peer without media.
            if (Object.keys(this.streamEvents).length > 0) {
                for (const streamKey in this.streamEvents) {
                    const events = this.streamEvents[streamKey];
                    const stream = this.getRTCIOStreamDeep(events);
                    if (stream) {
                        // always add the stream to the peer even if it has no tracks
                        this.addTransceiverToPeer(peer, stream);
                    }
                }
            }
            // Ctrl channel is now created inside createPeerConnection (negotiated:true),
            // so both polite and impolite paths get it without an asymmetric handshake.
            this._replayChannelsToPeer(peer);
            this.log('debug', `Initialized ${options.polite ? 'polite' : 'impolite'} peer`, { peer: payload.source });
        }
        catch (error) {
            this.log('error', 'initializeConnection failed', { error });
        }
        finally {
            return this.getPeer(payload.source);
        }
    }
    serializeStreamEvent(data) {
        if (data instanceof stream_1.RTCIOStream) {
            return data.toJSON();
        }
        try {
            if (Array.isArray(data)) {
                return data.map((item) => this.serializeStreamEvent(item));
            }
            if (data && typeof data === "object") {
                const out = {};
                for (const key in data) {
                    out[key] = this.serializeStreamEvent(data[key]);
                }
                return out;
            }
        }
        catch (err) {
            this.log('error', 'serializeStreamEvent failed', { err });
        }
        return data;
    }
    deserializeStreamEvent(data, rtcioStream) {
        if (typeof data === "string" && data.startsWith("[RTCIOStream]")) {
            const id = data.replace("[RTCIOStream] ", "");
            this.log('debug', 'ID-Sync between peers', { from: rtcioStream.id, to: id });
            rtcioStream.id = id; // ID-Sync between peers
            return rtcioStream;
        }
        if (data instanceof stream_1.RTCIOStream) {
            return data;
        }
        try {
            if (data && typeof data === "object") {
                for (const key in data) {
                    data[key] = this.deserializeStreamEvent(data[key], rtcioStream);
                }
            }
        }
        catch (err) {
            this.log('error', 'deserializeStreamEvent failed', { err });
        }
        return data;
    }
    // ─── Liveness watchdog ──────────────────────────────────────────────────
    /**
     * Armed when a peer's connectionState becomes 'disconnected' or 'failed'.
     * If the peer hasn't returned to 'connected' by the time the timer fires,
     * the connection is force-closed and `peer-disconnect` is emitted via
     * `cleanupPeer`. The grace window shortens when a recent server-side
     * peer-left hint corroborates that the peer is really gone.
     *
     * Re-arming clears any prior timer, so back-to-back state flips
     * (disconnected → failed) reset the budget rather than racing two timers.
     */
    _armUnhealthyTimer(peer, reason) {
        if (peer.unhealthyTimer)
            clearTimeout(peer.unhealthyTimer);
        const hintFresh = peer.peerLeftHintAt > 0 &&
            Date.now() - peer.peerLeftHintAt < Socket.PEER_LEFT_HINT_VALIDITY_MS;
        const ms = hintFresh
            ? Socket.UNHEALTHY_GRACE_WITH_HINT_MS
            : Socket.UNHEALTHY_GRACE_MS;
        this.log('debug', 'Arming liveness watchdog', {
            peer: peer.socketId, reason, ms, hintFresh,
        });
        peer.unhealthyTimer = setTimeout(() => {
            peer.unhealthyTimer = null;
            // Re-check current state — the connection may have recovered
            // after the timer was scheduled but before it fired.
            const state = peer.connection.connectionState;
            if (state === "connected" || state === "closed")
                return;
            this.log('warn', `Liveness watchdog: forcing peer close (${reason})`, {
                peer: peer.socketId, state,
            });
            try {
                // Closing transitions connectionState → 'closed', which
                // triggers the onconnectionstatechange handler above and runs
                // cleanupPeer. We also call cleanupPeer directly because some
                // browser/state combinations don't fire the state change after
                // an explicit close on an already-failed connection — and
                // cleanupPeer is idempotent so the duplicate is harmless.
                peer.connection.close();
            }
            catch (e) {
                this.log('warn', 'connection.close() threw during watchdog', {
                    peer: peer.socketId, e,
                });
            }
            this.cleanupPeer(peer.socketId);
        }, ms);
    }
    _clearUnhealthyTimer(peer) {
        if (peer.unhealthyTimer) {
            clearTimeout(peer.unhealthyTimer);
            peer.unhealthyTimer = null;
        }
    }
    cleanupPeer(peerId) {
        const peer = this.rtcpeers[peerId];
        if (!peer)
            return;
        this.log('debug', 'Cleaning up peer', { peer: peerId });
        this._clearUnhealthyTimer(peer);
        // Close ctrl channel + clear pre-open queue
        if (peer.ctrlDc &&
            peer.ctrlDc.readyState !== "closed" &&
            peer.ctrlDc.readyState !== "closing") {
            peer.ctrlDc.close();
        }
        peer.ctrlQueue.length = 0;
        // Close all custom channels for this peer
        Object.values(peer.channels).forEach((ch) => ch.close());
        // Detach RTCIOStream listeners on inbound streams so the wrapper does not
        // pin the closed peer's MediaStream listeners. The MediaStream itself may
        // outlive the peer if the app handed it to a `<video>` element.
        Object.values(peer.streams).forEach((s) => { var _a; return (_a = s.dispose) === null || _a === void 0 ? void 0 : _a.call(s); });
        // Notify all broadcast channels so they fire 'peer-left' and update their peer maps
        this._broadcastChannels.forEach((bch) => bch._removePeer(peerId));
        // Drop per-peer listener registry
        this._peerListeners.delete(peerId);
        peer.connection.close();
        delete this.rtcpeers[peerId];
        delete this.signalingQueues[peerId];
        // Only notify if the peer ever fully connected — otherwise apps using
        // the acquire-on-connect / release-on-disconnect pattern get a release
        // without a matching acquire (e.g. ICE failure before ctrl DC opens).
        if (peer.connectFired) {
            this.listeners("peer-disconnect").forEach((listener) => {
                listener({ id: peerId });
            });
        }
    }
    // ─── Channel matching ───────────────────────────────────────────────────
    /**
     * Returns the RTCIOChannel for (peerId, name), creating and attaching the
     * underlying negotiated DataChannel if needed. Both peers compute the same
     * SCTP stream id from the channel name, so attach is symmetric — there is
     * no polite/impolite branch and no ondatachannel race.
     *
     * For two-way communication the matching peer must also call
     * createChannel(name) (broadcast or per-peer); otherwise sends are
     * dropped at the remote SCTP layer.
     */
    _getOrCreateChannel(peerId, name, options) {
        const peer = this.rtcpeers[peerId];
        // Detached channel for unknown peer — user error; will never wire up.
        if (!peer)
            return new channel_1.RTCIOChannel(options.queueBudget);
        let channel = peer.channels[name];
        if (!channel) {
            channel = new channel_1.RTCIOChannel(options.queueBudget);
            peer.channels[name] = channel;
        }
        if (!channel._isAttached()) {
            const id = hashChannelName(name);
            const taken = peer.channelIds.get(id);
            if (taken && taken !== name) {
                throw new Error(`[rtc-io] Channel '${name}' hash-collides with existing channel '${taken}' on peer ${peerId} ` +
                    `(both names hash to SCTP id ${id}). Pick a different channel name.`);
            }
            peer.channelIds.set(id, name);
            const { queueBudget: _qb } = options, dcInit = __rest(options, ["queueBudget"]);
            const dc = peer.connection.createDataChannel(`${events_1.CUSTOM_CHANNEL_PREFIX}${name}`, Object.assign(Object.assign({}, dcInit), { negotiated: true, id }));
            channel._attach(dc);
        }
        return channel;
    }
    /**
     * Replays all registered broadcast channel defs onto a newly connected peer.
     * Both sides run this symmetrically: each side independently creates the
     * negotiated DC with the deterministic id from hashChannelName(name), so
     * no further signaling is needed.
     */
    _replayChannelsToPeer(peer) {
        var _a;
        for (const { name, options } of this._channelDefs) {
            // Isolate per channel — a single bad channel (hash collision, browser
            // SCTP-id rejection, etc.) must not abort replay of the rest, and
            // must not bubble up to the caller. The impolite path schedules this
            // in a queueMicrotask, so an unhandled throw there becomes an
            // uncaught exception with no way for the app to recover.
            try {
                const channel = this._getOrCreateChannel(peer.socketId, name, options);
                (_a = this._broadcastChannels.get(name)) === null || _a === void 0 ? void 0 : _a._addPeer(peer.socketId, channel);
            }
            catch (err) {
                this.log('error', `Failed to replay channel '${name}' to peer`, {
                    peer: peer.socketId, err,
                });
            }
        }
        if (this._channelDefs.length > 0) {
            this.log('debug', 'Replayed channels to peer', {
                peer: peer.socketId,
                channelCount: this._channelDefs.length,
            });
        }
    }
    // ─── Ctrl channel ───────────────────────────────────────────────────────
    _setupCtrlDc(dc, peer) {
        dc.binaryType = "arraybuffer";
        peer.ctrlDc = dc;
        dc.onopen = () => {
            this._flushCtrlQueue(peer);
            this.log('debug', 'Ctrl channel open', { peer: peer.socketId });
            // Fire 'peer-connect' to mirror the existing 'peer-disconnect' event.
            // This is the right hook for "send my state to the newly-connected peer"
            // — by now the peer entry exists and the ctrl DC can carry envelopes.
            this.listeners("peer-connect").forEach((listener) => {
                try {
                    listener({ id: peer.socketId });
                }
                catch (err) {
                    this.log("error", "peer-connect listener", err);
                }
            });
            peer.connectFired = true;
        };
        dc.onclose = () => {
            this.log('debug', 'Ctrl channel closed', { peer: peer.socketId });
            // Drop any pending envelopes — they have nowhere to go.
            peer.ctrlQueue.length = 0;
        };
        dc.onerror = (e) => {
            this.log('warn', 'Ctrl channel error', { peer: peer.socketId, e });
        };
        dc.onmessage = ({ data }) => {
            var _a, _b;
            if (typeof data !== "string")
                return;
            if (data.length > Socket.MAX_CTRL_ENVELOPE_BYTES) {
                this.log('warn', 'Ctrl: envelope exceeds max size, dropping', {
                    peer: peer.socketId, bytes: data.length,
                });
                return;
            }
            let envelope;
            try {
                envelope = JSON.parse(data);
            }
            catch (_c) {
                this.log('warn', 'Ctrl: invalid JSON envelope', { peer: peer.socketId });
                return;
            }
            const name = envelope.e;
            if (typeof name !== "string")
                return;
            // Security: a peer must not be able to spoof internal signaling
            // (#rtcio:*) or library lifecycle events (peer-connect, etc.) — those
            // are emitted only by the local Socket.
            if (name.startsWith(events_1.INTERNAL_EVENT_PREFIX) || events_1.RESERVED_EVENTS.has(name)) {
                this.log('warn', 'Ctrl: dropped reserved event from peer', { peer: peer.socketId, name });
                return;
            }
            const args = Array.isArray(envelope.d) ? envelope.d : [];
            // Global listeners (registered via rtc.on(name, handler))
            this.listeners(name).forEach((h) => {
                try {
                    h(...args);
                }
                catch (err) {
                    this.log('error', `Listener error [${name}]`, err);
                }
            });
            // Per-peer listeners (registered via rtc.peer(id).on(name, handler))
            (_b = (_a = this._peerListeners.get(peer.socketId)) === null || _a === void 0 ? void 0 : _a.get(name)) === null || _b === void 0 ? void 0 : _b.slice().forEach((h) => {
                try {
                    h(...args);
                }
                catch (err) {
                    this.log('error', `Peer listener error [${name}]`, err);
                }
            });
        };
    }
    _broadcastCtrl(name, args) {
        const envelope = JSON.stringify({ e: name, d: args });
        Object.values(this.rtcpeers).forEach((peer) => this._sendCtrlRaw(peer, envelope));
    }
    _sendCtrl(peerId, name, args) {
        const peer = this.rtcpeers[peerId];
        if (!peer)
            return;
        this._sendCtrlRaw(peer, JSON.stringify({ e: name, d: args }));
    }
    _sendCtrlRaw(peer, envelope) {
        const dc = peer.ctrlDc;
        const state = dc === null || dc === void 0 ? void 0 : dc.readyState;
        if (state === "open") {
            try {
                dc.send(envelope);
                return;
            }
            catch (e) {
                this.log('warn', 'Ctrl send failed, queueing', { peer: peer.socketId, e });
                this._enqueueCtrl(peer, envelope);
                return;
            }
        }
        // Channel is gone — buffering would be a leak with no recipient.
        if (state === "closing" || state === "closed") {
            this.log('warn', 'Ctrl DC closed, dropping message', { peer: peer.socketId });
            return;
        }
        // dc is null (not yet attached) or "connecting" — buffer for the open handler.
        this._enqueueCtrl(peer, envelope);
    }
    _enqueueCtrl(peer, envelope) {
        if (peer.ctrlQueue.length >= Socket.MAX_CTRL_QUEUE) {
            peer.ctrlQueue.shift();
            this.log('warn', 'Ctrl queue full, dropped oldest', { peer: peer.socketId });
        }
        peer.ctrlQueue.push(envelope);
    }
    _flushCtrlQueue(peer) {
        var _a;
        if (((_a = peer.ctrlDc) === null || _a === void 0 ? void 0 : _a.readyState) !== "open")
            return;
        while (peer.ctrlQueue.length > 0) {
            const envelope = peer.ctrlQueue.shift();
            try {
                peer.ctrlDc.send(envelope);
            }
            catch (e) {
                // Re-queue and stop; the channel will retry on next open or the connection is dying.
                peer.ctrlQueue.unshift(envelope);
                this.log('warn', 'Ctrl flush failed, will retry', { peer: peer.socketId, e });
                return;
            }
        }
    }
    // ─── Per-peer listener registry ─────────────────────────────────────────
    _addPeerListener(peerId, event, handler) {
        let map = this._peerListeners.get(peerId);
        if (!map) {
            map = new Map();
            this._peerListeners.set(peerId, map);
        }
        let list = map.get(event);
        if (!list) {
            list = [];
            map.set(event, list);
        }
        list.push(handler);
    }
    _removePeerListener(peerId, event, handler) {
        var _a;
        const list = (_a = this._peerListeners.get(peerId)) === null || _a === void 0 ? void 0 : _a.get(event);
        if (!list)
            return;
        const idx = list.indexOf(handler);
        if (idx !== -1)
            list.splice(idx, 1);
    }
    async getStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection) {
            return null;
        }
        const statsMap = new Map();
        return new Promise((resolve) => {
            peerConnection.getStats().then((stats) => {
                stats.forEach((report) => {
                    const { type } = report;
                    if (!statsMap.has(type)) {
                        statsMap.set(type, []);
                    }
                    statsMap.get(type).push({ report, description: type });
                });
                resolve(statsMap);
            });
        });
    }
    async getSessionStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return null;
        return await (0, stats_js_1.getRTCStats)(peerConnection, {});
    }
    async getIceCandidateStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return null;
        return await (0, stats_js_1.getRTCIceCandidateStatsReport)(peerConnection);
    }
}
exports.Socket = Socket;
// Bounded ctrl-channel buffer per peer. Drops oldest when full so a closed
// or slow peer can't pin unbounded memory in long-lived sessions.
Socket.MAX_CTRL_QUEUE = 1024;
// Cap inbound ctrl-channel envelope size before we attempt to parse it. A
// hostile peer could otherwise stream multi-megabyte JSON across multiple
// SCTP messages and pin our event loop in JSON.parse. 1 MB is well above
// any legitimate envelope (which carry user emit() args, not file data —
// bulk transfers go through `createChannel(...).send(buffer)`, which never
// hits this code path).
Socket.MAX_CTRL_ENVELOPE_BYTES = 1048576;
// Liveness watchdog windows. ICE consent freshness (RFC 7675) sends STUN
// binding requests every ~5 s and gives up after ~30 s, so the browser
// surfaces 'disconnected' within ~5–15 s of a peer disappearing and
// 'failed' a short while later. We use that as the trigger and add a
// bounded grace window for the connection to self-heal (NAT rebind, ICE
// restart) before we declare the peer dead and tear down.
Socket.UNHEALTHY_GRACE_MS = 12000;
// When the server has *also* told us the peer left, both signals agree the
// peer is most likely gone — shorten the grace window to clean up faster.
// A small budget remains so we don't tear down on a transient signaling
// flap that happened to coincide with a momentary ICE consent miss.
Socket.UNHEALTHY_GRACE_WITH_HINT_MS = 2500;
// How long a server-side peer-left hint stays "fresh" enough to shorten
// the watchdog. Beyond this, the hint is ignored on the assumption that
// we'd have observed the matching P2P trouble by now if it were real.
Socket.PEER_LEFT_HINT_VALIDITY_MS = 30000;
