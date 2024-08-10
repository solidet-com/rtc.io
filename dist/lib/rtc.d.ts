import { SocketOptions as RootSocketOptions, Socket as RootSocket } from "socket.io-client";
import { Manager } from "./manager";
import { MessagePayload } from "./payload";
export interface SocketOptions extends Partial<RootSocketOptions> {
    iceServers: RTCIceServer[];
}
type RTCPeer = {
    connection: RTCPeerConnection;
    mediaStream: MediaStream;
    socketId: string;
    polite: boolean;
    connectionStatus: connectionStatus;
};
type connectionStatus = {
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    isActive: boolean;
};
export declare class Socket extends RootSocket {
    private rtcpeers;
    private localStream?;
    private readonly servers;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    getPeer(id: string): RTCPeer;
    handleCallServiceMessage(payload: MessagePayload): Promise<void>;
    /**
     * Initializes the peer connection.
     */
    initializeConnection(payload: MessagePayload): RTCPeer;
    /**
     * Attaches local media tracks to peer connection.
     */
    addTracksFromLocalStreamToPeerConnection(peerConnection: RTCPeerConnection, localStream: MediaStream): void;
    /**
     * Stop local media tracks of peer connection.
     */
    stopLocalStreamTracks(localStream: MediaStream): void;
    /**
     * Creates peer connection
     * @returns {RTCPeerConnection} instance of RTCPeerConnection.
     */
    createPeerConnection: (payload: MessagePayload) => RTCPeer;
    stream: (stream: MediaStream) => Promise<void>;
    private _stream;
    getStats(peerId: string): Promise<unknown>;
    getSessionStats(peerId: string): Promise<import("./stats/stats.js").RTCSample | null>;
    getIceCandidateStats(peerId: string): Promise<any>;
    private getQueryParam;
}
export {};
