export declare class RTCIOStream {
    id: string;
    mediaStream: MediaStream;
    private trackChangeCallbacks;
    private addTrackCallbacks;
    private removeTrackCallbacks;
    constructor(mediaStream: MediaStream);
    constructor(id: string, mediaStream: MediaStream);
    private platformAddTrack;
    private platformRemoveTrack;
    private onTrackChange;
    onTrackChanged(callback: (stream: MediaStream) => void): () => void;
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
    onTrackAdded(callback: (track: MediaStreamTrack) => void): () => void;
    /**
     * Subscribes to platform-driven track removals on the underlying
     * MediaStream — fires when the WebRTC stack drops a track from the stream
     * (e.g. the remote peer stopped sharing screen). Programmatic
     * `removeTrack()` calls do not fire this. Returns an unsubscribe function;
     * callbacks are also cleared on `dispose()`.
     */
    onTrackRemoved(callback: (track: MediaStreamTrack) => void): () => void;
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
