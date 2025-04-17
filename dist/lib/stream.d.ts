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
    replace(stream: MediaStream): void;
    toJSON(): string;
}
