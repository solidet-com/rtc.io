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
export class RTCIOStream {
    constructor(idOrMediaStream, mediaStream) {
        this.trackChangeCallbacks = [];
        this.addTrackCallbacks = [];
        this.removeTrackCallbacks = [];
        // Platform-driven add: dispatch the stream-level onTrackChanged callbacks
        // (back-compat) AND the per-track onTrackAdded callbacks (preferred for new
        // code, since they hand the actual track to the listener and are cleaned
        // up automatically by dispose()).
        this.platformAddTrack = (e) => {
            this.onTrackChange();
            this.addTrackCallbacks.forEach(cb => cb(e.track));
        };
        this.platformRemoveTrack = (e) => {
            this.onTrackChange();
            this.removeTrackCallbacks.forEach(cb => cb(e.track));
        };
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
        this.mediaStream.addEventListener('addtrack', this.platformAddTrack);
        this.mediaStream.addEventListener('removetrack', this.platformRemoveTrack);
    }
    onTrackChanged(callback) {
        this.trackChangeCallbacks.push(callback);
        return () => {
            this.trackChangeCallbacks = this.trackChangeCallbacks.filter(cb => cb !== callback);
        };
    }
    /**
     * Subscribes to platform-driven track additions on the underlying
     * MediaStream — fires when the WebRTC stack hands the stream a new track
     * (e.g. the remote peer added video after starting with audio only).
     *
     * Programmatic `addTrack()` calls do **not** fire this — use
     * `onTrackChanged` for a callback that covers both. Returns an
     * unsubscribe function. All registered callbacks are also cleared on
     * `dispose()`, so library-internal listeners cannot outlive the wrapper.
     */
    onTrackAdded(callback) {
        this.addTrackCallbacks.push(callback);
        return () => {
            this.addTrackCallbacks = this.addTrackCallbacks.filter(cb => cb !== callback);
        };
    }
    /**
     * Subscribes to platform-driven track removals on the underlying
     * MediaStream — fires when the WebRTC stack drops a track from the stream
     * (e.g. the remote peer stopped sharing screen). Programmatic
     * `removeTrack()` calls do not fire this. Returns an unsubscribe function;
     * callbacks are also cleared on `dispose()`.
     */
    onTrackRemoved(callback) {
        this.removeTrackCallbacks.push(callback);
        return () => {
            this.removeTrackCallbacks = this.removeTrackCallbacks.filter(cb => cb !== callback);
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
        this.mediaStream.removeEventListener('addtrack', this.platformAddTrack);
        this.mediaStream.removeEventListener('removetrack', this.platformRemoveTrack);
        this.trackChangeCallbacks = [];
        this.addTrackCallbacks = [];
        this.removeTrackCallbacks = [];
    }
    toJSON() {
        return `[RTCIOStream] ${this.id}`;
    }
}
