"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOStream = void 0;
// crypto.randomUUID is available in all modern browsers and Node ≥19. We
// avoid pulling in the `uuid` package (~9 KB) for a single call site.
function randomId() {
    const c = globalThis.crypto;
    if (c === null || c === void 0 ? void 0 : c.randomUUID)
        return c.randomUUID();
    // Fallback: 8 random hex bytes is plenty to avoid collision per session
    // in the rare environment without WebCrypto.
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
}
class RTCIOStream {
    constructor(idOrMediaStream, mediaStream) {
        this.trackChangeCallbacks = [];
        this.onTrackChange = () => {
            this.trackChangeCallbacks.forEach(callback => callback(this.mediaStream));
        };
        if (idOrMediaStream instanceof MediaStream) {
            this.id = randomId();
            this.mediaStream = idOrMediaStream;
        }
        else {
            this.id = idOrMediaStream;
            this.mediaStream = mediaStream;
        }
        // MediaStream's `addtrack` / `removetrack` events only fire when the
        // platform mutates the stream (e.g. WebRTC adds a remote track) — they
        // do *not* fire for programmatic addTrack/removeTrack. We listen anyway
        // to catch the platform-driven case, and the wrapper methods below
        // dispatch onTrackChange explicitly for the user-driven case.
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
        this.onTrackChange();
        return this;
    }
    removeTrack(track) {
        this.mediaStream.removeTrack(track);
        this.onTrackChange();
        return this;
    }
    /**
     * Swaps the existing track of the same kind (audio/video) for a new one.
     * Returns the displaced track so the caller can `.stop()` it. Use this
     * when the user picks a different mic/cam mid-call — the library hot-swaps
     * via `RTCRtpSender.replaceTrack` on each peer, with no renegotiation.
     */
    replaceTrack(newTrack) {
        var _a;
        const old = (_a = this.mediaStream.getTracks().find(t => t.kind === newTrack.kind)) !== null && _a !== void 0 ? _a : null;
        if (old)
            this.mediaStream.removeTrack(old);
        this.mediaStream.addTrack(newTrack);
        this.onTrackChange();
        return old;
    }
    replace(stream) {
        const oldTracks = [...this.mediaStream.getTracks()];
        oldTracks.forEach(track => this.mediaStream.removeTrack(track));
        stream.getTracks().forEach(track => this.mediaStream.addTrack(track));
        this.onTrackChange();
    }
    /**
     * Detaches the platform-track-event listeners and drops user-registered
     * callbacks. Call when you're done with the wrapper but the underlying
     * MediaStream lives on (e.g. handing it off to a `<video>` element). The
     * library calls this internally when a peer disconnects.
     */
    dispose() {
        this.mediaStream.removeEventListener('addtrack', this.onTrackChange);
        this.mediaStream.removeEventListener('removetrack', this.onTrackChange);
        this.trackChangeCallbacks = [];
    }
    toJSON() {
        return `[RTCIOStream] ${this.id}`;
    }
}
exports.RTCIOStream = RTCIOStream;
