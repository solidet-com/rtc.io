import { SocketOptions as RootSocketOptions, Socket as RootSocket } from "socket.io-client";
import { Manager } from "./manager";
import { MessagePayload } from "./payload";
export interface SocketOptions extends Partial<RootSocketOptions> {
    iceServers?: RTCIceServer[];
}
type RTCPeer = {
    connection: RTCPeerConnection;
    socketId: string;
    polite: boolean;
    connectionStatus: ConnectionStatus;
    streams: Record<string, MediaStream>;
    emittedStreamIds: Set<string>;
};
type ConnectionStatus = {
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
};
export declare class Socket extends RootSocket {
    private rtcpeers;
    private localStreams;
    private readonly servers;
    private streamNameMap;
    private pendingTracks;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    getPeer(id: string): RTCPeer;
    handleCallServiceMessage(payload: MessagePayload): Promise<void>;
    handleStreamMeta: (payload: MessagePayload<{
        streamId: string;
        name: string;
    }>) => void;
    initializeConnection(payload: MessagePayload, options?: {
        polite: boolean;
    }): RTCPeer | undefined;
    addTransceiverPeerConnection(peerConnection: RTCPeerConnection, stream: MediaStream): void;
    stopLocalStreamTracks(localStream: MediaStream): void;
    createPeerConnection(payload: MessagePayload, options: {
        polite: boolean;
    }): RTCPeer;
    private sendStreamMeta;
    stream: (name: string, mediaStream: MediaStream) => void;
    getStats(peerId: string): Promise<Map<string, any[]> | null>;
    getSessionStats(peerId: string): Promise<import("./stats/stats.js").RTCSample | null>;
    getIceCandidateStats(peerId: string): Promise<any>;
}
export {};
