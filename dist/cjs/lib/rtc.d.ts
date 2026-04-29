import { SocketOptions as RootSocketOptions, Socket as RootSocket } from "socket.io-client";
import { Manager } from "./manager";
import { MessagePayload } from "./payload";
import { RTCIOStream } from "./stream";
import { RTCIOChannel, ChannelOptions } from "./channel";
import { RTCIOBroadcastChannel } from "./broadcast-channel";
export interface WatchdogOptions {
    /**
     * **Grace window — in milliseconds.**
     *
     * How long the library waits after a peer's `RTCPeerConnection.connectionState`
     * flips to `'disconnected'` or `'failed'` before declaring the peer dead and
     * tearing the connection down. The window absorbs transient ICE blips, NAT
     * rebinds, and the recovery period of an automatic ICE restart.
     *
     * - Larger values (e.g. `30_000`) keep mobile/flaky networks more tolerant —
     *   you trade a longer wait for resilience to brief outages.
     * - Smaller values (e.g. `4_000`) free resources sooner — you trade tolerance
     *   for snappy `peer-disconnect` events.
     * - Must be a non-negative finite number. NaN, negative, or non-numeric
     *   inputs are silently ignored and the default is used.
     *
     * @defaultValue `12_000` (12 seconds)
     * @unit milliseconds
     */
    timeout?: number;
    /**
     * **Shortened grace window — in milliseconds.**
     *
     * Used in place of `timeout` when the signaling server has *also* reported
     * the peer as gone (a `#rtcio:peer-left` hint received within `hintTTL`).
     * Both signals corroborate the departure, so there is little reason to wait
     * through the full ICE-blip allowance.
     *
     * - Set this equal to `timeout` to ignore server hints entirely.
     * - Setting it lower than ~1_000 risks reaping peers during a momentary
     *   ICE consent miss that happened to coincide with a signaling drop.
     * - Must be a non-negative finite number.
     *
     * @defaultValue `2_500` (2.5 seconds)
     * @unit milliseconds
     */
    hintTimeout?: number;
    /**
     * **Hint TTL — in milliseconds.**
     *
     * How long a server-side `peer-left` hint remains "fresh" enough to shorten
     * the watchdog. Beyond this window the hint is treated as stale and ignored
     * — on the assumption that if the peer were really gone, the WebRTC layer
     * would have surfaced trouble (ICE consent freshness fails after ~30 s) by
     * now.
     *
     * - Increase if your signaling traffic and WebRTC liveness can drift far
     *   apart (e.g. severely throttled mobile networks).
     * - Setting this to `0` disables the hint→shortened-window pathway entirely
     *   without disabling immediate cleanup when state is already unhealthy.
     * - Must be a non-negative finite number.
     *
     * @defaultValue `30_000` (30 seconds)
     * @unit milliseconds
     */
    hintTTL?: number;
}
export interface SocketOptions extends Partial<RootSocketOptions> {
    iceServers: RTCIceServer[];
    debug?: boolean;
    /**
     * Per-peer liveness watchdog tuning. The watchdog decides when an unhealthy
     * `RTCPeerConnection` should be force-closed and `peer-disconnect` fired.
     *
     * Every field is **in milliseconds** and is independently optional — omit
     * one to keep its default. See {@link WatchdogOptions} for the full
     * semantics of each knob.
     *
     * @example
     * ```ts
     * const socket = io(URL, {
     *   iceServers: [...],
     *   watchdog: {
     *     timeout: 30_000,      // tolerate longer mobile rebinds (ms)
     *     hintTimeout: 5_000,   // still react fast to corroborated hints (ms)
     *     hintTTL: 60_000,      // accept hints from up to 60 s ago (ms)
     *   },
     * });
     * ```
     */
    watchdog?: WatchdogOptions;
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
    unhealthyTimer: ReturnType<typeof setTimeout> | null;
    peerLeftHintAt: number;
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
    static readonly DEFAULT_WATCHDOG_TIMEOUT_MS = 12000;
    static readonly DEFAULT_WATCHDOG_HINT_TIMEOUT_MS = 2500;
    static readonly DEFAULT_PEER_LEFT_HINT_TTL_MS = 30000;
    /** Resolved watchdog timeout, in milliseconds. See {@link WatchdogOptions.timeout}. */
    private readonly watchdogTimeoutMs;
    /** Resolved watchdog hint-shortened timeout, in milliseconds. See {@link WatchdogOptions.hintTimeout}. */
    private readonly watchdogHintTimeoutMs;
    /** Resolved peer-left hint TTL, in milliseconds. See {@link WatchdogOptions.hintTTL}. */
    private readonly peerLeftHintTtlMs;
    private rtcpeers;
    private streamEvents;
    private signalingQueues;
    debug: boolean;
    private _signalingConnectedOnce;
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
    /**
     * Armed when a peer's connectionState becomes 'disconnected' or 'failed'.
     * If the peer hasn't returned to 'connected' by the time the timer fires,
     * the connection is force-closed and `peer-disconnect` is emitted via
     * `cleanupPeer`. The grace window shortens when a recent server-side
     * peer-left hint corroborates that the peer is really gone.
     *
     * Re-arming clears any prior timer, so back-to-back state flips
     * (disconnected → failed) reset the budget rather than racing two timers.
     */
    private _armUnhealthyTimer;
    private _clearUnhealthyTimer;
    /**
     * Server-side peer-left hint handler. The signaling socket can drop
     * independently of the WebRTC connection (server crash or restart, mobile
     * data → wifi switch, signaling-only firewall change), so this is treated
     * as advisory rather than authoritative:
     *
     *   - If the WebRTC layer already reports the connection as unhealthy
     *     ('disconnected' or 'failed'), both signals agree and we clean up
     *     immediately.
     *   - Otherwise we record the hint timestamp. If the connection later
     *     goes unhealthy within the validity window, the watchdog uses the
     *     shortened grace period to clean up faster than ICE consent alone
     *     would. If the connection stays healthy, the hint is silently
     *     discarded — so a flaky signaling channel cannot tear down a
     *     working P2P call.
     */
    /**
     * Fires every time the socket.io transport reaches `connected` — including
     * reconnects after a drop. The first connect is just startup (no peers
     * exist yet); from the second one onward, we walk the peer table and kick
     * an ICE restart on anything that's currently `disconnected` or `failed`,
     * so the recovery offer rides the freshly-restored signaling channel
     * instead of a stale one from before the drop.
     *
     * The watchdog still owns the "give up" decision — this is a recovery
     * accelerator, not a teardown trigger.
     */
    private _handleSignalingConnect;
    private _handlePeerLeftHint;
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
