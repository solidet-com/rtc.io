import { v4 as uuid } from "uuid";
export class RTCIOStream {
    constructor(idOrMediaStream, mediaStream) {
        this.trackChangeCallbacks = [];
        this.onTrackChange = () => {
            this.trackChangeCallbacks.forEach(callback => callback(this.mediaStream));
        };
        if (idOrMediaStream instanceof MediaStream) {
            this.id = uuid();
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
        const oldTracks = [...this.mediaStream.getTracks()];
        oldTracks.forEach(track => this.mediaStream.removeTrack(track));
        stream.getTracks().forEach(track => this.mediaStream.addTrack(track));
    }
    toJSON() {
        return `[RTCIOStream] ${this.id}`;
    }
}
