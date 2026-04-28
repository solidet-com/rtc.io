import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";
import { GetEventPayload, MessagePayload } from "./payload";
import { RTCIOStream } from "./stream";
import {
	RtcioEvents,
	INTERNAL_EVENT_PREFIX,
	CTRL_CHANNEL_LABEL,
	CUSTOM_CHANNEL_PREFIX,
	RESERVED_EVENTS,
} from "./events";
import { RTCIOChannel, ChannelOptions } from "./channel";
import { RTCIOBroadcastChannel } from "./broadcast-channel";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers: RTCIceServer[];
	debug?: boolean;
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
function hashChannelName(name: string): number {
	// FNV-1a 32-bit
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return ((h >>> 0) % 1023) + 1;
}

type RTCPeer = {
	connection: RTCPeerConnection;
	socketId: string;
	polite: boolean;
	connectionStatus: connectionStatus;
	streams: Record<string, RTCIOStream>;
	streamTransceivers: Record<string, RTCRtpTransceiver[]>; // mediaStream.id → transceivers for that stream
	ctrlDc: RTCDataChannel | null;                            // built-in ctrl channel
	ctrlQueue: string[];                                      // pre-open envelope queue
	channels: Record<string, RTCIOChannel>;                   // custom channels keyed by name
	channelIds: Map<number, string>;                          // hash id → name; detects channel-name hash collisions
	connectFired: boolean;                                    // 'peer-connect' has been emitted; gates the matching 'peer-disconnect'
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

	private rtcpeers: Record<string, RTCPeer>;
	private streamEvents: Record<string, any>; // Events Payloads including RTCIOStream, stream.id:event-payload
	private signalingQueues: Record<string, Promise<void>>; // Per-peer serial queue
	public debug: boolean;

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
			try {
				await peer.connection.addIceCandidate(candidate);
			} catch (err) {
				if (!peer.connectionStatus.ignoreOffer) throw err;
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

	private addTransceiverToPeer = (peer: RTCPeer, rtcioStream: RTCIOStream): void => {
		const streamMsId = rtcioStream.mediaStream.id;

		this.log('debug', 'addTransceiverToPeer', {
			peer: peer.socketId,
			rtcioStreamId: rtcioStream.id,
			mediaStreamId: streamMsId,
			trackCount: rtcioStream.mediaStream.getTracks().length,
		});

		// Store the stream reference even if it has no tracks
		peer.streams[streamMsId] = rtcioStream;

		// Initialise transceiver list for this stream if needed
		if (!peer.streamTransceivers[streamMsId]) {
			peer.streamTransceivers[streamMsId] = [];
		}
		
		// Listen for track changes on this stream (e.g. user swaps mic/cam mid-call).
		// The same-kind swap path uses RTCRtpSender.replaceTrack and does NOT change
		// transceiver direction, which is the WebRTC primitive for hot-swapping a
		// track with no SDP renegotiation. Toggling direction (sendonly→inactive→
		// sendonly) would also work but would round-trip an unnecessary offer/answer
		// and briefly mute the receiver.
		rtcioStream.onTrackChanged((stream) => {
			const tracks = stream.getTracks();
			const trackById = new Map(tracks.map(t => [t.id, t]));
			const ownTransceivers = peer.streamTransceivers[streamMsId] ?? [];
			const claimed = new Set<string>();

			// Pass 1: keep already-wired transceivers as-is.
			ownTransceivers.forEach(t => {
				const senderTrack = t.sender.track;
				if (senderTrack && trackById.has(senderTrack.id)) {
					claimed.add(senderTrack.id);
				}
			});

			// Pass 2: rewire transceivers whose sender track was removed.
			//   - If a same-kind replacement exists in the stream, hot-swap via
			//     replaceTrack (no renegotiation).
			//   - Otherwise mark the transceiver inactive (renegotiates) so the
			//     remote stops expecting media on this m-line.
			ownTransceivers.forEach(t => {
				const senderTrack = t.sender.track;
				if (senderTrack && trackById.has(senderTrack.id)) return;

				const kind = senderTrack?.kind ?? t.receiver.track?.kind;
				const replacement = tracks.find(tr => tr.kind === kind && !claimed.has(tr.id));

				if (replacement) {
					t.sender.replaceTrack(replacement);
					if (t.direction !== 'sendonly') t.direction = 'sendonly';
					if (t.sender.setStreams) t.sender.setStreams(rtcioStream.mediaStream);
					claimed.add(replacement.id);
				} else if (senderTrack) {
					t.sender.replaceTrack(null);
					t.direction = 'inactive';
				}
			});

			// Pass 3: brand-new tracks of a kind we don't have a transceiver for.
			tracks.forEach(track => {
				if (claimed.has(track.id)) return;
				const transceiver = peer.connection.addTransceiver(track, {
					direction: 'sendonly',
					streams: [rtcioStream.mediaStream],
				});
				peer.streamTransceivers[streamMsId].push(transceiver);
				claimed.add(track.id);
			});
		});

		const tracks = rtcioStream.mediaStream.getTracks();
		if (tracks.length === 0) {
			// No tracks yet — nothing to negotiate. onTrackChanged will fire when
			// the user adds tracks later and wire up transceivers then.
			return;
		}

		tracks.forEach((track) => {
			{
				// Reuse an unclaimed idle transceiver of the same kind to prevent accumulation.
				const claimedTransceiverIds = new Set(
					Object.values(peer.streamTransceivers).flat().map(t => t.mid)
				);

				const idle = peer.connection.getTransceivers().find(
					t => t.sender.track === null
						&& t.receiver.track?.kind === track.kind
						&& (t.direction === 'sendonly' || t.direction === 'sendrecv' || t.direction === 'inactive')
						&& !claimedTransceiverIds.has(t.mid)
				);

				if (idle) {
					idle.sender.replaceTrack(track);
					idle.direction = "sendonly";
					// setStreams updates a=msid in SDP so the remote ontrack receives the correct stream id.
					if (idle.sender.setStreams) {
						idle.sender.setStreams(rtcioStream.mediaStream);
					}
					peer.streamTransceivers[streamMsId].push(idle);
					this.log('debug', 'Reused idle transceiver', { kind: track.kind, peer: peer.socketId });
				} else {
					const transceiver = peer.connection.addTransceiver(track, {
						direction: "sendonly",
						streams: [rtcioStream.mediaStream],
					});
					peer.streamTransceivers[streamMsId].push(transceiver);
				}
			}
		});
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
			streamTransceivers: {},
			socketId: source,
			polite: options.polite,
			connectionStatus: {
				makingOffer: false,
				ignoreOffer: false,
				isSettingRemoteAnswerPending: false,
				negotiationNeeded: false,
				negotiationInProgress: false,
			},
			ctrlDc: null,
			ctrlQueue: [],
			channels: {},
			channelIds: new Map(),
			connectFired: false,
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

			peer.streams[stream.id] = new RTCIOStream(stream);

			// Handle tracks that arrive after the initial ontrack (e.g. video after audio).
			stream.onaddtrack = ({ track: newTrack }) => {
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
			};

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

		// 'disconnected' is transient — ICE will self-recover or escalate to 'failed'.
		peer.connection.oniceconnectionstatechange = () => {
			this.log('debug', `ICE state: ${peer.connection.iceConnectionState}`, { peer: source });
			switch (peer.connection.iceConnectionState) {
				case "disconnected":
					break;
				case "failed":
					peer.connection.restartIce();
					this.log('debug', 'ICE failed — restarting', { peer: source });
					break;
				case "closed":
					this.cleanupPeer(source);
					break;
				default:
					break;
			}
		};

		// connectionState aggregates ICE + DTLS — more reliable than
		// iceConnectionState alone. Use as primary disconnect handler.
		peer.connection.onconnectionstatechange = () => {
			this.log('debug', `Connection state: ${peer.connection.connectionState}`, { peer: source });
			switch (peer.connection.connectionState) {
				case "failed":
					peer.connection.restartIce();
					this.log('debug', 'Connection failed — restarting ICE', { peer: source });
					break;
				case "closed":
					this.cleanupPeer(source);
					break;
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

	private cleanupPeer(peerId: string) {
		const peer = this.rtcpeers[peerId];
		if (!peer) return;

		this.log('debug', 'Cleaning up peer', { peer: peerId });

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
		Object.values(peer.streams).forEach((s) => s.dispose?.());

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
		if (!peer) return new RTCIOChannel(options.queueBudget);

		let channel = peer.channels[name];
		if (!channel) {
			channel = new RTCIOChannel(options.queueBudget);
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

			const { queueBudget: _qb, ...dcInit } = options;
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