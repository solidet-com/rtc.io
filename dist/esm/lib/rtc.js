import { Socket as RootSocket, } from "socket.io-client";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";
import { RTCIOStream } from "./stream";
import { RtcioEvents } from "./events";
export class Socket extends RootSocket {
    constructor(io, nsp, opts) {
        var _a, _b;
        super(io, nsp, opts);
        // Serializes signaling per peer — prevents concurrent messages from interleaving async steps.
        this.enqueueSignalingMessage = (payload) => {
            var _a;
            const peerId = payload.source;
            const prev = (_a = this.signalingQueues[peerId]) !== null && _a !== void 0 ? _a : Promise.resolve();
            this.signalingQueues[peerId] = prev.then(() => this.handleCallServiceMessage(payload).catch((err) => {
                this.log('error', 'Signaling error', { peer: peerId, err });
            }));
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
            // Listen for track changes on this stream (e.g. user toggles camera)
            rtcioStream.onTrackChanged((stream) => {
                var _a;
                const tracks = stream.getTracks();
                const ownTransceivers = (_a = peer.streamTransceivers[streamMsId]) !== null && _a !== void 0 ? _a : [];
                tracks.forEach(track => {
                    // Only look at transceivers that belong to THIS stream
                    const existingTransceiver = ownTransceivers.find(t => t.sender.track && t.sender.track.kind === track.kind);
                    if (existingTransceiver) {
                        existingTransceiver.sender.replaceTrack(track);
                    }
                    else {
                        const transceiver = peer.connection.addTransceiver(track, {
                            direction: "sendonly",
                            streams: [rtcioStream.mediaStream],
                        });
                        peer.streamTransceivers[streamMsId].push(transceiver);
                    }
                });
                // Browser fires onnegotiationneeded automatically after addTransceiver
            });
            const tracks = rtcioStream.mediaStream.getTracks();
            if (tracks.length === 0) {
                // Placeholder transceiver so the peer knows we have a stream slot
                const transceiver = peer.connection.addTransceiver('audio', {
                    direction: "sendonly"
                });
                peer.streamTransceivers[streamMsId].push(transceiver);
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
            };
            const peer = this.rtcpeers[source];
            this.log('debug', `Created peer connection`, { peer: source, polite: options.polite });
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
                peer.streams[stream.id] = new RTCIOStream(stream);
                // Handle tracks that arrive after the initial ontrack (e.g. video after audio).
                stream.onaddtrack = ({ track: newTrack }) => {
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
                };
                // Request event metadata for this stream
                const eventPayload = {
                    source: this.id,
                    target: source,
                    data: {
                        mid: stream.id,
                    },
                };
                this.emit(RtcioEvents.MESSAGE, eventPayload);
            };
            // 'disconnected' is transient — ICE will self-recover or escalate to 'failed'.
            peer.connection.oniceconnectionstatechange = () => {
                this.log('debug', `ICE state: ${peer.connection.iceConnectionState}`, { peer: source });
                switch (peer.connection.iceConnectionState) {
                    case "disconnected":
                        break;
                    case "failed":
                        peer.connection.restartIce();
                        this.log('debug', 'ICE failed — restarting', { peer: source });
                        break;
                    case "closed":
                        this.cleanupPeer(source);
                        break;
                    default:
                        break;
                }
            };
            // connectionState aggregates ICE + DTLS — more reliable than
            // iceConnectionState alone. Use as primary disconnect handler.
            peer.connection.onconnectionstatechange = () => {
                this.log('debug', `Connection state: ${peer.connection.connectionState}`, { peer: source });
                switch (peer.connection.connectionState) {
                    case "failed":
                        peer.connection.restartIce();
                        this.log('debug', 'Connection failed — restarting ICE', { peer: source });
                        break;
                    case "closed":
                        this.cleanupPeer(source);
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
                    this.emit(RtcioEvents.MESSAGE, payload);
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
                        this.emit(RtcioEvents.MESSAGE, {
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
            return peer;
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
        this.on(RtcioEvents.INIT_OFFER, this.initializeConnection);
        this.on(RtcioEvents.MESSAGE, this.enqueueSignalingMessage);
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
        else {
            super.emit(ev, ...args);
        }
        return this;
    }
    getRTCIOStreamDeep(obj) {
        if (!obj || typeof obj !== "object")
            return;
        if (obj instanceof RTCIOStream)
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
            // to prevent onnegotiationneeded racing with setRemoteDescription.
            // No data channel here — the polite peer creates it; adding one here would
            // cause glare that drops subsequent stream track offers.
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
                this.emit(RtcioEvents.MESSAGE, {
                    source: this.id,
                    target: peer.socketId,
                    data: {
                        description: peer.connection.localDescription,
                    },
                });
                this.log('debug', 'Sent answer', { peer: source });
            }
            // Defer so this handler finishes before onnegotiationneeded fires on stream replay.
            if (isNewPeer) {
                queueMicrotask(() => this.replayStreamsToPeer(peer));
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
            this.emit(RtcioEvents.MESSAGE, payload);
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
            //  data channel to connect with even without media
            peer.connection.createDataChannel("connectionSetup");
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
        if (data instanceof RTCIOStream) {
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
        if (data instanceof RTCIOStream) {
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
    cleanupPeer(peerId) {
        const peer = this.rtcpeers[peerId];
        if (!peer)
            return;
        this.log('debug', 'Cleaning up peer', { peer: peerId });
        peer.connection.close();
        delete this.rtcpeers[peerId];
        delete this.signalingQueues[peerId];
        this.listeners("peer-disconnect").forEach((listener) => {
            listener({ id: peerId });
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
        return await getRTCStats(peerConnection, {});
    }
    async getIceCandidateStats(peerId) {
        var _a;
        const peerConnection = (_a = this.getPeer(peerId)) === null || _a === void 0 ? void 0 : _a.connection;
        if (!peerConnection)
            return null;
        return await getRTCIceCandidateStatsReport(peerConnection);
    }
}
