"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOStream = void 0;
const uuid_1 = require("uuid");
class RTCIOStream {
    constructor(idOrMediaStream, mediaStream) {
        this.trackChangeCallbacks = [];
        this.onTrackChange = () => {
            this.trackChangeCallbacks.forEach(callback => callback(this.mediaStream));
        };
        if (idOrMediaStream instanceof MediaStream) {
            this.id = (0, uuid_1.v4)();
            this.mediaStream = idOrMediaStream;
        }
        else {
            this.id = idOrMediaStream;
            this.mediaStream = mediaStream;
        }
        // track additions and removals  triggers renegotiation
        this.mediaStream.addEventListener('addtrack', this.onTrackChange);
        this.mediaStream.addEventListener('removetrack', this.onTrackChange);
    }
    onTrackChanged(callback) {
        this.trackChangeCallbacks.push(callback);
        return () => {
            this.trackChangeCallbacks = this.trackChangeCallbacks.filter(cb => cb !== callback);
        };
    }
    addTrack(track) {
        this.mediaStream.addTrack(track);
        return this;
    }
    removeTrack(track) {
        this.mediaStream.removeTrack(track);
        return this;
    }
    replace(stream) {
        //  tracks in the stream with new ones
        const oldTracks = [...this.mediaStream.getTracks()];
        oldTracks.forEach(track => this.mediaStream.removeTrack(track));
        stream.getTracks().forEach(track => this.mediaStream.addTrack(track));
    }
    toJSON() {
        return `[RTCIOStream] ${this.id}`;
    }
}
exports.RTCIOStream = RTCIOStream;
