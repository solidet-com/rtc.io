export declare class RTCIOStream {
    id: string;
    mediaStream: MediaStream;
    constructor(mediaStream: MediaStream);
    constructor(id: string, mediaStream: MediaStream);
    replace(stream: MediaStream): void;
    toJSON(): string;
}
