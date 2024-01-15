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
        this.createPeerConnection = (payload) => {
            const peerConnection = new RTCPeerConnection(this.servers);
            const { source } = payload;
            this.rtcpeers[source] = {
                connection: peerConnection,
                mediaStream: new MediaStream(),
                socketId: source,
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
                        console.log("ice connection failed");
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
                        data: event.candidate,
                    };
                    console.log(payload);
                    this.emit("#candidate", payload);
                }
            };
            return peer;
        };
        this.stream = async (stream) => {
            if (!this.connected)
                return;
            if (this.localStream) {
                this.localStream.getTracks().forEach((track) => track.stop());
            }
            this.localStream = stream;
            Object.values(this.rtcpeers).forEach(async (peer) => {
                this._stream(peer);
                if (this.localStream) {
                    await this.createOffer({
                        source: peer.socketId,
                        target: this.id,
                        data: null,
                    });
                }
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
        this.createOffer = async (payload) => {
            var _a, _b;
            let peerConnection = (_a = this.rtcpeers[payload.source]) === null || _a === void 0 ? void 0 : _a.connection;
            peerConnection =
                peerConnection || ((_b = this.createPeerConnection(payload)) === null || _b === void 0 ? void 0 : _b.connection);
            if (!peerConnection)
                return;
            let offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            const _payload = {
                source: this.id,
                target: payload.source,
                data: offer,
            };
            this.emit("#offer", _payload);
        };
        this.rtcpeers = {};
        this.whippeers = {};
        this.on("#init-rtc-offer", this.createOffer);
        this.on("#offer", this.createAnswer);
        this.on("#answer", this.addAnswer);
        this.on("#candidate", this.addIceCandidate);
    }
    getPeer(id) {
        return this.rtcpeers[id];
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
    async addIceCandidate(payload) {
        var _a;
        const peerConnection = (_a = this.getPeer(payload.source)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return;
        console.log("adding ice candidate");
        console.log(payload);
        if (payload.data && payload.source != this.id) {
            await peerConnection
                .addIceCandidate(payload.data)
                .then(() => {
                console.log("ICE candidate added successfully");
            })
                .catch((e) => {
                console.error("Error adding received ICE candidate", e);
            });
        }
        else {
            console.warn("Empty ICE candidate received");
        }
    }
    getQueryParam(name = "room") {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name) || "";
    }
    async whip(api, roomName = this.getQueryParam()) {
        let pc = new RTCPeerConnection({
            iceServers: this.servers.iceServers,
            bundlePolicy: "balanced",
        });
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        this.whippeers[roomName] = {
            connection: pc,
            mediaStream: new MediaStream(),
        };
        const offer = pc.createOffer().then((offer) => {
            pc.setLocalDescription(offer);
            const remoteServer = `${api}/${roomName}`;
            console.log("Local SDP:", offer.sdp);
            fetch(remoteServer, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${roomName}`,
                    "Content-Type": "application/sdp",
                },
                body: offer.sdp,
            })
                .then((response) => response.json()) // Use response.text() instead of response.json()
                .then((response) => {
                console.log("Remote SDP:", response);
                pc.setRemoteDescription({
                    sdp: response.answer,
                    type: "answer",
                });
                return response;
            })
                .then((r) => {
                var _a;
                fetch(remoteServer, {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${roomName}`,
                        "Content-Type": "application/sdp",
                    },
                    body: (_a = pc.localDescription) === null || _a === void 0 ? void 0 : _a.sdp,
                });
            })
                .catch((error) => {
                console.error("Fetch error:", error);
            });
        });
        pc.addEventListener("iceconnectionstatechange", (event) => {
            if (pc.iceConnectionState === "connected" ||
                pc.iceConnectionState === "completed") {
                console.log("Peer connection established.");
                this.listeners("stream").forEach((listener) => {
                    var _a;
                    listener({
                        id: roomName,
                        stream: (_a = this.whippeers[roomName]) === null || _a === void 0 ? void 0 : _a.mediaStream,
                    });
                });
            }
            if (pc.iceConnectionState === "failed") {
                console.log("something failed");
                pc.restartIce();
            }
            console.log("SOMETING REGARDIN ICE HAPPENED");
            console.log(event);
        });
        pc.ontrack = (event) => {
            console.log("event geldii");
            console.log(event.track.kind);
            event.streams[0].getTracks().forEach((track) => {
                console.log(track);
                // Log track events
                track.onended = () => {
                    console.log("Video track ended:", track);
                    // Add any handling or cleanup logic here
                };
                track.onmute = () => {
                    console.log("Video track muted:", track);
                    // Add any handling or cleanup logic here
                };
                // Check if the track is added or removed
                if (event.track.readyState === "ended") {
                    console.log("Video track ended:", track);
                    // Add any handling or cleanup logic here
                }
                else {
                    this.whippeers[roomName].mediaStream.addTrack(track);
                }
            });
        };
    }
    async addAnswer(payload) {
        const peer = this.getPeer(payload.source);
        if (!peer)
            return;
        if (!(peer === null || peer === void 0 ? void 0 : peer.connection.currentRemoteDescription)) {
            peer.connection.setRemoteDescription(payload.data);
        }
    }
    async createAnswer(payload) {
        let peer = this.rtcpeers[payload.source];
        peer = peer || this.createPeerConnection(payload);
        if (!(peer === null || peer === void 0 ? void 0 : peer.connection))
            return;
        await (peer === null || peer === void 0 ? void 0 : peer.connection.setRemoteDescription(payload.data));
        let answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        const _payload = {
            source: this.id,
            target: payload.source,
            data: answer,
        };
        this.emit("#answer", _payload);
    }
}
exports.Socket = Socket;
