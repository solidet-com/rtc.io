"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Socket = void 0;
const socket_io_client_1 = require("socket.io-client");
const stats_js_1 = require("./stats/stats.js");
const stream_1 = __importDefault(require("./stream"));
class Socket extends socket_io_client_1.Socket {
    constructor(io, nsp, opts) {
        var _a;
        super(io, nsp, opts);
        // Correlate stream.id → meta when #stream-meta arrives before ontrack
        this.streamNameMap = {};
        // Hold stream when ontrack fires before #stream-meta arrives
        this.pendingTracks = {};
        this.handleStreamMeta = (payload) => {
            const { source, data: { streamId, name, fieldKey = "stream", meta = null }, } = payload;
            const pending = this.pendingTracks[streamId];
            if (pending) {
                delete this.pendingTracks[streamId];
                this.emitStreamEvent(name, fieldKey, meta, source, pending.stream);
            }
            else {
                this.streamNameMap[streamId] = { peerId: source, name, fieldKey, meta };
            }
        };
        // ---------------------------------------------------------------------------
        // Public stream API (legacy — still supported)
        // ---------------------------------------------------------------------------
        this.stream = (name, mediaStream) => {
            this.localStreams[name] = mediaStream;
            if (!this.connected)
                return;
            Object.values(this.rtcpeers).forEach((peer) => {
                this.addTransceiverPeerConnection(peer.connection, mediaStream);
                this.sendStreamMeta(peer.socketId, name, "stream", mediaStream, null);
            });
        };
        this.servers = {
            iceServers: (_a = opts === null || opts === void 0 ? void 0 : opts.iceServers) !== null && _a !== void 0 ? _a : [
                {
                    urls: [
                        "stun:stun1.l.google.com:19302",
                        "stun:stun2.l.google.com:19302",
                    ],
                },
            ],
        };
        this.rtcpeers = {};
        this.localStreams = {};
        this.localEmitStreams = new Map();
        this.on("#init-rtc-offer", this.initializeConnection);
        this.on("#rtc-message", this.handleCallServiceMessage);
        this.on("#stream-meta", this.handleStreamMeta);
    }
    /**
     * Intercepts emit() calls. When the payload contains an RTCIOStream value,
     * the stream is routed over WebRTC (transceivers + #stream-meta signaling)
     * instead of being serialized over Socket.IO (which is impossible for
     * MediaStream). The event name and all non-stream fields are bundled into
     * #stream-meta so the receiver can reconstruct the full payload.
     *
     * Events starting with "#" are always forwarded to the server unchanged
     * (internal signaling events).
     */
    emit(event, ...args) {
        // Never intercept internal signaling events
        if (event.startsWith("#")) {
            return super.emit(event, ...args);
        }
        const [data] = args;
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
            const extracted = this.extractRTCIOStreams(data);
            if (extracted.streams.length > 0) {
                extracted.streams.forEach(({ key, rtcStream }) => {
                    this.scheduleEmitStream(event, key, rtcStream, extracted.sanitized);
                });
                // Do NOT forward to server — all metadata travels through
                // #stream-meta (unicast per peer). Forwarding the stripped payload
                // would cause the "camera" listener to fire twice on the receiver
                // (once with no stream, once with the real MediaStream).
                return this;
            }
        }
        return super.emit(event, ...args);
    }
    // ---------------------------------------------------------------------------
    // emit() intercept helpers
    // ---------------------------------------------------------------------------
    extractRTCIOStreams(data) {
        const streams = [];
        const sanitized = {};
        for (const [key, value] of Object.entries(data)) {
            if (value instanceof stream_1.default) {
                streams.push({ key, rtcStream: value });
            }
            else {
                sanitized[key] = value;
            }
        }
        return { sanitized, streams };
    }
    /**
     * Stores the stream for late-joining peers and dispatches it to all
     * currently connected peers.
     */
    scheduleEmitStream(eventName, fieldKey, rtcStream, meta) {
        // Keyed by event+field so a second emit("camera", ...) replaces the first
        const storeKey = `${eventName}:${fieldKey}`;
        this.localEmitStreams.set(storeKey, { rtcStream, eventName, fieldKey, meta });
        if (!this.connected)
            return;
        Object.values(this.rtcpeers).forEach((peer) => {
            this.dispatchEmitStreamToPeer(peer, eventName, fieldKey, rtcStream, meta);
        });
    }
    dispatchEmitStreamToPeer(peer, eventName, fieldKey, rtcStream, meta) {
        rtcStream._handleStream(peer.connection, peer.socketId);
        this.sendStreamMeta(peer.socketId, eventName, fieldKey, rtcStream.mediaStream, meta);
    }
    /**
     * Fires the local listeners registered via socket.on("camera", ...) with
     * the fully reconstructed payload. Does NOT send anything to the server.
     */
    emitStreamEvent(eventName, fieldKey, meta, peerId, stream) {
        // New path: { ...meta, [fieldKey]: MediaStream }
        // Legacy path (socket.stream()): { id: peerId, stream: MediaStream }
        const payload = meta !== null
            ? Object.assign(Object.assign({}, meta), { [fieldKey]: stream }) : { id: peerId, stream };
        this.listeners(eventName).forEach((listener) => listener(payload));
    }
    // ---------------------------------------------------------------------------
    // Peer connection management
    // ---------------------------------------------------------------------------
    getPeer(id) {
        return this.rtcpeers[id];
    }
    async handleCallServiceMessage(payload) {
        var _a;
        const { source } = payload;
        const peer = (_a = this.getPeer(source)) !== null && _a !== void 0 ? _a : this.initializeConnection(payload, { polite: false });
        if (!peer)
            return;
        const { description, candidate } = payload.data;
        if (description) {
            // Offer collision: we're already making an offer or not in stable state
            const offerCollision = description.type === "offer" &&
                (peer.connectionStatus.makingOffer ||
                    peer.connection.signalingState !== "stable");
            peer.connectionStatus.ignoreOffer = !peer.polite && offerCollision;
            if (peer.connectionStatus.ignoreOffer)
                return;
            // Drop stale answers that arrive after our local offer was rolled back
            // (e.g. polite peer rolled back offer_1 to accept remote offer_2, but
            // answer_1 still arrives in-flight).
            if (description.type === "answer" &&
                peer.connection.signalingState !== "have-local-offer") {
                return;
            }
            // Implicit rollback: setRemoteDescription atomically rolls back any
            // pending local offer before applying the remote description, eliminating
            // the race between an explicit Promise.all([rollback, SRD]) and an
            // in-flight createAnswer().
            await peer.connection.setRemoteDescription(description);
            if (description.type === "offer") {
                // setLocalDescription() with no args auto-creates the answer
                await peer.connection.setLocalDescription();
                this.emit("#rtc-message", {
                    source: this.id,
                    target: peer.socketId,
                    data: { description: peer.connection.localDescription },
                });
            }
        }
        else if (candidate) {
            try {
                await peer.connection.addIceCandidate(candidate);
            }
            catch (error) {
                if (!peer.connectionStatus.ignoreOffer)
                    throw error;
            }
        }
    }
    initializeConnection(payload, options = { polite: true }) {
        try {
            const peer = this.createPeerConnection(payload, options);
            // Replay socket.stream() streams to the new peer
            for (const [name, mediaStream] of Object.entries(this.localStreams)) {
                this.addTransceiverPeerConnection(peer.connection, mediaStream);
                this.sendStreamMeta(peer.socketId, name, "stream", mediaStream, null);
            }
            // Replay socket.emit() streams (with their full metadata) to new peer
            for (const { rtcStream, eventName, fieldKey, meta, } of this.localEmitStreams.values()) {
                this.dispatchEmitStreamToPeer(peer, eventName, fieldKey, rtcStream, meta);
            }
            return peer;
        }
        catch (error) {
            console.error(error);
            return undefined;
        }
    }
    addTransceiverPeerConnection(peerConnection, stream) {
        stream.getTracks().forEach((track) => {
            peerConnection.addTransceiver(track, {
                direction: "sendrecv",
                streams: [stream],
            });
        });
    }
    stopLocalStreamTracks(localStream) {
        localStream.getTracks().forEach((track) => track.stop());
    }
    createPeerConnection(payload, options) {
        const peerConnection = new RTCPeerConnection(this.servers);
        const { source } = payload;
        this.rtcpeers[source] = {
            connection: peerConnection,
            streams: {},
            socketId: source,
            polite: options.polite,
            emittedStreamIds: new Set(),
            connectionStatus: {
                makingOffer: false,
                ignoreOffer: false,
            },
        };
        const peer = this.rtcpeers[source];
        peer.connection.ontrack = ({ transceiver, streams: [stream] }) => {
            var _a;
            if (!stream)
                return;
            peer.streams[(_a = transceiver.mid) !== null && _a !== void 0 ? _a : transceiver.receiver.track.id] = stream;
            // ontrack fires once per track; deduplicate to emit once per stream
            if (peer.emittedStreamIds.has(stream.id))
                return;
            peer.emittedStreamIds.add(stream.id);
            const metaEntry = this.streamNameMap[stream.id];
            if (metaEntry) {
                delete this.streamNameMap[stream.id];
                this.emitStreamEvent(metaEntry.name, metaEntry.fieldKey, metaEntry.meta, source, stream);
            }
            else {
                // #stream-meta hasn't arrived yet — hold until it does
                this.pendingTracks[stream.id] = { peerId: source, stream };
            }
        };
        peer.connection.oniceconnectionstatechange = () => {
            var _a, _b;
            switch (peer.connection.iceConnectionState) {
                case "disconnected":
                    delete this.rtcpeers[source];
                    this.listeners("peer-disconnect").forEach((listener) => listener({ id: source }));
                    break;
                case "failed":
                    (_b = (_a = peer.connection).restartIce) === null || _b === void 0 ? void 0 : _b.call(_a);
                    break;
                case "closed":
                    delete this.rtcpeers[source];
                    break;
                default:
                    break;
            }
        };
        peer.connection.onicecandidate = (event) => {
            if (event.candidate) {
                this.emit("#rtc-message", {
                    source: this.id,
                    target: source,
                    data: { candidate: event.candidate },
                });
            }
        };
        peer.connection.onnegotiationneeded = async () => {
            if (peer.connectionStatus.makingOffer)
                return;
            try {
                peer.connectionStatus.makingOffer = true;
                // setLocalDescription() without args auto-creates the offer
                await peer.connection.setLocalDescription();
                this.emit("#rtc-message", {
                    target: peer.socketId,
                    source: this.id,
                    data: { description: peer.connection.localDescription },
                });
            }
            catch (error) {
                console.error(error);
            }
            finally {
                peer.connectionStatus.makingOffer = false;
            }
        };
        return peer;
    }
    sendStreamMeta(targetId, name, fieldKey, stream, meta) {
        // Call super.emit to bypass our intercept and send directly to server
        super.emit("#stream-meta", {
            source: this.id,
            target: targetId,
            data: { streamId: stream.id, name, fieldKey, meta },
        });
    }
    // ---------------------------------------------------------------------------
    // Stats
    // ---------------------------------------------------------------------------
    async getStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return null;
        const statsMap = new Map();
        const stats = await peerConnection.getStats();
        stats.forEach((report) => {
            if (!statsMap.has(report.type))
                statsMap.set(report.type, []);
            statsMap.get(report.type).push({ report, description: report.type });
        });
        return statsMap;
    }
    async getSessionStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return null;
        return (0, stats_js_1.getRTCStats)(peerConnection, {});
    }
    async getIceCandidateStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return null;
        return (0, stats_js_1.getRTCIceCandidateStatsReport)(peerConnection);
    }
}
exports.Socket = Socket;
