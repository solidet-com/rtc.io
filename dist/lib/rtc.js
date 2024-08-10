"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Socket = void 0;
const socket_io_client_1 = require("socket.io-client");
const stats_js_1 = require("./stats/stats.js");
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
        this.createPeerConnection = (payload) => {
            const peerConnection = new RTCPeerConnection(this.servers);
            const { source } = payload;
            this.rtcpeers[source] = {
                connection: peerConnection,
                mediaStream: new MediaStream(),
                socketId: source,
                polite: true,
                connectionStatus: {
                    makingOffer: false,
                    ignoreOffer: false,
                    isSettingRemoteAnswerPending: false,
                    isActive: true,
                },
            };
            const peer = this.rtcpeers[source];
            this._stream(peer);
            peer.connection.ontrack = (event) => {
                event.streams[0].getTracks().forEach((track) => {
                    console.log("adding track to peer media stream", peer.mediaStream);
                    peer.mediaStream.addTrack(track);
                });
            };
            peer.connection.oniceconnectionstatechange = () => {
                switch (peer.connection.iceConnectionState) {
                    case "connected":
                        this.listeners("stream").forEach((listener) => {
                            listener({
                                id: source,
                                stream: peer.mediaStream,
                            });
                        });
                        break;
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
                    console.log(payload);
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
        this.stream = async (stream) => {
            var _a;
            if (!this.connected)
                return;
            (_a = this.localStream) === null || _a === void 0 ? void 0 : _a.getTracks().forEach((track) => track.stop());
            this.localStream = stream;
            Object.values(this.rtcpeers).forEach(async (peer) => {
                this._stream(peer);
            });
        };
        this._stream = (peer) => {
            var _a;
            (_a = this.localStream) === null || _a === void 0 ? void 0 : _a.getTracks().forEach((track) => {
                if (!peer.connection)
                    return;
                if (!this.localStream)
                    return;
                peer.connection.addTrack(track, this.localStream);
            });
        };
        this.rtcpeers = {};
        this.on("#init-rtc-offer", this.initializeConnection);
        this.on("#rtc-message", this.handleCallServiceMessage);
        /*
        this.on("#offer", this.createAnswer);
        this.on("#answer", this.addAnswer);
        this.on("#candidate", this.addIceCandidate);
        */
    }
    getPeer(id) {
        return this.rtcpeers[id];
    }
    async handleCallServiceMessage(payload) {
        const { source } = payload;
        let peer = this.getPeer(source);
        if (!peer)
            peer = this.initializeConnection(payload);
        console.log("== peer ==", peer);
        const { description, candidate } = payload.data;
        if (description) {
            const readyForOffer = !peer.connectionStatus.makingOffer &&
                (peer.connection.signalingState === "stable" ||
                    peer.connectionStatus.isSettingRemoteAnswerPending);
            const offerCollision = description.type === "offer" && !readyForOffer;
            peer.connectionStatus.ignoreOffer =
                !peer.polite && offerCollision;
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
                console.log("adding ice candidate", candidate);
                console.log(typeof candidate);
                await peer.connection.addIceCandidate(candidate);
            }
            catch (error) {
                if (!peer.connectionStatus.ignoreOffer)
                    throw error;
            }
        }
    }
    /**
     * Initializes the peer connection.
     */
    initializeConnection(payload) {
        try {
            const peer = this.createPeerConnection(payload);
            if (this.localStream)
                this.addTracksFromLocalStreamToPeerConnection(peer.connection, this.localStream);
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
        }
        finally {
            return this.getPeer(payload.source);
        }
    }
    /**
     * Attaches local media tracks to peer connection.
     */
    addTracksFromLocalStreamToPeerConnection(peerConnection, localStream) {
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });
    }
    /**
     * Stop local media tracks of peer connection.
     */
    stopLocalStreamTracks(localStream) {
        localStream.getTracks().forEach((track) => track.stop());
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
    getQueryParam(name = "room") {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name) || "";
    }
}
exports.Socket = Socket;
