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
                    // If we already have this stream, we need to update it with the new track
                    if (peer.streams[stream.id]) {
                        // Check if the track is already in the stream
                        const existingTrack = peer.streams[stream.id].mediaStream.getTracks().find(t => t.kind === transceiver.receiver.track.kind);
                        if (!existingTrack) {
                            // Add the new track to the existing stream
                            peer.streams[stream.id].mediaStream.addTrack(transceiver.receiver.track);
                        }
                        else {
                            // Replace the existing track with the new one
                            peer.streams[stream.id].mediaStream.removeTrack(existingTrack);
                            peer.streams[stream.id].mediaStream.addTrack(transceiver.receiver.track);
                        }
                        // Notify about track addition
                        this.listeners("track-added").forEach((listener) => {
                            listener({
                                peerId: source,
                                stream: peer.streams[stream.id].mediaStream,
                                track: transceiver.receiver.track
                            });
                        });
                        return;
                    }
                    peer.streams[stream.id] = new stream_1.RTCIOStream(stream);
                    const payload = {
                        source: this.id,
                        target: source,
                        data: {
                            mid: stream.id,
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
            /**
             * const videoYayini = new RTCIOStream(mediaStream);
             *
             * rtcio.emit('video-channel1', {streamer: 'mehmet', stream: videoYayini})
             * rtcio.emit('video-channel2', {streamer: 'mehmet', stream: videoYayini})
             *
             */
            // streamEvents: {
            // 	'47983749384739(videoyayini)': {
            // 		'video-channel': {streamer: 'mehmet', stream: 'ahmet' },
            // 		'video-channel2': {streamer: 'mehmet', stream: 'ahmet' },
            //  }
            // }
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
            const rtcioStream = peer.streams[mid]; //id asil idden farkli.!
            console.log("received events", events);
            Object.keys(events).forEach((key) => {
                this.listeners(key).forEach((listener) => {
                    const subEvents = events[key];
                    subEvents.forEach((subEvent) => {
                        listener(this.deserializeStreamEvent(subEvent, rtcioStream));
                    });
                });
            });
        }
        else if (mid) {
            const rtcioStream = peer.streams[mid];
            if (!rtcioStream)
                throw new Error(`Transceiver with mid ${mid} not found in peer ${source}`);
            const events = this.streamEvents[rtcioStream.id];
            if (!events) {
                this.streamEvents[rtcioStream.id] = {};
            }
            const payload = {
                source: this.id,
                target: peer.socketId,
                data: this.serializeStreamEvent({
                    mid,
                    events: this.streamEvents[rtcioStream.id],
                }),
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
            //  data channel to connect with even without media
            peer.connection.createDataChannel("connectionSetup");
            //  add transceivers if there are streams 
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
            // Broadcast existing streams to the new peer
            this.broadcastExistingStreams(peer);
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
        }
        finally {
            return this.getPeer(payload.source);
        }
    }
    broadcastExistingStreams(newPeer) {
        // Get all existing peers except the new one
        const existingPeers = Object.values(this.rtcpeers).filter(p => p.socketId !== newPeer.socketId);
        // For each existing peer, share their streams with the new peer
        existingPeers.forEach(existingPeer => {
            Object.values(existingPeer.streams).forEach(stream => {
                if (stream.mediaStream) {
                    // Add the stream to streamEvents if it doesn't exist
                    if (!this.streamEvents[stream.id]) {
                        this.streamEvents[stream.id] = {};
                    }
                    this.addTransceiverToPeer(newPeer, stream);
                }
            });
        });
    }
    serializeStreamEvent(data) {
        if (data instanceof stream_1.RTCIOStream) {
            return data.toJSON();
        }
        try {
            if (data && typeof data === "object") {
                for (const key in data) {
                    data[key] = this.serializeStreamEvent(data[key]);
                }
            }
        }
        catch (err) {
            console.error(data);
        }
        return data;
    }
    deserializeStreamEvent(data, rtcioStream) {
        if (typeof data === "string" && data.startsWith("[RTCIOStream]")) {
            const id = data.replace("[RTCIOStream] ", "");
            console.log("---- ID -- SYNC ----");
            console.log(rtcioStream.id);
            rtcioStream.id = id; // ID-Sync between peers
            console.log(rtcioStream.id);
            console.log("---- ID -- SYNC-END ----");
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
                //media streamin'id sini looplayacak konuma geliyor
            }
        }
        catch (err) {
            console.error(data);
        }
        return data;
    }
    addTransceiverToPeer(peer, rtcioStream) {
        let transceiver;
        // Store the stream reference even if it has no tracks
        peer.streams[rtcioStream.mediaStream.id] = rtcioStream;
        rtcioStream.onTrackChanged((stream) => {
            const tracks = stream.getTracks();
            tracks.forEach(track => {
                const existingTransceiver = Array.from(peer.connection.getTransceivers()).find(t => t.sender.track && t.sender.track.kind === track.kind);
                if (existingTransceiver) {
                    existingTransceiver.sender.replaceTrack(track);
                }
                else {
                    peer.connection.addTransceiver(track, {
                        direction: "sendrecv",
                        streams: [rtcioStream.mediaStream],
                    });
                }
            });
            // Force negotiation if needed
            if (peer.connection.signalingState === "stable") {
                peer.connection.dispatchEvent(new Event('negotiationneeded'));
            }
        });
        const tracks = rtcioStream.mediaStream.getTracks();
        if (tracks.length === 0) {
            transceiver = peer.connection.addTransceiver('audio', {
                direction: "sendrecv"
            });
            if (peer.connection.signalingState === "stable") {
                peer.connection.dispatchEvent(new Event('negotiationneeded'));
            }
            return;
        }
        tracks.forEach((track) => {
            //  if user has sent an audio or video stream
            if (track.kind === 'audio' || track.kind === 'video') {
                transceiver = peer.connection.addTransceiver(track, {
                    direction: "sendrecv",
                    streams: [rtcioStream.mediaStream],
                });
                peer.streams[rtcioStream.mediaStream.id] = rtcioStream;
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
