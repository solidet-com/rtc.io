import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";
import { GetEventPayload, MessagePayload } from "./payload";
import { RTCIOStream, applyVideoEncodingToSender, CodecPreferenceCallback } from "./stream";
import {
	RtcioEvents,
	INTERNAL_EVENT_PREFIX,
	CTRL_CHANNEL_LABEL,
	CUSTOM_CHANNEL_PREFIX,
	RESERVED_EVENTS,
} from "./events";
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

/**
 * Deterministic hash of a channel name. Both peers compute the same id for the
 * same name, so we can use `negotiated: true` DataChannels without a polite/
 * impolite handshake.
 *
 * Range is [1, 1023] — id 0 is reserved for the ctrl channel. The upper bound
 * is set by Chromium's SCTP transport, which caps stream ids at 1023 (its
 * `kMaxSctpStreams = 1024`); creating a DataChannel with `id` outside this
 * range fails with `OperationError: RTCDataChannel creation failed`. Firefox
 * is more permissive but we pick the lowest common denominator.
 *
 * Hash collisions are detected per-peer and surface as a clear error to the
 * caller (see `_getOrCreateChannel`).
 */
/**
 * Resolve a numeric option: use the user value if it's a finite, non-negative
 * number, otherwise fall back to the default. Negative or NaN inputs would
 * arm a `setTimeout` with garbage and cause an immediate fire — silently
 * ignoring them keeps the watchdog stable in the face of accidental misuse.
 */
function pickPositive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function hashChannelName(name: string): number {
	// FNV-1a 32-bit
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return ((h >>> 0) % 1023) + 1;
}

/**
 * One outbound role on a peer connection: a long-lived `(audio, video)`
 * transceiver pair that any number of streams of the same `purpose` can be
 * bound to over the call lifetime. All track add / swap / remove flows go
 * through `RTCRtpSender.replaceTrack` on these senders, so mute and unmute
 * are renegotiation-free.
 *
 * Direction stays `sendrecv` for the slot's whole life — even when the
 * sender has no track. This is the canonical Meet / Zoom-web pattern: the
 * m-line is reusable next time without further SDP work.
 */
type Slot = {
	audio: RTCRtpTransceiver;
	video: RTCRtpTransceiver;
	// RTCIOStream.id currently bound, or null when the slot is free.
	streamId: string | null;
	// MediaStream.id currently bound — a=msid in SDP, used for ontrack
	// stream-id matching on the remote side.
	msId: string | null;
	// Detach handle for the bound stream's onTrackChanged listener.
	unsubscribe: (() => void) | null;
};

type RTCPeer = {
	connection: RTCPeerConnection;
	socketId: string;
	polite: boolean;
	connectionStatus: connectionStatus;
	streams: Record<string, RTCIOStream>;
	// Outbound transceiver slots keyed by stream purpose ('camera', 'screen', ...).
	// The camera slot is allocated eagerly at peer creation; others are
	// lazily added the first time a stream of that purpose binds.
	slots: Map<string, Slot>;
	ctrlDc: RTCDataChannel | null;                            // built-in ctrl channel
	ctrlQueue: string[];                                      // pre-open envelope queue
	channels: Record<string, RTCIOChannel>;                   // custom channels keyed by name
	channelIds: Map<number, string>;                          // hash id → name; detects channel-name hash collisions
	connectFired: boolean;                                    // 'peer-connect' has been emitted; gates the matching 'peer-disconnect'
	// ICE candidates that arrived before we had a remote description (or
	// during a glare-induced rollback window) get parked here and replayed
	// in arrival order after each successful setRemoteDescription. The
	// browser's own buffering only kicks in once remoteDescription is set,
	// so without this queue candidates that hit the wire during the gap
	// would be silently dropped — and an m-line whose SDP looked fine could
	// end up with no successful ICE pair, manifesting as one-way silence on
	// audio that "should be" working.
	pendingCandidates: RTCIceCandidate[];
	// Liveness watchdog: armed when connectionState becomes 'disconnected' or
	// 'failed', cleared on recovery to 'connected'. If the timer fires the
	// connection is force-closed and the peer cleaned up. This is the
	// authoritative signal for "peer is gone" — the server hint below only
	// shortens the timer; it never closes a peer on its own.
	unhealthyTimer: ReturnType<typeof setTimeout> | null;
	// Timestamp (ms since epoch) of the last server-side peer-left signal for
	// this peer. The signaling socket can drop while the P2P connection over
	// STUN/TURN stays alive (server crash, mobile network handoff, signaling-
	// only firewall change), so we treat the signal as a hint, not an order:
	// we shorten the watchdog window when the hint is fresh, but never tear
	// down a peer whose WebRTC layer still reports 'connected'.
	peerLeftHintAt: number;
};

type connectionStatus = {
	makingOffer: boolean;
	ignoreOffer: boolean;
	isSettingRemoteAnswerPending: boolean;
	negotiationNeeded: boolean;      // coalesce rapid-fire onnegotiationneeded
	negotiationInProgress: boolean;  // true while an offer is in-flight
};

export class Socket extends RootSocket {
	// Bounded ctrl-channel buffer per peer. Drops oldest when full so a closed
	// or slow peer can't pin unbounded memory in long-lived sessions.
	private static readonly MAX_CTRL_QUEUE = 1024;
	// Cap inbound ctrl-channel envelope size before we attempt to parse it. A
	// hostile peer could otherwise stream multi-megabyte JSON across multiple
	// SCTP messages and pin our event loop in JSON.parse. 1 MB is well above
	// any legitimate envelope (which carry user emit() args, not file data —
	// bulk transfers go through `createChannel(...).send(buffer)`, which never
	// hits this code path).
	private static readonly MAX_CTRL_ENVELOPE_BYTES = 1_048_576;

	// Liveness watchdog defaults — all values in milliseconds.
	//
	// ICE consent freshness (RFC 7675) sends STUN binding requests every ~5 s
	// and gives up after ~30 s, so the browser surfaces 'disconnected' within
	// ~5–15 s of a peer disappearing and 'failed' a short while later. We use
	// that as the trigger and add a bounded grace window for the connection
	// to self-heal (NAT rebind, ICE restart) before we declare the peer dead
	// and tear down. Override per socket via `opts.watchdog` — the resolved
	// values land on the `watchdogTimeoutMs` / `watchdogHintTimeoutMs` /
	// `peerLeftHintTtlMs` instance fields below.
	public static readonly DEFAULT_WATCHDOG_TIMEOUT_MS = 12_000;
	// When the server has *also* told us the peer left, both signals agree the
	// peer is most likely gone — shorten the grace window to clean up faster.
	// A small budget remains so we don't tear down on a transient signaling
	// flap that happened to coincide with a momentary ICE consent miss.
	public static readonly DEFAULT_WATCHDOG_HINT_TIMEOUT_MS = 2_500;
	// How long a server-side peer-left hint stays "fresh" enough to shorten
	// the watchdog. Beyond this, the hint is ignored on the assumption that
	// we'd have observed the matching P2P trouble by now if it were real.
	public static readonly DEFAULT_PEER_LEFT_HINT_TTL_MS = 30_000;

	/** Resolved watchdog timeout, in milliseconds. See {@link WatchdogOptions.timeout}. */
	private readonly watchdogTimeoutMs: number;
	/** Resolved watchdog hint-shortened timeout, in milliseconds. See {@link WatchdogOptions.hintTimeout}. */
	private readonly watchdogHintTimeoutMs: number;
	/** Resolved peer-left hint TTL, in milliseconds. See {@link WatchdogOptions.hintTTL}. */
	private readonly peerLeftHintTtlMs: number;

	private rtcpeers: Record<string, RTCPeer>;
	private streamEvents: Record<string, any>; // Events Payloads including RTCIOStream, stream.id:event-payload
	private signalingQueues: Record<string, Promise<void>>; // Per-peer serial queue
	public debug: boolean;
	// True once the first socket.io `connect` event has fired. Subsequent
	// `connect` events are reconnects, and we want to react to those (nudge
	// stuck peers) rather than the initial handshake.
	private _signalingConnectedOnce: boolean = false;

