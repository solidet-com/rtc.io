"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Socket = void 0;
const socket_io_client_1 = require("socket.io-client");
const stats_js_1 = require("./stats/stats.js");
class Socket extends socket_io_client_1.Socket {
    constructor(io, nsp, opts) {
        var _a;
        super(io, nsp, opts);
        // Correlate stream.id → name when #stream-meta arrives before ontrack
        this.streamNameMap = {};
        // Hold stream when ontrack fires before #stream-meta arrives
        this.pendingTracks = {};
        this.handleStreamMeta = (payload) => {
            const { source, data: { streamId, name }, } = payload;
            const pending = this.pendingTracks[streamId];
            if (pending) {
                delete this.pendingTracks[streamId];
                this.listeners(name).forEach((listener) => {
                    listener({ id: source, stream: pending.stream });
                });
            }
            else {
                this.streamNameMap[streamId] = { peerId: source, name };
            }
        };
        this.stream = (name, mediaStream) => {
            this.localStreams[name] = mediaStream;
            if (!this.connected)
                return;
            Object.values(this.rtcpeers).forEach((peer) => {
                this.addTransceiverPeerConnection(peer.connection, mediaStream);
                this.sendStreamMeta(peer.socketId, name, mediaStream);
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
        this.on("#init-rtc-offer", this.initializeConnection);
        this.on("#rtc-message", this.handleCallServiceMessage);
        this.on("#stream-meta", this.handleStreamMeta);
    }
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
            const readyForOffer = !peer.connectionStatus.makingOffer &&
                (peer.connection.signalingState === "stable" ||
                    peer.connectionStatus.isSettingRemoteAnswerPending);
            const offerCollision = description.type === "offer" && !readyForOffer;
            peer.connectionStatus.ignoreOffer = !peer.polite && offerCollision;
            if (peer.connectionStatus.ignoreOffer)
                return;
            peer.connectionStatus.isSettingRemoteAnswerPending =
                description.type === "answer";
            if (offerCollision) {
                await Promise.all([
                    peer.connection.setLocalDescription({ type: "rollback" }),
                    peer.connection.setRemoteDescription(description),
                ]);
            }
            else {
                await peer.connection.setRemoteDescription(description);
            }
            peer.connectionStatus.isSettingRemoteAnswerPending = false;
            if (description.type === "offer") {
                const answer = await peer.connection.createAnswer();
                await peer.connection.setLocalDescription(answer);
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
            for (const name in this.localStreams) {
                const mediaStream = this.localStreams[name];
                this.addTransceiverPeerConnection(peer.connection, mediaStream);
                this.sendStreamMeta(peer.socketId, name, mediaStream);
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
                isSettingRemoteAnswerPending: false,
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
            const meta = this.streamNameMap[stream.id];
            if (meta) {
                delete this.streamNameMap[stream.id];
                this.listeners(meta.name).forEach((listener) => {
                    listener({ id: source, stream });
                });
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
                    this.listeners("peer-disconnect").forEach((listener) => {
                        listener({ id: source });
                    });
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
            if (peer.connection.signalingState === "have-remote-offer")
                return;
            if (peer.connectionStatus.makingOffer)
                return;
            try {
                peer.connectionStatus.makingOffer = true;
                const offer = await peer.connection.createOffer();
                await peer.connection.setLocalDescription(offer);
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
    sendStreamMeta(targetId, name, stream) {
        this.emit("#stream-meta", {
            source: this.id,
            target: targetId,
            data: { streamId: stream.id, name },
        });
    }
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
