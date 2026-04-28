import { SocketOptions as RootSocketOptions, Socket as RootSocket } from "socket.io-client";
import { Manager } from "./manager";
import { MessagePayload } from "./payload";
import { RTCIOStream } from "./stream";
import { RTCIOChannel, ChannelOptions } from "./channel";
import { RTCIOBroadcastChannel } from "./broadcast-channel";
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
    ctrlDc: RTCDataChannel | null;
    ctrlQueue: string[];
    channels: Record<string, RTCIOChannel>;
    channelIds: Map<number, string>;
    connectFired: boolean;
};
type connectionStatus = {
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    negotiationNeeded: boolean;
    negotiationInProgress: boolean;
};
export declare class Socket extends RootSocket {
    private static readonly MAX_CTRL_QUEUE;
    private static readonly MAX_CTRL_ENVELOPE_BYTES;
    private rtcpeers;
    private streamEvents;
    private signalingQueues;
    debug: boolean;
    private readonly servers;
    private _peerListeners;
    private _channelDefs;
    private _broadcastChannels;
    private _rawEmit;
    private _rawOn;
    private _rawOff;
    constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>);
    private log;
    emit(ev: string, ...args: any[]): this;
    /**
     * Drops a stream from the replay registry so peers connecting later won't
     * receive it.  Use this when a stream is being shut down (e.g. screen share
     * stopped) — without it, late joiners see the dead stream as if it were
     * still active because the library auto-replays registered streams.
     *
     * Already-connected peers are unaffected; signal them at the application
     * level (e.g. emit a `stop-share` event over the ctrl channel).
     */
    untrackStream(stream: RTCIOStream): this;
    /**
     * Socket.io escape hatch — events emitted/received here go straight through
     * the signaling server, bypassing all DataChannel routing.
     */
    get server(): {
        emit: (ev: string, ...args: any[]) => this;
        on: (ev: string, handler: (...args: any[]) => void) => this;
        off: (ev: string, handler: (...args: any[]) => void) => this;
    };
    /**
     * Targeted peer messaging.  Emits/receives over the ctrl DataChannel for one
     * specific peer, and creates named custom DataChannels to that peer.
     */
    peer(peerId: string): {
        emit: (ev: string, ...args: any[]) => void;
        on: (ev: string, handler: (...args: any[]) => void) => void;
        off: (ev: string, handler: (...args: any[]) => void) => void;
        createChannel: (name: string, options?: ChannelOptions) => RTCIOChannel;
    };
    /**
     * Creates (or returns) a broadcast DataChannel with the given name.  All
     * connected peers — and any peers that join later — share the same logical
     * channel, matched between sides by `name`.
     */
    createChannel(name: string, options?: ChannelOptions): RTCIOBroadcastChannel;
    private _isInternalEvent;
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
    /**
     * Returns the RTCIOChannel for (peerId, name), creating and attaching the
     * underlying negotiated DataChannel if needed. Both peers compute the same
     * SCTP stream id from the channel name, so attach is symmetric — there is
     * no polite/impolite branch and no ondatachannel race.
     *
     * For two-way communication the matching peer must also call
     * createChannel(name) (broadcast or per-peer); otherwise sends are
     * dropped at the remote SCTP layer.
     */
    private _getOrCreateChannel;
    /**
     * Replays all registered broadcast channel defs onto a newly connected peer.
     * Both sides run this symmetrically: each side independently creates the
     * negotiated DC with the deterministic id from hashChannelName(name), so
     * no further signaling is needed.
     */
    private _replayChannelsToPeer;
    private _setupCtrlDc;
    private _broadcastCtrl;
    private _sendCtrl;
    private _sendCtrlRaw;
    private _enqueueCtrl;
    private _flushCtrlQueue;
    private _addPeerListener;
    private _removePeerListener;
    private broadcastPeers;
    getStats(peerId: string): Promise<unknown>;
    getSessionStats(peerId: string): Promise<import("./stats/stats.js").RTCSample | null>;
    getIceCandidateStats(peerId: string): Promise<any>;
}
export {};