	private readonly servers: RTCConfiguration;

	// DataChannel-first messaging state
	private _peerListeners: Map<string, Map<string, Function[]>>;
	private _channelDefs: Array<{ name: string; options: ChannelOptions }>;
	private _broadcastChannels: Map<string, RTCIOBroadcastChannel>;
	private _rawEmit: (ev: string, ...args: any[]) => any;
	private _rawOn: (ev: string, handler: any) => any;
	private _rawOff: (ev: string, handler: any) => any;

	constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>) {
		super(io, nsp, opts);

		this.servers = {
			iceServers: opts?.iceServers?.length
				? opts.iceServers
				: [{ urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] }],
		};

		const wd = opts?.watchdog;
		this.watchdogTimeoutMs = pickPositive(wd?.timeout, Socket.DEFAULT_WATCHDOG_TIMEOUT_MS);
		this.watchdogHintTimeoutMs = pickPositive(wd?.hintTimeout, Socket.DEFAULT_WATCHDOG_HINT_TIMEOUT_MS);
		this.peerLeftHintTtlMs = pickPositive(wd?.hintTTL, Socket.DEFAULT_PEER_LEFT_HINT_TTL_MS);

		this.rtcpeers = {};
		this.streamEvents = {};
		this.signalingQueues = {};
		this.debug = opts?.debug ?? false;

		this._peerListeners = new Map();
		this._channelDefs = [];
		this._broadcastChannels = new Map();
		// Capture parent class methods so the user-facing `emit/on/off` overrides
		// don't shadow them for internal signaling and the `rtc.server.*` accessor.
		this._rawEmit = (ev: string, ...args: any[]) => super.emit(ev, ...args);
		this._rawOn = (ev: string, handler: any) => super.on(ev as any, handler);
		this._rawOff = (ev: string, handler: any) => super.off(ev as any, handler);

		this.on(RtcioEvents.INIT_OFFER, this.initializeConnection);
		this.on(RtcioEvents.MESSAGE, this.enqueueSignalingMessage);
		// The rtc.io-server fans this out to a leaving socket's rooms so peers
		// can short-circuit ICE consent-freshness (~30 s) when a tab closes.
		// We deliberately treat it as a hint: see _handlePeerLeftHint for why.
		this._rawOn(RtcioEvents.PEER_LEFT, this._handlePeerLeftHint);

		// socket.io-client auto-reconnects with infinite retries by default
		// and buffers outgoing `emit` calls while disconnected, so most
		// signaling traffic survives a transient drop without library help.
		// Two cases need a nudge though:
		//  1. A peer transitioned to 'failed' while signaling was down. Its
		//     restartIce() ran locally but the resulting offer was buffered
		//     and won't reach the remote until reconnect. The remote's view
		//     can stay stuck in 'connected' across the gap (consent freshness
		//     hasn't fired yet) — meaning when our offer finally lands, both
		//     sides resume cleanly. Calling restartIce() again on reconnect
		//     guarantees a fresh attempt is in flight at the moment signaling
		//     is usable, instead of a stale one from before the drop.
		//  2. ICE candidates that were trickling out during the drop were
		//     buffered; restartIce() resets the candidate cycle so the
		//     remote isn't trying to apply candidates from a dead generation.
		// Initial connect is skipped — there are no peers to nudge yet.
		this._rawOn("connect", this._handleSignalingConnect);
	}

	private log(level: 'debug' | 'warn' | 'error', msg: string, data?: any) {
		if (level === 'debug' && !this.debug) return;
		const prefix = `[rtc-io][${this.id?.slice(-6) ?? '------'}]`;
		console[level](`${prefix} ${msg}`, data ?? '');
	}

	emit(ev: string, ...args: any[]): this {
		const stream = this.getRTCIOStreamDeep(args);
		if (stream) {
			this.log('debug', `emit stream event: ${ev}`, { streamId: stream.id });
			if (!this.streamEvents[stream.id]) {
				this.streamEvents[stream.id] = {};
			}
			this.streamEvents[stream.id][ev] = args;

			this.broadcastPeers(this.addTransceiverToPeer, stream);
		} else if (this._isInternalEvent(ev)) {
			// Library signaling — always over socket.io
			this._rawEmit(ev, ...args);
		} else {
			// User event — broadcast over the ctrl DataChannel to all peers.
			// Strip a trailing ack callback (socket.io idiom) — DataChannels
			// have no ack channel, so silently sending it would mislead users.
			let outArgs = args;
			if (typeof args[args.length - 1] === 'function') {
				this.log('warn', `emit('${ev}'): ack callbacks are not supported over peer transport — dropping callback`);
				outArgs = args.slice(0, -1);
			}
			this._broadcastCtrl(ev, outArgs);
		}

		return this;
	}

	/**
	 * Drops a stream from the replay registry so peers connecting later won't
	 * receive it.  Use this when a stream is being shut down (e.g. screen share
	 * stopped) — without it, late joiners see the dead stream as if it were
	 * still active because the library auto-replays registered streams.
	 *
	 * Already-connected peers are unaffected; signal them at the application
	 * level (e.g. emit a `stop-share` event over the ctrl channel).
	 */
	untrackStream(stream: RTCIOStream): this {
		delete this.streamEvents[stream.id];
		// Release the stream from every peer's slot it's currently bound
		// to. The slot stays allocated — its transceivers are reused next
		// time something binds to the same purpose, so screen-share
		// stop/start cycles never accumulate m-lines.
		Object.values(this.rtcpeers).forEach(peer => {
			peer.slots.forEach(slot => {
				if (slot.streamId === stream.id) {
					this.releaseSlot(peer, slot);
				}
			});
		});
		return this;
	}

	/**
	 * Socket.io escape hatch — events emitted/received here go straight through
	 * the signaling server, bypassing all DataChannel routing.
	 */
	get server() {
		return {
			emit: (ev: string, ...args: any[]): this => {
				this._rawEmit(ev, ...args);
				return this;
			},
			on: (ev: string, handler: (...args: any[]) => void): this => {
				this._rawOn(ev, handler);
				return this;
			},
			off: (ev: string, handler: (...args: any[]) => void): this => {
				this._rawOff(ev, handler);
				return this;
			},
		};
	}

	/**
	 * Targeted peer messaging.  Emits/receives over the ctrl DataChannel for one
	 * specific peer, and creates named custom DataChannels to that peer.
	 */
	peer(peerId: string) {
		return {
			emit: (ev: string, ...args: any[]) => {
				let outArgs = args;
				if (typeof args[args.length - 1] === 'function') {
					this.log('warn', `peer('${peerId}').emit('${ev}'): ack callbacks not supported — dropping callback`);
					outArgs = args.slice(0, -1);
				}
				this._sendCtrl(peerId, ev, outArgs);
			},
			on: (ev: string, handler: (...args: any[]) => void) =>
				this._addPeerListener(peerId, ev, handler),
			off: (ev: string, handler: (...args: any[]) => void) =>
				this._removePeerListener(peerId, ev, handler),
			createChannel: (name: string, options: ChannelOptions = {}): RTCIOChannel =>
				this._getOrCreateChannel(peerId, name, options),
		};
	}

	/**
	 * Creates (or returns) a broadcast DataChannel with the given name.  All
	 * connected peers — and any peers that join later — share the same logical
	 * channel, matched between sides by `name`.
	 */
	createChannel(name: string, options: ChannelOptions = {}): RTCIOBroadcastChannel {
		let bch = this._broadcastChannels.get(name);
		if (!bch) {
			bch = new RTCIOBroadcastChannel();
			this._broadcastChannels.set(name, bch);
			this._channelDefs.push({ name, options });
		}
		Object.values(this.rtcpeers).forEach((peer) => {
			const channel = this._getOrCreateChannel(peer.socketId, name, options);
			bch!._addPeer(peer.socketId, channel);
		});
		return bch;
	}

	private _isInternalEvent(ev: string): boolean {
		return typeof ev === "string" && ev.startsWith(INTERNAL_EVENT_PREFIX);
	}

	private getRTCIOStreamDeep(obj: any): RTCIOStream | undefined {
		if (!obj || typeof obj !== "object") return;

		if (obj instanceof RTCIOStream) return obj;

		if (Array.isArray(obj)) {
			for (const item of obj) {
				const result = this.getRTCIOStreamDeep(item);
				if (result) return result;
			}
		} else {
			for (const key in obj) {
				const result = this.getRTCIOStreamDeep(obj[key]);
				if (result) return result;
			}
		}

		return;
	}

	getPeer(id: string) {
		return this.rtcpeers[id];
	}

	// Serializes signaling per peer — prevents concurrent messages from interleaving async steps.
	// `.finally` detaches the chain when this is the tail so the per-peer entry can be GCd
	// instead of growing without bound for long-lived peers.
	private enqueueSignalingMessage = (payload: MessagePayload) => {
		const peerId = payload.source;
		const prev = this.signalingQueues[peerId] ?? Promise.resolve();
		const current: Promise<void> = prev
			.then(() => this.handleCallServiceMessage(payload))
			.catch((err) => {
				this.log('error', 'Signaling error', { peer: peerId, err });
			})
			.finally(() => {
				if (this.signalingQueues[peerId] === current) {
					delete this.signalingQueues[peerId];
				}
			});
		this.signalingQueues[peerId] = current;
	};

	// https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
	async handleCallServiceMessage(payload: MessagePayload) {
		const { source } = payload;

		let isNewPeer = false;
		let peer = this.getPeer(source);
		if (!peer) {
			// Impolite side: stream replay deferred until after the initial offer/answer
			// to prevent onnegotiationneeded racing with setRemoteDescription. The ctrl
			// DC is created inside createPeerConnection as negotiated:true id:0, which
			// means both sides describe the same SCTP transport in their initial SDP —
			// no DC-OPEN handshake, no glare from the ctrl channel itself.
			peer = this.createPeerConnection(payload, { polite: false });
			isNewPeer = true;
			this.log('debug', 'Created impolite peer (deferred stream replay)', { peer: source });
		}

		const { description, candidate, mid, events } = payload.data;
		if (description) {
			this.log('debug', `Received ${description.type}`, { peer: source, signalingState: peer.connection.signalingState });

			const readyForOffer =
				!peer.connectionStatus.makingOffer &&
				(peer.connection.signalingState === "stable" ||
					peer.connectionStatus.isSettingRemoteAnswerPending);

			const offerCollision =
				description.type === "offer" && !readyForOffer;

			peer.connectionStatus.ignoreOffer = !peer.polite && offerCollision;

			if (peer.connectionStatus.ignoreOffer) {
				this.log('debug', 'Ignoring colliding offer (impolite)', { peer: source });
				return;
			}

			peer.connectionStatus.isSettingRemoteAnswerPending =
				description.type === "answer";

			try {
				await peer.connection.setRemoteDescription(description);
			} catch (err: any) {
				// If the browser doesn't support implicit rollback, do it manually
				if (err?.name === 'InvalidStateError' && offerCollision) {
					this.log('debug', 'Implicit rollback not supported, doing manual rollback', { peer: source });
					await peer.connection.setLocalDescription({ type: "rollback" });
					await peer.connection.setRemoteDescription(description);
				} else if (
					description.type === 'answer' &&
					peer.connection.signalingState === 'stable'
				) {
					// Stale answer for a superseded offer — harmless, drop it.
					this.log('debug', 'Dropping stale answer (already stable)', { peer: source });
					return;
				} else {
					this.log('warn', `setRemoteDescription failed (state: ${peer.connection.signalingState})`, { peer: source, err: err?.message });
					return;
				}
			} finally {
				peer.connectionStatus.isSettingRemoteAnswerPending = false;
			}

			// Remote description is in place — drain any candidates parked
			// before/during this exchange. Order matters: we replay in
			// arrival order so foundations resolve in the same sequence the
			// remote sent them.
			await this.drainPendingCandidates(peer);

			if (description.type === "offer") {
				await peer.connection.setLocalDescription();
				this.emit(RtcioEvents.MESSAGE, {
					source: this.id,
					target: peer.socketId,
					data: {
						description: peer.connection.localDescription,
					},
				});
				this.log('debug', 'Sent answer', { peer: source });
			}

			// After a manual rollback the browser may not re-fire
			// onnegotiationneeded for transceivers whose only delta is the
			// `direction` field (mic just turned on, etc.) — the desired
			// direction lives on the JS object but the negotiated SDP no
			// longer reflects it. Belt-and-braces: if any transceiver's
			// currentDirection diverges from its desired direction, mark
			// negotiation as needed and kick the loop.
			this.kickIfDirectionPending(peer);

			// Defer so this handler finishes before onnegotiationneeded fires on stream replay.
			// Re-check peer membership inside the microtask: between scheduling and
			// execution, ICE could have failed and cleanupPeer() could have removed
			// this peer entry, leaving us replaying onto a closed RTCPeerConnection.
			if (isNewPeer) {
				queueMicrotask(() => {
					if (this.rtcpeers[peer.socketId] === peer) this.replayStreamsToPeer(peer);
				});
				queueMicrotask(() => {
					if (this.rtcpeers[peer.socketId] === peer) this._replayChannelsToPeer(peer);
				});
			}
		} else if (candidate) {
			// Defer candidates that arrive before we've installed a remote
			// description (the very first signaling round, or right after a
			// rollback when the browser briefly has no remoteDescription).
			// drainPendingCandidates flushes the queue once setRemoteDescription
			// completes. Without this, the browser throws InvalidStateError
			// and the candidate is lost — silent half-open ICE is the result.
			if (!peer.connection.remoteDescription) {
				peer.pendingCandidates.push(candidate);
				this.log('debug', 'Buffered ICE candidate (no remote description yet)', {
					peer: source, queued: peer.pendingCandidates.length,
				});
			} else {
				try {
					await peer.connection.addIceCandidate(candidate);
				} catch (err: any) {
					// Candidates arriving for an offer we ignored (impolite glare
					// rejection) are expected and harmless — drop quietly. Anything
					// else is a real failure: log it loudly instead of silently
					// swallowing, so half-open ICE shows up in debug logs.
					if (peer.connectionStatus.ignoreOffer) {
						this.log('debug', 'addIceCandidate during ignoreOffer (dropping)', {
							peer: source,
						});
					} else {
						this.log('warn', 'addIceCandidate failed', {
							peer: source, err: err?.message ?? err,
						});
					}
				}
			}
		} else if (events) {
			const rtcioStream = peer.streams[mid];

			this.log('debug', 'Received stream events', { mid, events, hasStream: !!rtcioStream, peerStreamKeys: Object.keys(peer.streams) });

			if (!rtcioStream) {
				this.log('warn', 'Stream not found for events — stream not yet registered via ontrack', { mid, peerStreams: Object.keys(peer.streams) });
				return;
			}

			Object.keys(events).forEach((key) => {
				this.listeners(key).forEach((listener) => {
					// Deserialize the full args array, then spread — mirrors how socket.io
					// dispatches events and correctly handles multi-arg emits.
					// .call(this) so once wrappers can call this.off() to unsubscribe.
					const args = (events[key] as any[]).map(
						(arg: any) => this.deserializeStreamEvent(arg, rtcioStream),
					);
					(listener as Function).call(this, ...args);
				});
			});
		} else if (mid) {
			const rtcioStream = peer.streams[mid];
			if (!rtcioStream) {
				this.log('warn', `Stream metadata request for unknown mid — peer may not have this stream yet`, {
					mid, peer: source, peerStreams: Object.keys(peer.streams),
					localStreamEvents: Object.keys(this.streamEvents),
				});
				return;
			}

			const events = this.streamEvents[rtcioStream.id];
			if (!events || Object.keys(events).length === 0) {
				// No events yet — sender will push them via replayStreamsToPeer when emit() is called.
				this.log('debug', 'No events for stream yet, skipping metadata response', { mid });
				return;
			}

			const payload: GetEventPayload = {
				source: this.id!,
				target: peer.socketId,
				data: this.serializeStreamEvent({
					mid,
					events,
				}),
			};

			this.emit(RtcioEvents.MESSAGE, payload);
		}
	}

	private replayStreamsToPeer(peer: RTCPeer) {
		for (const streamKey in this.streamEvents) {
			const events = this.streamEvents[streamKey];
			const stream = this.getRTCIOStreamDeep(events) as RTCIOStream;
			if (stream) {
				this.addTransceiverToPeer(peer, stream);
			}
		}
		this.log('debug', 'Replayed streams to peer', {
			peer: peer.socketId,
			streamCount: Object.keys(this.streamEvents).length,
		});
	}

	/**
	 * Drain queued ICE candidates onto the peer connection. Called after
	 * each successful setRemoteDescription — buffered candidates sit in
	 * `peer.pendingCandidates` waiting for a remote description to attach
	 * to. We swallow per-candidate failures (the most common cause is a
	 * candidate whose mid no longer exists in the new description after a
	 * rollback) instead of aborting the drain, but log them so half-open
	 * ICE remains visible in debug output.
	 */
	private async drainPendingCandidates(peer: RTCPeer): Promise<void> {
		if (peer.pendingCandidates.length === 0) return;
		const queued = peer.pendingCandidates.splice(0, peer.pendingCandidates.length);
		this.log('debug', 'Draining buffered ICE candidates', {
			peer: peer.socketId, count: queued.length,
		});
		for (const cand of queued) {
			try {
				await peer.connection.addIceCandidate(cand);
			} catch (err: any) {
				this.log('warn', 'Buffered addIceCandidate failed', {
					peer: peer.socketId, err: err?.message ?? err,
				});
			}
		}
	}

	/**
	 * Re-arm the negotiation loop if any transceiver's desired direction
	 * differs from what's currently negotiated. The browser is supposed to
	 * fire `onnegotiationneeded` whenever this drifts, but post-rollback
	 * Chrome and Firefox have historically been inconsistent about firing
	 * for direction-only changes. Calling this after a rollback path makes
	 * sure the pending mic/cam toggle that originally triggered the
	 * (now-rolled-back) offer eventually goes out.
	 */
	private kickIfDirectionPending(peer: RTCPeer): void {
		if (peer.connection.signalingState !== 'stable') return;
		const drift = peer.connection.getTransceivers().some(t => {
			const want = t.direction;
			const have = t.currentDirection;
			return have !== null && want !== have;
		});
		if (!drift) return;
		this.log('debug', 'Re-arming negotiation after rollback (direction drift)', {
			peer: peer.socketId,
		});
		// Set the flag and call the handler the same way the browser would.
		// onnegotiationneeded is async and self-coalescing, so calling it
		// here when a real fire is also in flight is safe — the loop checks
		// `negotiationInProgress` and falls through.
		peer.connectionStatus.negotiationNeeded = true;
		peer.connection.onnegotiationneeded?.(new Event('negotiationneeded'));
	}

	/** Polite path: initiates the offer and replays any local streams immediately. */
	initializeConnection(
		payload: MessagePayload,
		options: { polite: boolean } = { polite: true },
	) {
		try {
			const peer = this.createPeerConnection(payload, options);

			// Replay streams before channels: media is the primary use case, and
			// a per-channel failure (e.g. a future browser tightening SCTP id
			// rules) must not silently strand the peer without media.
			if (Object.keys(this.streamEvents).length > 0) {
				for (const streamKey in this.streamEvents) {
					const events = this.streamEvents[streamKey];
					const stream = this.getRTCIOStreamDeep(events) as RTCIOStream;
					if (stream) {
						// always add the stream to the peer even if it has no tracks
						this.addTransceiverToPeer(peer, stream);
					}
				}
			}

			// Ctrl channel is now created inside createPeerConnection (negotiated:true),
			// so both polite and impolite paths get it without an asymmetric handshake.
			this._replayChannelsToPeer(peer);

			this.log('debug', `Initialized ${options.polite ? 'polite' : 'impolite'} peer`, { peer: payload.source });
		} catch (error) {
			this.log('error', 'initializeConnection failed', { error });
		} finally {
			return this.getPeer(payload.source);
		}
	}

	serializeStreamEvent(data: any): any {
		if (data instanceof RTCIOStream) {
			return data.toJSON();
		}
		try {
			if (Array.isArray(data)) {
				return data.map((item) => this.serializeStreamEvent(item));
			}
			if (data && typeof data === "object") {
				const out: Record<string, any> = {};
				for (const key in data) {
					out[key] = this.serializeStreamEvent(data[key]);
				}
				return out;
			}
		} catch (err) {
			this.log('error', 'serializeStreamEvent failed', { err });
		}

		return data;
	}

	deserializeStreamEvent(data: any, rtcioStream: RTCIOStream) {
		if (typeof data === "string" && data.startsWith("[RTCIOStream]")) {
			const id = data.replace("[RTCIOStream] ", "");

			this.log('debug', 'ID-Sync between peers', { from: rtcioStream.id, to: id });
			rtcioStream.id = id; // ID-Sync between peers

			return rtcioStream;
		}

		if (data instanceof RTCIOStream) {
			return data;
		}

		try {
			if (data && typeof data === "object") {
				for (const key in data) {
					data[key] = this.deserializeStreamEvent(
						data[key],
						rtcioStream,
					);
				}
			}
		} catch (err) {
			this.log('error', 'deserializeStreamEvent failed', { err });
		}

		return data;
	}

	/**
	 * Apply user-configured codec preferences to a transceiver. Must be called
	 * synchronously after `addTransceiver` (and before the next SDP offer)
	 * because `setCodecPreferences` reorders/filters the codec list that goes
	 * into the m-line. No-op if the stream has no `codecPreferences`
	 * callback, the browser doesn't support the API, or the callback returns
	 * an empty list (treated as "leave the default order alone").
	 */
	private applyCodecPreferences(
		transceiver: RTCRtpTransceiver,
		track: MediaStreamTrack,
		cb: CodecPreferenceCallback,
	): void {
		if (typeof transceiver.setCodecPreferences !== 'function') return;
		const kind = track.kind === 'audio' ? 'audio' : 'video';
		const caps = (RTCRtpSender as any).getCapabilities?.(kind);
		const codecs: RTCRtpCodec[] | undefined = caps?.codecs;
		if (!codecs || codecs.length === 0) return;

		try {
			const ordered = cb(codecs.slice(), kind);
			if (!ordered || ordered.length === 0) return;
			transceiver.setCodecPreferences(ordered);
		} catch (err) {
			this.log('warn', 'codecPreferences callback / setCodecPreferences failed', { err });
		}
	}

	/**
	 * Bind an outbound `RTCIOStream` to its slot on `peer`. Allocates the
	 * slot on first use (one `addTransceiver(audio)` + one `addTransceiver(video)`,
	 * both `sendrecv`), then routes the stream's tracks through
	 * `RTCRtpSender.replaceTrack` on the slot's senders. Subsequent track
	 * changes on the wrapper (mic mute/unmute, cam toggle, screen restart)
	 * also flow through `replaceTrack` — direction stays `sendrecv`, so
	 * none of these toggles trigger an SDP renegotiation.
	 *
	 * If the slot is already bound to a different stream (the user emitted
	 * a fresh wrapper for the same role — e.g. a new screen-share session),
	 * the old binding is released first so the slot becomes free, then the
	 * new stream takes it over.
	 */
	private addTransceiverToPeer = (peer: RTCPeer, rtcioStream: RTCIOStream): void => {
		const streamMsId = rtcioStream.mediaStream.id;
		const slotName = rtcioStream._getPurpose();

		this.log('debug', 'bindStreamToSlot', {
			peer: peer.socketId,
			slot: slotName,
			rtcioStreamId: rtcioStream.id,
			mediaStreamId: streamMsId,
			trackCount: rtcioStream.mediaStream.getTracks().length,
		});

		const slot = this.ensureSlot(peer, slotName);

		// Re-binding the same stream is a no-op for slot identity but we
		// still need to refresh tracks (the wrapper could have been
		// replayed on reconnect). Different stream id → release the old
		// binding first; the slot's transceivers are reused untouched.
		if (slot.streamId && slot.streamId !== rtcioStream.id) {
			this.releaseSlot(peer, slot);
		}

		slot.streamId = rtcioStream.id;
		slot.msId = streamMsId;
		peer.streams[streamMsId] = rtcioStream;

		// Apply the stream's current tracks to the slot's senders.
		this.applyTracksToSlot(peer, slot, rtcioStream);

		// Subscribe for future track changes (mic toggle, cam toggle,
		// device swap, replaceTrack on the wrapper). All of these route
		// through the same `applyTracksToSlot` path — replaceTrack on the
		// existing sender, no renegotiation.
		if (slot.unsubscribe) slot.unsubscribe();
		slot.unsubscribe = rtcioStream.onTrackChanged(() => {
			this.applyTracksToSlot(peer, slot, rtcioStream);
		});
	}

	/**
	 * Allocate a slot for `name` on `peer`, or return the existing one.
	 *
	 * **Adoption** is the key trick: on the impolite side, by the time we
	 * get here `setRemoteDescription` has already auto-created receive-only
	 * audio + video transceivers from the polite peer's offer. Allocating
	 * fresh ones with `addTransceiver` would put the impolite's outbound
	 * media on a *separate* m-line pair, doubling the SDP and giving us
	 * 4 m-lines per peer pair instead of 2. Instead, we look for
	 * unclaimed audio + video transceivers already on the connection,
	 * adopt them as the slot's senders, and flip direction to `sendrecv`
	 * so we can send back. Result: each peer pair has exactly one m=audio
	 * + one m=video, bidirectional, and mute/unmute is just `replaceTrack`.
	 *
	 * On the polite side the connection has no transceivers when the
	 * first slot allocates, so adoption finds nothing and we fall through
	 * to a clean `addTransceiver` pair.
	 */
	private ensureSlot(peer: RTCPeer, name: string): Slot {
		let slot = peer.slots.get(name);
		if (slot) return slot;

		const ownedMids = new Set<string>();
		peer.slots.forEach(s => {
			if (s.audio.mid) ownedMids.add(s.audio.mid);
			if (s.video.mid) ownedMids.add(s.video.mid);
		});

		const transceivers = peer.connection.getTransceivers();
		const isAdoptable = (t: RTCRtpTransceiver, kind: 'audio' | 'video') =>
			t.receiver.track?.kind === kind &&
			t.sender.track === null &&
			(!t.mid || !ownedMids.has(t.mid));

		const adoptedAudio = transceivers.find(t => isAdoptable(t, 'audio'));
		const adoptedVideo = transceivers.find(t => isAdoptable(t, 'video') && t !== adoptedAudio);

		if (adoptedAudio && adoptedVideo) {
			this.log('debug', 'Adopting transceivers for slot', {
				peer: peer.socketId, slot: name,
				audioMid: adoptedAudio.mid, videoMid: adoptedVideo.mid,
			});
			// Flip direction to sendrecv so we can transmit. This change
			// triggers one renegotiation cycle the next time the
			// browser's negotiation-needed bookkeeping runs — that's the
			// signal to the polite side that we now have media to send.
			if (adoptedAudio.direction !== 'sendrecv') adoptedAudio.direction = 'sendrecv';
			if (adoptedVideo.direction !== 'sendrecv') adoptedVideo.direction = 'sendrecv';
			slot = {
				audio: adoptedAudio,
				video: adoptedVideo,
				streamId: null,
				msId: null,
				unsubscribe: null,
			};
		} else {
			this.log('debug', 'Allocating fresh slot', { peer: peer.socketId, slot: name });
			slot = {
				audio: peer.connection.addTransceiver('audio', { direction: 'sendrecv' }),
				video: peer.connection.addTransceiver('video', { direction: 'sendrecv' }),
				streamId: null,
				msId: null,
				unsubscribe: null,
			};
		}
		peer.slots.set(name, slot);
		return slot;
	}

	/**
	 * Apply the wrapper's current tracks to its slot's senders. The slot
	 * has exactly one audio sender and one video sender, so there is no
	 * "find the matching transceiver" search — kind picks the sender,
	 * `replaceTrack` does the rest. A null track means "nothing to send"
	 * (mute) — direction stays `sendrecv` so the m-line keeps existing.
	 */
	private applyTracksToSlot(peer: RTCPeer, slot: Slot, rtcioStream: RTCIOStream): void {
		// Race with cleanup: the listener fires synchronously on the
		// wrapper, which can outlive the peer (it's owned by user code).
		if (peer.connection.connectionState === 'closed') return;

		const tracks = rtcioStream.mediaStream.getTracks();
		const audioTrack = tracks.find(t => t.kind === 'audio') ?? null;
		const videoTrack = tracks.find(t => t.kind === 'video') ?? null;

		this.applyTrackToSender(peer, rtcioStream, slot.audio, audioTrack);
		this.applyTrackToSender(peer, rtcioStream, slot.video, videoTrack);
	}

	private applyTrackToSender(
		peer: RTCPeer,
		rtcioStream: RTCIOStream,
		transceiver: RTCRtpTransceiver,
		track: MediaStreamTrack | null,
	): void {
		const sender = transceiver.sender;
		if (sender.track === track) return;

		// `replaceTrack` is async but the renegotiation-free guarantee
		// applies as long as we don't change kind or direction — neither
		// of which we do. Failures are rare (track ended in the same tick)
		// and we just log them; the transceiver stays at its previous
		// track, which is the safest fallback.
		sender.replaceTrack(track).catch(err => {
			this.log('warn', 'replaceTrack failed', {
				peer: peer.socketId, kind: transceiver.receiver.track?.kind, err,
			});
		});

		if (track) {
			// setStreams keeps a=msid pointing at the wrapper's MediaStream
			// so the remote's `ontrack` callback gets a stream whose .id
			// matches what the metadata-exchange protocol expects.
			if (sender.setStreams) sender.setStreams(rtcioStream.mediaStream);

			// Codec prefs and encoding params re-applied on every bind so
			// a fresh stream of an existing slot picks up the wrapper's
			// configuration. setCodecPreferences only affects the next
			// SDP exchange — it's a no-op when no renegotiation follows.
			const codecCb = rtcioStream._getCodecPreferences();
			if (codecCb) this.applyCodecPreferences(transceiver, track, codecCb);

			rtcioStream._registerSender(peer.socketId, sender);

			const encoding = rtcioStream._getVideoEncoding();
			if (encoding && track.kind === 'video') {
				applyVideoEncodingToSender(sender, encoding).catch(err => {
					this.log('warn', 'applyVideoEncodingToSender failed', {
						peer: peer.socketId, err,
					});
				});
			}
		}
	}

	/**
	 * Release a slot from its current binding without tearing down the
	 * transceivers. Senders go to `replaceTrack(null)` (silent), the
	 * onTrackChanged listener is detached, and the slot is marked free.
	 * Direction stays `sendrecv` so the next bind reuses the same m-lines
	 * with zero SDP work.
	 */
	private releaseSlot(peer: RTCPeer, slot: Slot): void {
		if (slot.unsubscribe) {
			slot.unsubscribe();
			slot.unsubscribe = null;
		}
		slot.audio.sender.replaceTrack(null).catch(() => undefined);
		slot.video.sender.replaceTrack(null).catch(() => undefined);
		if (slot.msId) {
			delete peer.streams[slot.msId];
		}
		slot.streamId = null;
		slot.msId = null;
	}

	/**
	 * Creates peer connection
	 * @returns {RTCPeerConnection} instance of RTCPeerConnection.
	 */
	createPeerConnection = (
		payload: MessagePayload,
		options: { polite: boolean },
	): RTCPeer => {
		const peerConnection = new RTCPeerConnection(this.servers);
		const { source } = payload;

		this.rtcpeers[source] = {
			connection: peerConnection,
			streams: {},
			slots: new Map(),
			socketId: source,
			polite: options.polite,
			connectionStatus: {
				makingOffer: false,
				ignoreOffer: false,
				isSettingRemoteAnswerPending: false,
				negotiationNeeded: false,
				negotiationInProgress: false,
			},
			pendingCandidates: [],
			ctrlDc: null,
			ctrlQueue: [],
			channels: {},
			channelIds: new Map(),
			connectFired: false,
			unhealthyTimer: null,
			peerLeftHintAt: 0,
		};

		const peer = this.rtcpeers[source];

		this.log('debug', `Created peer connection`, { peer: source, polite: options.polite });

		// All rtc.io channels are negotiated:true — we own the SCTP stream IDs, so
		// neither side should ever receive a DC via ondatachannel. Anything that
		// shows up here came from a non-rtc.io peer or a future feature; close it.
		peer.connection.ondatachannel = ({ channel: dc }) => {
			this.log('warn', 'Unexpected non-negotiated DataChannel — closing', {
				peer: source, label: dc.label,
			});
			dc.close();
		};

		// Uses stream.onaddtrack for late-arriving tracks; creates a synthetic stream if streams[] is empty.
		peer.connection.ontrack = ({ transceiver, track, streams }) => {
			let stream = streams[0];

			// Handle empty streams array — create synthetic MediaStream
			if (!stream) {
				stream = new MediaStream([track]);
				this.log('warn', 'ontrack: no associated stream, created synthetic', {
					peer: source, trackKind: track.kind, trackId: track.id,
				});
			}

			if (!transceiver.mid) return;

			this.log('debug', 'ontrack fired', {
				peer: source, streamId: stream.id, trackKind: track.kind, mid: transceiver.mid,
			});

			// If we already have this stream, update it with the new track
			if (peer.streams[stream.id]) {
				const existingStream = peer.streams[stream.id].mediaStream;
				const existingTrack = existingStream.getTracks().find(
					t => t.kind === track.kind
				);

				if (existingTrack && existingTrack.id !== track.id) {
					existingStream.removeTrack(existingTrack);
				}
				if (!existingStream.getTrackById(track.id)) {
					existingStream.addTrack(track);
				}

				this.listeners("track-added").forEach((listener) => {
					(listener as Function)({
						peerId: source,
						stream: existingStream,
						track: track,
					});
				});

				return;
			}

			const rtcioStream = new RTCIOStream(stream);
			peer.streams[stream.id] = rtcioStream;

			// Handle tracks that arrive after the initial ontrack (e.g. video after audio).
			// Subscribed via the wrapper so RTCIOStream.dispose() (called from
			// cleanupPeer) detaches the listener — otherwise the closure would
			// pin `peer` and `source` for the lifetime of the underlying
			// MediaStream, which can outlive the peer if the app handed it to a
			// `<video>` element.
			rtcioStream.onTrackAdded((newTrack) => {
				this.log('debug', 'Late track arrived via stream.onaddtrack', {
					peer: source, kind: newTrack.kind, streamId: stream.id,
				});
				this.listeners("track-added").forEach((listener) => {
					(listener as Function)({
						peerId: source,
						stream: stream,
						track: newTrack,
					});
				});
			});

			// Surface platform-driven track removals (remote peer stopped a
			// track or removed it from the stream) to app code as
			// `track-removed`. Like `track-added`, this only fires from
			// platform mutations — programmatic `stream.removeTrack` on the
			// local copy does not.
			rtcioStream.onTrackRemoved((oldTrack) => {
				this.log('debug', 'Track removed by remote peer', {
					peer: source, kind: oldTrack.kind, streamId: stream.id,
				});
				this.listeners("track-removed").forEach((listener) => {
					(listener as Function)({
						peerId: source,
						stream: stream,
						track: oldTrack,
					});
				});
			});

			// Request event metadata for this stream
			const eventPayload: GetEventPayload = {
				source: this.id!,
				target: source,
				data: {
					mid: stream.id,
				},
			};
			this.emit(RtcioEvents.MESSAGE, eventPayload);
		};

		// connectionState aggregates ICE + DTLS — primary disconnect signal.
		// We use it (rather than iceConnectionState) for the watchdog because
		// it folds DTLS failures in, and the spec is more consistent across
		// browsers about the transitions out of 'connected'.
		peer.connection.onconnectionstatechange = () => {
			const state = peer.connection.connectionState;
			this.log('debug', `Connection state: ${state}`, { peer: source });
			switch (state) {
				case "connected":
					// Healthy again — discard any in-flight watchdog. NAT
					// rebinding or an ICE restart can flip us back here from
					// 'disconnected' or 'failed'; we honour that recovery.
					this._clearUnhealthyTimer(peer);
					break;
				case "disconnected":
					// Transient: ICE has stopped getting consent-freshness
					// responses. Browsers usually self-heal within a few
					// seconds. Arm the watchdog for the bounded grace window.
					this._armUnhealthyTimer(peer, "ICE consent lost");
					break;
				case "failed":
					// ICE has given up. Try one restart, then enforce the
					// watchdog — if the restart never gets answered (peer is
					// truly gone) we close the connection and tear down.
					try {
						peer.connection.restartIce();
						this.log('debug', 'Connection failed — restarting ICE', { peer: source });
					} catch (e) {
						this.log('warn', 'restartIce failed', { peer: source, e });
					}
					this._armUnhealthyTimer(peer, "ICE restart did not recover");
					break;
				case "closed":
					this.cleanupPeer(source);
					break;
			}
		};

		// iceConnectionState is a secondary signal: 'closed' here can fire
		// without a matching connectionstatechange in some Firefox versions,
		// so we also catch it as a cleanup trigger. The transient states
		// ('disconnected'/'failed') are handled exclusively by the
		// connectionState path above to avoid double-arming the watchdog.
		peer.connection.oniceconnectionstatechange = () => {
			this.log('debug', `ICE state: ${peer.connection.iceConnectionState}`, { peer: source });
			if (peer.connection.iceConnectionState === "closed") {
				this.cleanupPeer(source);
			}
		};

		peer.connection.onicecandidate = async (event) => {
			if (event.candidate) {
				const payload: MessagePayload<any> = {
					source: this.id!,
					target: source,
					data: {
						candidate: event.candidate,
					},
				};

				this.emit(RtcioEvents.MESSAGE, payload);
			}
		};

		// Coalesces rapid-fire onnegotiationneeded into a single offer round.
		peer.connection.onnegotiationneeded = async () => {
			peer.connectionStatus.negotiationNeeded = true;

			if (peer.connectionStatus.negotiationInProgress) {
				this.log('debug', 'onnegotiationneeded coalesced (negotiation in progress)', { peer: source });
				return;
			}

			// Yield so any synchronous addTransceiver calls in the same tick set the flag first.
			await Promise.resolve();

			while (peer.connectionStatus.negotiationNeeded) {
				peer.connectionStatus.negotiationNeeded = false;
				peer.connectionStatus.negotiationInProgress = true;
				try {
					peer.connectionStatus.makingOffer = true;
					this.log('debug', 'onnegotiationneeded — creating offer', { peer: source });

					await peer.connection.setLocalDescription();

					this.emit(RtcioEvents.MESSAGE, {
						target: peer.socketId,
						source: this.id,
						data: {
							description: peer.connection.localDescription,
						},
					});
					this.log('debug', 'Sent offer', { peer: source });
				} catch (error: any) {
					this.log('error', `onnegotiationneeded error: ${error?.message}`, { peer: source });
				} finally {
					peer.connectionStatus.makingOffer = false;
					peer.connectionStatus.negotiationInProgress = false;
				}
			}
		};

		// Built-in ctrl channel: negotiated:true so both polite and impolite sides
		// create it independently with the same id (0) — no DC-OPEN handshake, no
		// ondatachannel race, symmetric attach. Reserves SCTP stream id 0 for ctrl;
		// custom channels get ids in [1, 1023] from hashChannelName() (Chromium
		// caps SCTP streams at 1024, so the range matches the lowest common
		// browser ceiling).
		const ctrlDc = peer.connection.createDataChannel(CTRL_CHANNEL_LABEL, {
			negotiated: true,
			id: 0,
			ordered: true,
		});
		this._setupCtrlDc(ctrlDc, peer);

		return peer;
	};

	// ─── Liveness watchdog ──────────────────────────────────────────────────

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
	private _armUnhealthyTimer(peer: RTCPeer, reason: string) {
		if (peer.unhealthyTimer) clearTimeout(peer.unhealthyTimer);

		const hintFresh =
			peer.peerLeftHintAt > 0 &&
			Date.now() - peer.peerLeftHintAt < this.peerLeftHintTtlMs;
		const ms = hintFresh
			? this.watchdogHintTimeoutMs
			: this.watchdogTimeoutMs;

		this.log('debug', 'Arming liveness watchdog', {
			peer: peer.socketId, reason, ms, hintFresh,
		});

		peer.unhealthyTimer = setTimeout(() => {
			peer.unhealthyTimer = null;
			// Re-check current state — the connection may have recovered
			// after the timer was scheduled but before it fired.
			const state = peer.connection.connectionState;
			if (state === "connected" || state === "closed") return;

			this.log('warn', `Liveness watchdog: forcing peer close (${reason})`, {
				peer: peer.socketId, state,
			});
			try {
				// Closing transitions connectionState → 'closed', which
				// triggers the onconnectionstatechange handler above and runs
				// cleanupPeer. We also call cleanupPeer directly because some
				// browser/state combinations don't fire the state change after
				// an explicit close on an already-failed connection — and
				// cleanupPeer is idempotent so the duplicate is harmless.
				peer.connection.close();
			} catch (e) {
				this.log('warn', 'connection.close() threw during watchdog', {
					peer: peer.socketId, e,
				});
			}
			this.cleanupPeer(peer.socketId);
		}, ms);
	}

	private _clearUnhealthyTimer(peer: RTCPeer) {
		if (peer.unhealthyTimer) {
			clearTimeout(peer.unhealthyTimer);
			peer.unhealthyTimer = null;
		}
	}

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
	private _handleSignalingConnect = () => {
		if (!this._signalingConnectedOnce) {
			this._signalingConnectedOnce = true;
			return;
		}

		this.log('debug', 'Signaling reconnected — nudging unhealthy peers');

		Object.values(this.rtcpeers).forEach((peer) => {
			const state = peer.connection.connectionState;
			if (state !== 'disconnected' && state !== 'failed') return;
			try {
				peer.connection.restartIce();
				this.log('debug', 'Reconnect: restartIce on peer', {
					peer: peer.socketId, state,
				});
			} catch (e) {
				this.log('warn', 'Reconnect: restartIce failed', {
					peer: peer.socketId, e,
				});
			}
		});
	};

	private _handlePeerLeftHint = (payload: { id?: string }) => {
		const id = payload?.id;
		if (!id) return;

		const peer = this.rtcpeers[id];
		if (!peer) return;

		const state = peer.connection.connectionState;
		if (state === "closed") return;

		peer.peerLeftHintAt = Date.now();

		if (state === "disconnected" || state === "failed") {
			this.log('debug', 'peer-left hint + unhealthy P2P → cleanup now', {
				peer: id, state,
			});
			try { peer.connection.close(); } catch {}
			this.cleanupPeer(id);
			return;
		}

		this.log('debug', 'peer-left hint received; deferring to WebRTC liveness', {
			peer: id, state,
		});
	};

	private cleanupPeer(peerId: string) {
		const peer = this.rtcpeers[peerId];
		if (!peer) return;

		this.log('debug', 'Cleaning up peer', { peer: peerId });

		this._clearUnhealthyTimer(peer);

		// Drop any candidates still parked for a remote description that
		// will never arrive — the connection is going away.
		peer.pendingCandidates.length = 0;

		// Close ctrl channel + clear pre-open queue
		if (
			peer.ctrlDc &&
			peer.ctrlDc.readyState !== "closed" &&
			peer.ctrlDc.readyState !== "closing"
		) {
			peer.ctrlDc.close();
		}
		peer.ctrlQueue.length = 0;

		// Close all custom channels for this peer
		Object.values(peer.channels).forEach((ch) => ch.close());

		// Detach RTCIOStream listeners on inbound streams so the wrapper does not
		// pin the closed peer's MediaStream listeners. The MediaStream itself may
		// outlive the peer if the app handed it to a `<video>` element.
		//
		// Inbound vs outbound matters here. peer.streams holds both: inbound
		// wrappers we created in ontrack, and outbound wrappers the user owns
		// (registered when the slot bound). Disposing an outbound wrapper
		// would wipe the user's app-level callbacks AND every other connected
		// peer's onTrackChanged listener — so future track swaps would silently
		// stop reaching them. Drop only the per-peer onTrackChanged closure for
		// outbounds, and dispose only the inbound wrappers we own.
		const outboundMsIds = new Set<string>();
		peer.slots.forEach(slot => { if (slot.msId) outboundMsIds.add(slot.msId); });
		Object.entries(peer.streams).forEach(([msId, s]) => {
			if (!outboundMsIds.has(msId)) s.dispose?.();
		});
		peer.slots.forEach(slot => slot.unsubscribe?.());
		peer.slots.clear();

		// Drop sender registrations on every outbound stream so setEncoding()
		// no longer calls into senders attached to a closed RTCPeerConnection.
		// streamEvents is the authoritative outbound registry — peer.streams
		// also includes inbound wrappers (from ontrack), so iterate the
		// outbound side directly.
		for (const key in this.streamEvents) {
			const stream = this.getRTCIOStreamDeep(this.streamEvents[key]) as RTCIOStream | undefined;
			stream?._unregisterPeer?.(peerId);
		}

		// Notify all broadcast channels so they fire 'peer-left' and update their peer maps
		this._broadcastChannels.forEach((bch) => bch._removePeer(peerId));

		// Drop per-peer listener registry
		this._peerListeners.delete(peerId);

		peer.connection.close();
		delete this.rtcpeers[peerId];
		delete this.signalingQueues[peerId];

		// Only notify if the peer ever fully connected — otherwise apps using
		// the acquire-on-connect / release-on-disconnect pattern get a release
		// without a matching acquire (e.g. ICE failure before ctrl DC opens).
		if (peer.connectFired) {
			this.listeners("peer-disconnect").forEach((listener) => {
				(listener as (data: unknown) => void)({ id: peerId });
			});
		}
	}

	// ─── Channel matching ───────────────────────────────────────────────────

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
	private _getOrCreateChannel(
		peerId: string,
		name: string,
		options: ChannelOptions,
	): RTCIOChannel {
		const peer = this.rtcpeers[peerId];
		// Detached channel for unknown peer — user error; will never wire up.
		if (!peer) return new RTCIOChannel(options.queueBudget, options.highWatermark, options.lowWatermark);

		let channel = peer.channels[name];
		if (!channel) {
			channel = new RTCIOChannel(options.queueBudget, options.highWatermark, options.lowWatermark);
			peer.channels[name] = channel;
		}
		if (!channel._isAttached()) {
			const id = hashChannelName(name);
			const taken = peer.channelIds.get(id);
			if (taken && taken !== name) {
				throw new Error(
					`[rtc-io] Channel '${name}' hash-collides with existing channel '${taken}' on peer ${peerId} ` +
					`(both names hash to SCTP id ${id}). Pick a different channel name.`,
				);
			}
			peer.channelIds.set(id, name);

			const { queueBudget: _qb, highWatermark: _hw, lowWatermark: _lw, ...dcInit } = options;
			const dc = peer.connection.createDataChannel(
				`${CUSTOM_CHANNEL_PREFIX}${name}`,
				{
					...dcInit,
					negotiated: true,
					id,
				},
			);
			channel._attach(dc);
		}
		return channel;
	}

	/**
	 * Replays all registered broadcast channel defs onto a newly connected peer.
	 * Both sides run this symmetrically: each side independently creates the
	 * negotiated DC with the deterministic id from hashChannelName(name), so
	 * no further signaling is needed.
	 */
	private _replayChannelsToPeer(peer: RTCPeer): void {
		for (const { name, options } of this._channelDefs) {
			// Isolate per channel — a single bad channel (hash collision, browser
			// SCTP-id rejection, etc.) must not abort replay of the rest, and
			// must not bubble up to the caller. The impolite path schedules this
			// in a queueMicrotask, so an unhandled throw there becomes an
			// uncaught exception with no way for the app to recover.
			try {
				const channel = this._getOrCreateChannel(peer.socketId, name, options);
				this._broadcastChannels.get(name)?._addPeer(peer.socketId, channel);
			} catch (err) {
				this.log('error', `Failed to replay channel '${name}' to peer`, {
					peer: peer.socketId, err,
				});
			}
		}
		if (this._channelDefs.length > 0) {
			this.log('debug', 'Replayed channels to peer', {
				peer: peer.socketId,
				channelCount: this._channelDefs.length,
			});
		}
	}

	// ─── Ctrl channel ───────────────────────────────────────────────────────

	private _setupCtrlDc(dc: RTCDataChannel, peer: RTCPeer): void {
		dc.binaryType = "arraybuffer";
		peer.ctrlDc = dc;

		dc.onopen = () => {
			this._flushCtrlQueue(peer);
			this.log('debug', 'Ctrl channel open', { peer: peer.socketId });
			// Fire 'peer-connect' to mirror the existing 'peer-disconnect' event.
			// This is the right hook for "send my state to the newly-connected peer"
			// — by now the peer entry exists and the ctrl DC can carry envelopes.
			this.listeners("peer-connect").forEach((listener) => {
				try {
					(listener as (data: unknown) => void)({ id: peer.socketId });
				} catch (err) {
					this.log("error", "peer-connect listener", err);
				}
			});
			peer.connectFired = true;
		};

		dc.onclose = () => {
			this.log('debug', 'Ctrl channel closed', { peer: peer.socketId });
			// Drop any pending envelopes — they have nowhere to go.
			peer.ctrlQueue.length = 0;
		};

		dc.onerror = (e) => {
			this.log('warn', 'Ctrl channel error', { peer: peer.socketId, e });
		};

		dc.onmessage = ({ data }) => {
			if (typeof data !== "string") return;
			if (data.length > Socket.MAX_CTRL_ENVELOPE_BYTES) {
				this.log('warn', 'Ctrl: envelope exceeds max size, dropping', {
					peer: peer.socketId, bytes: data.length,
				});
				return;
			}
			let envelope: { e?: string; d?: any };
			try {
				envelope = JSON.parse(data);
			} catch {
				this.log('warn', 'Ctrl: invalid JSON envelope', { peer: peer.socketId });
				return;
			}
			const name = envelope.e;
			if (typeof name !== "string") return;

			// Security: a peer must not be able to spoof internal signaling
			// (#rtcio:*) or library lifecycle events (peer-connect, etc.) — those
			// are emitted only by the local Socket.
			if (name.startsWith(INTERNAL_EVENT_PREFIX) || RESERVED_EVENTS.has(name)) {
				this.log('warn', 'Ctrl: dropped reserved event from peer', { peer: peer.socketId, name });
				return;
			}

			const args: any[] = Array.isArray(envelope.d) ? envelope.d : [];

			// Global listeners (registered via rtc.on(name, handler))
			this.listeners(name).forEach((h) => {
				try {
					(h as Function)(...args);
				} catch (err) {
					this.log('error', `Listener error [${name}]`, err);
				}
			});

			// Per-peer listeners (registered via rtc.peer(id).on(name, handler))
			this._peerListeners.get(peer.socketId)?.get(name)?.slice().forEach((h) => {
				try {
					h(...args);
				} catch (err) {
					this.log('error', `Peer listener error [${name}]`, err);
				}
			});
		};
	}

	private _broadcastCtrl(name: string, args: any[]): void {
		const envelope = JSON.stringify({ e: name, d: args });
		Object.values(this.rtcpeers).forEach((peer) =>
			this._sendCtrlRaw(peer, envelope),
		);
	}

	private _sendCtrl(peerId: string, name: string, args: any[]): void {
		const peer = this.rtcpeers[peerId];
		if (!peer) return;
		this._sendCtrlRaw(peer, JSON.stringify({ e: name, d: args }));
	}

	private _sendCtrlRaw(peer: RTCPeer, envelope: string): void {
		const dc = peer.ctrlDc;
		const state = dc?.readyState;

		if (state === "open") {
			try {
				dc!.send(envelope);
				return;
			} catch (e) {
				this.log('warn', 'Ctrl send failed, queueing', { peer: peer.socketId, e });
				this._enqueueCtrl(peer, envelope);
				return;
			}
		}
		// Channel is gone — buffering would be a leak with no recipient.
		if (state === "closing" || state === "closed") {
			this.log('warn', 'Ctrl DC closed, dropping message', { peer: peer.socketId });
			return;
		}
		// dc is null (not yet attached) or "connecting" — buffer for the open handler.
		this._enqueueCtrl(peer, envelope);
	}

	private _enqueueCtrl(peer: RTCPeer, envelope: string): void {
		if (peer.ctrlQueue.length >= Socket.MAX_CTRL_QUEUE) {
			peer.ctrlQueue.shift();
			this.log('warn', 'Ctrl queue full, dropped oldest', { peer: peer.socketId });
		}
		peer.ctrlQueue.push(envelope);
	}

	private _flushCtrlQueue(peer: RTCPeer): void {
		if (peer.ctrlDc?.readyState !== "open") return;
		while (peer.ctrlQueue.length > 0) {
			const envelope = peer.ctrlQueue.shift()!;
			try {
				peer.ctrlDc.send(envelope);
			} catch (e) {
				// Re-queue and stop; the channel will retry on next open or the connection is dying.
				peer.ctrlQueue.unshift(envelope);
				this.log('warn', 'Ctrl flush failed, will retry', { peer: peer.socketId, e });
				return;
			}
		}
	}

	// ─── Per-peer listener registry ─────────────────────────────────────────

	private _addPeerListener(
		peerId: string,
		event: string,
		handler: (...args: any[]) => void,
	): void {
		let map = this._peerListeners.get(peerId);
		if (!map) {
			map = new Map();
			this._peerListeners.set(peerId, map);
		}
		let list = map.get(event);
		if (!list) {
			list = [];
			map.set(event, list);
		}
		list.push(handler);
	}

	private _removePeerListener(
		peerId: string,
		event: string,
		handler: (...args: any[]) => void,
	): void {
		const list = this._peerListeners.get(peerId)?.get(event);
		if (!list) return;
		const idx = list.indexOf(handler);
		if (idx !== -1) list.splice(idx, 1);
	}

	private broadcastPeers = (cb: (peer: RTCPeer, ...args: any[]) => void, ...args: any[]) => {
		if (!this.connected) return;

		Object.values(this.rtcpeers).forEach((peer) => {
			cb.call(this, peer, ...args);
		});
	};

	async getStats(peerId: string) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) {
			return null;
		}

		const statsMap = new Map();

		return new Promise((resolve) => {
			peerConnection!.getStats().then((stats) => {
				stats.forEach((report) => {
					const { type } = report;

					if (!statsMap.has(type)) {
						statsMap.set(type, []);
					}

					statsMap.get(type).push({ report, description: type });
				});

				resolve(statsMap);
			});
		});
	}

	async getSessionStats(peerId: string) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;
		return await getRTCStats(peerConnection, {});
	}

	async getIceCandidateStats(peerId: string) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;
		return await getRTCIceCandidateStatsReport(peerConnection);
	}
}