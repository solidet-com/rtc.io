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
};
export declare class Socket extends RootSocket {
    private rtcpeers;
    private whippeers;
    private localStream?;
    private readonly servers;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    getPeer(id: string): RTCPeer;
    createPeerConnection: (payload: MessagePayload) => RTCPeer;
    stream: (stream: MediaStream) => Promise<void>;
    private _stream;
    getStats(peerId: string): Promise<unknown>;
    getSessionStats(peerId: string): Promise<import("./stats/stats.js").RTCSample | null>;
    getIceCandidateStats(peerId: string): Promise<any>;
    createOffer: (payload: MessagePayload<null>) => Promise<void>;
    addIceCandidate(payload: MessagePayload<RTCIceCandidate>): Promise<void>;
    private getQueryParam;
    whip(api: string, roomName?: string | undefined): Promise<void>;
    addAnswer(payload: MessagePayload<RTCSessionDescriptionInit>): Promise<void>;
    createAnswer(payload: MessagePayload<RTCSessionDescriptionInit>): Promise<void>;
}
export {};
