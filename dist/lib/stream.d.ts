export default class RTCIOStream {
    readonly id: string;
    readonly name: string;
    mediaStream: MediaStream;
    videoTransceivers: Record<string, RTCRtpTransceiver>;
    audioTransceivers: Record<string, RTCRtpTransceiver>;
    constructor(name: string, mediaStream: MediaStream);
    constructor(mediaStream: MediaStream);
    _handleStream(peerConnection: RTCPeerConnection, socketId: string): void;
    pause(): void;
    resume(): void;
    mute(): void;
    unmute(): void;
    stop(): void;
    replace(newStream: MediaStream): void;
}
