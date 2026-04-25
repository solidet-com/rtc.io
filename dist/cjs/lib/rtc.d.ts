import { SocketOptions as RootSocketOptions, Socket as RootSocket } from "socket.io-client";
import { Manager } from "./manager";
import { MessagePayload } from "./payload";
import { RTCIOStream } from "./stream";
export interface SocketOptions extends Partial<RootSocketOptions> {
    iceServers: RTCIceServer[];
    debug?: boolean;
}
type RTCPeer = {
    connection: RTCPeerConnection;
    socketId: string;
    polite: boolean;
    connectionStatus: connectionStatus;
    streams: Record<string, RTCIOStream>;
    streamTransceivers: Record<string, RTCRtpTransceiver[]>;
};
type connectionStatus = {
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    negotiationNeeded: boolean;
    negotiationInProgress: boolean;
};
export declare class Socket extends RootSocket {
    private rtcpeers;
    private streamEvents;
    private signalingQueues;
    debug: boolean;
    private readonly servers;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    private log;
    emit(ev: string, ...args: any[]): this;
    private getRTCIOStreamDeep;
    getPeer(id: string): RTCPeer;
    private enqueueSignalingMessage;
    handleCallServiceMessage(payload: MessagePayload): Promise<void>;
    private replayStreamsToPeer;
    /** Polite path: initiates the offer and replays any local streams immediately. */
    initializeConnection(payload: MessagePayload, options?: {
        polite: boolean;
    }): RTCPeer;
    serializeStreamEvent(data: any): any;
    deserializeStreamEvent(data: any, rtcioStream: RTCIOStream): any;
    private addTransceiverToPeer;
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
