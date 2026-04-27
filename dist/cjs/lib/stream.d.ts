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
    toJSON(): string;
}
