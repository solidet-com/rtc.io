"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const uuid_1 = require("uuid");
class RTCIOStream {
    constructor(nameOrStream, mediaStream) {
        this.videoTransceivers = {};
        this.audioTransceivers = {};
        if (typeof nameOrStream === "string") {
            this.id = (0, uuid_1.v4)();
            this.name = nameOrStream;
            this.mediaStream = mediaStream;
        }
        else {
            this.id = (0, uuid_1.v4)();
            this.name = this.id;
            this.mediaStream = nameOrStream;
        }
    }
    _handleStream(peerConnection, socketId) {
        const videoTrack = this.mediaStream.getVideoTracks()[0];
        const audioTrack = this.mediaStream.getAudioTracks()[0];
        if (videoTrack) {
            this.videoTransceivers[socketId] = peerConnection.addTransceiver(videoTrack, { direction: "sendonly", streams: [this.mediaStream] });
        }
        if (audioTrack) {
            this.audioTransceivers[socketId] = peerConnection.addTransceiver(audioTrack, { direction: "sendonly", streams: [this.mediaStream] });
        }
    }
    pause() {
        Object.values(this.videoTransceivers).forEach((t) => (t.direction = "inactive"));
        Object.values(this.audioTransceivers).forEach((t) => (t.direction = "inactive"));
    }
    resume() {
        Object.values(this.videoTransceivers).forEach((t) => (t.direction = "sendonly"));
        Object.values(this.audioTransceivers).forEach((t) => (t.direction = "sendonly"));
    }
    mute() {
        Object.values(this.audioTransceivers).forEach((t) => (t.direction = "inactive"));
    }
    unmute() {
        Object.values(this.audioTransceivers).forEach((t) => (t.direction = "sendonly"));
    }
    stop() {
        this.mediaStream.getTracks().forEach((track) => track.stop());
        Object.values(this.videoTransceivers).forEach((t) => t.sender.replaceTrack(null));
        Object.values(this.audioTransceivers).forEach((t) => t.sender.replaceTrack(null));
        this.videoTransceivers = {};
        this.audioTransceivers = {};
    }
    replace(newStream) {
        var _a, _b;
        const newVideo = (_a = newStream.getVideoTracks()[0]) !== null && _a !== void 0 ? _a : null;
        const newAudio = (_b = newStream.getAudioTracks()[0]) !== null && _b !== void 0 ? _b : null;
        Object.values(this.videoTransceivers).forEach((t) => t.sender.replaceTrack(newVideo));
        Object.values(this.audioTransceivers).forEach((t) => t.sender.replaceTrack(newAudio));
        this.mediaStream = newStream;
    }
}
exports.default = RTCIOStream;
