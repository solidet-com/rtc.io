import { SocketOptions as RootSocketOptions, Socket as RootSocket } from "socket.io-client";
import { Manager } from "./manager";
import { MessagePayload } from "./payload";
import { RTCIOStream } from "./stream";
export interface SocketOptions extends Partial<RootSocketOptions> {
    iceServers: RTCIceServer[];
}
type RTCPeer = {
    connection: RTCPeerConnection;
    socketId: string;
    polite: boolean;
    connectionStatus: connectionStatus;
    streams: Record<string, RTCIOStream>;
};
type connectionStatus = {
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
};
export declare class Socket extends RootSocket {
    private rtcpeers;
    private streamEvents;
    private signalingQueues;
    private readonly servers;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    private log;
    emit(ev: any, ...args: any[]): this;
    private getRTCIOStreamDeep;
    getPeer(id: string): RTCPeer;
    private enqueueSignalingMessage;
    handleCallServiceMessage(payload: MessagePayload): Promise<void>;
    private replayStreamsToPeer;
    /**
     * Initializes the peer connection.
     * Used for the POLITE path (via #init-rtc-offer).
     * Polite peers initiate the offer, so replaying streams immediately is safe —
     * there's no incoming offer to collide with.
     */
    initializeConnection(payload: MessagePayload, options?: {
        polite: boolean;
    }): RTCPeer;
    private broadcastExistingStreams;
    serializeStreamEvent(data: any): any;
    deserializeStreamEvent(data: any, rtcioStream: RTCIOStream): any;
    addTransceiverToPeer(peer: RTCPeer, rtcioStream: RTCIOStream): void;
    /**
     * Creates peer connection
     * @returns {RTCPeerConnection} instance of RTCPeerConnection.
     */
    createPeerConnection: (payload: MessagePayload, options: {
        polite: boolean;
    }) => RTCPeer;
    private cleanupPeer;
    private broadcastPeers;
    getStats(peerId: string): Promise<unknown>;
    getSessionStats(peerId: string): Promise<import("./stats/stats.js").RTCSample | null>;
    getIceCandidateStats(peerId: string): Promise<any>;
}
export {};
