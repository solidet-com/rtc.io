"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Socket = void 0;
const socket_io_client_1 = require("socket.io-client");
const stats_js_1 = require("./stats/stats.js");
const stream_1 = require("./stream");
class Socket extends socket_io_client_1.Socket {
    constructor(io, nsp, opts) {
        super(io, nsp, opts);
        this.servers = {
            iceServers: [
                {
                    urls: [
                        "stun:stun1.l.google.com:19302",
                        "stun:stun2.l.google.com:19302",
                    ],
                },
            ],
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
                socketId: source,
                polite: options.polite,
                connectionStatus: {
                    makingOffer: false,
                    ignoreOffer: false,
                    isSettingRemoteAnswerPending: false,
                    isActive: true,
                },
            };
            //webcam transceiver,
            //screen share transceiver
            const peer = this.rtcpeers[source];
            peer.connection.ontrack = ({ transceiver, streams: [stream] }) => {
                if (transceiver.mid) {
                    if (peer.streams[transceiver.mid])
                        return;
                    peer.streams[transceiver.mid] = new stream_1.RTCIOStream(stream);
                    const payload = {
                        source: this.id,
                        target: source,
                        data: {
                            mid: transceiver.mid,
                        },
                    };
                    this.emit("#rtc-message", payload);
                }
            };
            peer.connection.oniceconnectionstatechange = () => {
                switch (peer.connection.iceConnectionState) {
                    // case "connected":
                    // 	break;
                    case "disconnected":
                        this.listeners("peer-disconnect").forEach((listener) => {
                            listener({
                                id: source,
                            });
                        });
                        break;
                    case "failed":
                        if (peer.connection.restartIce) {
                            peer.connection.restartIce();
                        }
                        else {
                            //restartice
                        }
                        break;
                    case "closed":
                        console.log("ice connection closed");
                        break;
                    default:
                        break;
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
                    this.emit("#rtc-message", payload);
                }
            };
            peer.connection.onnegotiationneeded = async () => {
                if (peer.connection.signalingState === "have-remote-offer")
                    return;
                if (peer.connectionStatus.makingOffer) {
                    return;
                }
                try {
                    peer.connectionStatus.makingOffer = true;
                    const offer = await peer.connection.createOffer();
                    //@ts-ignore
                    if (peer.connection.signalingState !== "have-remote-offer") {
                        await peer.connection.setLocalDescription(offer);
                        this.emit("#rtc-message", {
                            target: peer.socketId,
                            source: this.id,
                            data: {
                                description: peer.connection.localDescription,
                            },
                        });
                    }
                }
                catch (error) {
                    // eslint-disable-next-line no-console
                    console.error(error);
                }
                finally {
                    peer.connectionStatus.makingOffer = false;
                }
            };
            return peer;
        };
        this.broadcastPeers = (cb, ...args) => {
            if (!this.connected)
                return;
            Object.values(this.rtcpeers).forEach((peer) => {
                cb(peer, ...args);
            });
        };
        this.rtcpeers = {};
        this.streamEvents = {};
        this.on("#init-rtc-offer", this.initializeConnection);
        this.on("#rtc-message", this.handleCallServiceMessage);
        /*
        this.on("#offer", this.createAnswer);
        this.on("#answer", this.addAnswer);
        this.on("#candidate", this.addIceCandidate);
        */
    }
    emit(ev, ...args) {
        const stream = this.getRTCIOStreamDeep(args);
        if (stream) {
            console.log("this.emit", ev, args);
            this.streamEvents[stream.id] = {
                [ev]: args,
            };
            this.broadcastPeers(this.addTransceiverToPeer, stream);
        }
        else {
            super.emit(ev, ...args);
        }
        return this;
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
    async handleCallServiceMessage(payload) {
        const { source } = payload;
        let peer = this.getPeer(source);
        if (!peer)
            peer = this.initializeConnection(payload, { polite: false });
        const { description, candidate, mid, events } = payload.data;
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
                    peer.connection.setLocalDescription({
                        type: "rollback",
                    }),
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
                    data: {
                        description: peer.connection.localDescription,
                    },
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
        else if (events) {
            const rtcioStream = peer.streams[mid];
            Object.keys(events).forEach((key) => {
                this.listeners(key).forEach((listener) => {
                    listener(this.deserializeStreamEvent(events[key], rtcioStream));
                });
            });
        }
        else if (mid) {
            const rtcioStream = peer.streams[mid];
            if (!rtcioStream)
                throw new Error(`Transceiver with mid ${mid} not found in peer ${source}`);
            const events = this.streamEvents[rtcioStream.id];
            if (!events)
                throw new Error("No events found for this stream");
            const payload = {
                source: this.id,
                target: source,
                data: {
                    mid,
                    events,
                },
            };
            this.emit("#rtc-message", payload);
        }
    }
    /**
     * Initializes the peer connection.
     */
    initializeConnection(payload, options = { polite: true }) {
        try {
            const peer = this.createPeerConnection(payload, options);
            for (const streamKey in this.streamEvents) {
                const events = this.streamEvents[streamKey];
                const stream = this.getRTCIOStreamDeep(events);
                this.addTransceiverToPeer(peer, stream);
            }
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
        }
        finally {
            return this.getPeer(payload.source);
        }
    }
    deserializeStreamEvent(data, rtcioStream) {
        if (typeof data === "string" && data.startsWith("[RTCIOStream]")) {
            const id = data.replace("[RTCIOStream] ", "");
            rtcioStream.id = id; // ID-Sync between peers
            return rtcioStream;
        }
        if (data && typeof data === "object") {
            for (const key in data) {
                data[key] = this.deserializeStreamEvent(data[key], rtcioStream);
            }
        }
        return data;
    }
    addTransceiverToPeer(peer, rtcioStream) {
        let transceiver;
        rtcioStream.mediaStream.getTracks().forEach((track) => {
            transceiver = peer.connection.addTransceiver(track, {
                direction: "sendrecv",
                streams: [rtcioStream.mediaStream],
            });
            if (transceiver === null || transceiver === void 0 ? void 0 : transceiver.mid) {
                peer.streams[transceiver.mid] = rtcioStream;
            }
        });
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
