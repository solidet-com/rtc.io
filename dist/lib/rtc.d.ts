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
};
export declare class Socket extends RootSocket {
    private rtcpeers;
    private localStreams;
    private localEmitStreams;
    private readonly servers;
    private streamNameMap;
    private pendingTracks;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    /**
     * Intercepts emit() calls. When the payload contains an RTCIOStream value,
     * the stream is routed over WebRTC (transceivers + #stream-meta signaling)
     * instead of being serialized over Socket.IO (which is impossible for
     * MediaStream). The event name and all non-stream fields are bundled into
     * #stream-meta so the receiver can reconstruct the full payload.
     *
     * Events starting with "#" are always forwarded to the server unchanged
     * (internal signaling events).
     */
    emit(event: string, ...args: any[]): this;
    private extractRTCIOStreams;
    /**
     * Stores the stream for late-joining peers and dispatches it to all
     * currently connected peers.
     */
    private scheduleEmitStream;
    private dispatchEmitStreamToPeer;
    /**
     * Fires the local listeners registered via socket.on("camera", ...) with
     * the fully reconstructed payload. Does NOT send anything to the server.
     */
    private emitStreamEvent;
    getPeer(id: string): RTCPeer;
    handleCallServiceMessage(payload: MessagePayload): Promise<void>;
    handleStreamMeta: (payload: MessagePayload<{
        streamId: string;
        name: string;
        fieldKey?: string;
        meta?: Record<string, unknown> | null;
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
