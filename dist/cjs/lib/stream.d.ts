export declare class RTCIOStream {
    id: string;
    mediaStream: MediaStream;
    private trackChangeCallbacks;
    constructor(mediaStream: MediaStream);
    constructor(id: string, mediaStream: MediaStream);
    private onTrackChange;
    onTrackChanged(callback: (stream: MediaStream) => void): () => void;
    addTrack(track: MediaStreamTrack): this;
    removeTrack(track: MediaStreamTrack): this;
    /**
     * Swaps the existing track of the same kind (audio/video) for a new one.
     * Returns the displaced track so the caller can `.stop()` it. Use this
     * when the user picks a different mic/cam mid-call — the library hot-swaps
     * via `RTCRtpSender.replaceTrack` on each peer, with no renegotiation.
     */
    replaceTrack(newTrack: MediaStreamTrack): MediaStreamTrack | null;
    replace(stream: MediaStream): void;
    /**
     * Detaches the platform-track-event listeners and drops user-registered
     * callbacks. Call when you're done with the wrapper but the underlying
     * MediaStream lives on (e.g. handing it off to a `<video>` element). The
     * library calls this internally when a peer disconnects.
     */
    dispose(): void;
    toJSON(): string;
}
