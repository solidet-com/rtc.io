import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";
import { GetEventPayload, MessagePayload } from "./payload";
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
	streamTransceivers: Record<string, RTCRtpTransceiver[]>; // mediaStream.id → transceivers for that stream
};

type connectionStatus = {
	makingOffer: boolean;
	ignoreOffer: boolean;
	isSettingRemoteAnswerPending: boolean;
	negotiationNeeded: boolean;      // coalesce rapid-fire onnegotiationneeded
	negotiationInProgress: boolean;  // true while an offer is in-flight
};

export class Socket extends RootSocket {
	private rtcpeers: Record<string, RTCPeer>;
	private streamEvents: Record<string, any>; // Events Payloads including RTCIOStream, stream.id:event-payload
	private signalingQueues: Record<string, Promise<void>>; // Per-peer serial queue
	public debug: boolean;

	private readonly servers: RTCConfiguration;

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

		this.on("#init-rtc-offer", this.initializeConnection);
		this.on("#rtc-message", this.enqueueSignalingMessage);

		/*
		this.on("#offer", this.createAnswer);
		this.on("#answer", this.addAnswer);
		this.on("#candidate", this.addIceCandidate);
        */
	}

	// ─── Structured Logging ──────────────────────────────────────────────
	private log(level: 'debug' | 'warn' | 'error', msg: string, data?: any) {
		if (level === 'debug' && !this.debug) return;
		const prefix = `[rtc-io][${this.id?.slice(-6) ?? '------'}]`;
		console[level](`${prefix} ${msg}`, data ?? '');
	}

	emit(ev: string, ...args: any[]): this {
		const stream = this.getRTCIOStreamDeep(args);
		if (stream) {
			/**
			 * const videoYayini = new RTCIOStream(mediaStream);
			 *
			 * rtcio.emit('video-channel1', {streamer: 'mehmet', stream: videoYayini})
			 * rtcio.emit('video-channel2', {streamer: 'mehmet', stream: videoYayini})
			 *
			 */

			// streamEvents: {
			// 	'47983749384739(videoyayini)': {
			// 		'video-channel': {streamer: 'mehmet', stream: 'ahmet' },
			// 		'video-channel2': {streamer: 'mehmet', stream: 'ahmet' },
			//  }
			// }

			this.log('debug', `emit stream event: ${ev}`, { streamId: stream.id });
			if (!this.streamEvents[stream.id]) {
				this.streamEvents[stream.id] = {};
			}
			this.streamEvents[stream.id][ev] = args;

			this.broadcastPeers(this.addTransceiverToPeer, stream);
		} else {
			super.emit(ev, ...args);
		}

		return this;
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

	// ─── Signaling serialization: per-peer async queue ───────────────────
	// Prevents two signaling messages from interleaving their async steps
	// (e.g. two offers arriving back-to-back, or an offer + answer crossing).
	private enqueueSignalingMessage = (payload: MessagePayload) => {
		const peerId = payload.source;
		const prev = this.signalingQueues[peerId] ?? Promise.resolve();
		this.signalingQueues[peerId] = prev.then(() =>
			this.handleCallServiceMessage(payload).catch((err) => {
				this.log('error', 'Signaling error', { peer: peerId, err });
			})
		);
	};

	// ─── W3C Perfect Negotiation: Incoming signaling message handler ─────
	// Reference: https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
	async handleCallServiceMessage(payload: MessagePayload) {
		const { source } = payload;

		let isNewPeer = false;
		let peer = this.getPeer(source);
		if (!peer) {
			// Create bare connection — do NOT replay streams yet.
			// Stream replay happens AFTER the initial offer/answer exchange
			// to prevent onnegotiationneeded from racing with setRemoteDescription.
			peer = this.createPeerConnection(payload, { polite: false });
			// NOTE: Do NOT create a data channel here. The impolite side
			// receives the data channel from the polite peer (who creates it
			// in initializeConnection). Creating one here would fire
			// onnegotiationneeded, causing the impolite side to send an offer
			// that races with the incoming offer, leading to glare where
			// subsequent offers carrying stream tracks get dropped.
			isNewPeer = true;
			this.log('debug', 'Created impolite peer (deferred stream replay)', { peer: source });
		}

		const { description, candidate, mid, events } = payload.data;
		if (description) {
			this.log('debug', `Received ${description.type}`, { peer: source, signalingState: peer.connection.signalingState });

			// ── Perfect Negotiation: collision detection ──────────────────
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

			// ── Perfect Negotiation: single setRemoteDescription path ────
			// The W3C spec uses ONE setRemoteDescription call for ALL types.
			// The browser handles rollback implicitly when we call
			// setRemoteDescription(offer) while in have-local-offer state
			// (for polite peers). No manual rollback needed.
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

			// ── Perfect Negotiation: answer with implicit SDP creation ───
			if (description.type === "offer") {
				await peer.connection.setLocalDescription();
				this.emit("#rtc-message", {
					source: this.id,
					target: peer.socketId,
					data: {
						description: peer.connection.localDescription,
					},
				});
				this.log('debug', 'Sent answer', { peer: source });
			}

			// Now that signaling is stable, safe to add local tracks.
			// Defer to next microtask so the current signaling handler
			// finishes completely before onnegotiationneeded fires.
			if (isNewPeer) {
				queueMicrotask(() => this.replayStreamsToPeer(peer));
			}
		} else if (candidate) {
			try {
				await peer.connection.addIceCandidate(candidate);
			} catch (err) {
				if (!peer.connectionStatus.ignoreOffer) throw err;
			}
		} else if (events) {
			const rtcioStream = peer.streams[mid]; //id asil idden farkli.!

			this.log('debug', 'Received stream events', { mid, events, hasStream: !!rtcioStream, peerStreamKeys: Object.keys(peer.streams) });

			if (!rtcioStream) {
				this.log('warn', 'Stream not found for events — stream not yet registered via ontrack', { mid, peerStreams: Object.keys(peer.streams) });
				return;
			}

			Object.keys(events).forEach((key) => {
				this.listeners(key).forEach((listener) => {
					const subEvents: any[] = events[key];
					subEvents.forEach((subEvent: any) => {
						listener(
							this.deserializeStreamEvent(subEvent, rtcioStream),
						);
					});
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
			if (!events) {
				this.streamEvents[rtcioStream.id] = {};
			}

			const payload: GetEventPayload = {
				source: this.id!,
				target: peer.socketId,
				data: this.serializeStreamEvent({
					mid,
					events: this.streamEvents[rtcioStream.id],
				}),
			};

			this.emit("#rtc-message", payload);
		}
	}

	// ─── Replay local streams to a peer after signaling is stable ────
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
	 * Initializes the peer connection.
	 * Used for the POLITE path (via #init-rtc-offer).
	 * Polite peers initiate the offer, so replaying streams immediately is safe —
	 * there's no incoming offer to collide with.
	 */
	initializeConnection(
		payload: MessagePayload,
		options: { polite: boolean } = { polite: true },
	) {
		try {
			const peer = this.createPeerConnection(payload, options);
			
			//  data channel to connect with even without media
			peer.connection.createDataChannel("connectionSetup");
			
			//  add transceivers if there are streams 
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
				//media streamin'id sini looplayacak konuma geliyor
			}
		} catch (err) {
			this.log('error', 'deserializeStreamEvent failed', { err });
		}

		return data;
	}

	// ─── Transceiver management: reuse idle + sendonly direction ─────────
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
		
		// Listen for track changes on this stream (e.g. user toggles camera)
		rtcioStream.onTrackChanged((stream) => {
			const tracks = stream.getTracks();
			const ownTransceivers = peer.streamTransceivers[streamMsId] ?? [];

			tracks.forEach(track => {
				// Only look at transceivers that belong to THIS stream
				const existingTransceiver = ownTransceivers.find(
					t => t.sender.track && t.sender.track.kind === track.kind
				);
				
				if (existingTransceiver) {
					existingTransceiver.sender.replaceTrack(track);
				} else {
					const transceiver = peer.connection.addTransceiver(track, {
						direction: "sendonly",
						streams: [rtcioStream.mediaStream],
					});
					peer.streamTransceivers[streamMsId].push(transceiver);
				}
			});
			// Browser fires onnegotiationneeded automatically after addTransceiver
		});

		const tracks = rtcioStream.mediaStream.getTracks();
		if (tracks.length === 0) {
			// Placeholder transceiver so the peer knows we have a stream slot
			const transceiver = peer.connection.addTransceiver('audio', {
				direction: "sendonly"
			});
			peer.streamTransceivers[streamMsId].push(transceiver);
			return;
		}

		tracks.forEach((track) => {
			if (track.kind === 'audio' || track.kind === 'video') {
				// Reuse existing idle transceiver (sender.track === null, same kind)
				// instead of always creating a new one — prevents transceiver accumulation.
				// Only consider transceivers NOT already claimed by another stream.
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
					// CRITICAL: update the stream association so the remote
					// ontrack receives the correct streams[0].id (a=msid: in SDP).
					// Without this, the reused transceiver keeps its old msid and
					// the remote peer cannot look up the stream for event metadata.
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
		};

		//webcam transceiver,
		//screen share transceiver

		const peer = this.rtcpeers[source];

		this.log('debug', `Created peer connection`, { peer: source, polite: options.polite });

		// ─── ontrack: handle incoming remote tracks ──────────────────────
		// Uses stream.onaddtrack for late-arriving tracks instead of timers.
		// Handles empty streams array by creating a synthetic stream.
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

				// Notify about track addition
				this.listeners("track-added").forEach((listener) => {
					(listener as Function)({
						peerId: source,
						stream: existingStream,
						track: track,
					});
				});

				return;
			}

			// New stream — register it
			peer.streams[stream.id] = new RTCIOStream(stream);

			// Bug #3: Listen for future tracks arriving on this same stream.
			// The browser fires 'addtrack' when a new track is associated with
			// this MediaStream (e.g., video arriving after audio).
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
			this.emit("#rtc-message", eventPayload);
		};

		// ─── ICE state machine ──────────────────────────────────────────
		// 'disconnected' is transient and will auto-recover or transition to 'failed'.
		peer.connection.oniceconnectionstatechange = () => {
			this.log('debug', `ICE state: ${peer.connection.iceConnectionState}`, { peer: source });
			switch (peer.connection.iceConnectionState) {
				case "disconnected":
					// Transient state — do nothing. ICE will self-recover
					// or transition to 'failed' if unrecoverable.
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

				this.emit("#rtc-message", payload);
			}
		};

		// ── W3C Perfect Negotiation: onnegotiationneeded ─────────────────
		// Reference: https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
		// Coalesced: when multiple transceivers are added in the same tick
		// (e.g. data-channel + cam + screen), the browser may fire
		// onnegotiationneeded for each one. We coalesce them into a
		// single offer round to avoid "answer in stable state" errors
		// caused by remote answers arriving for superseded offers.
		peer.connection.onnegotiationneeded = async () => {
			peer.connectionStatus.negotiationNeeded = true;

			// If we're already in the middle of a negotiation round,
			// just mark the flag — the finally block will re-trigger.
			if (peer.connectionStatus.negotiationInProgress) {
				this.log('debug', 'onnegotiationneeded coalesced (negotiation in progress)', { peer: source });
				return;
			}

			// Yield to allow further synchronous addTransceiver calls to
			// set the flag before we start the offer.
			await Promise.resolve();

			while (peer.connectionStatus.negotiationNeeded) {
				peer.connectionStatus.negotiationNeeded = false;
				peer.connectionStatus.negotiationInProgress = true;
				try {
					peer.connectionStatus.makingOffer = true;
					this.log('debug', 'onnegotiationneeded — creating offer', { peer: source });

					await peer.connection.setLocalDescription();

					this.emit("#rtc-message", {
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

		return peer;
	};

	// ─── Centralized peer cleanup ────────────────────────────────────
	// Closes the connection, removes all references, and notifies
	// the application.
	private cleanupPeer(peerId: string) {
		const peer = this.rtcpeers[peerId];
		if (!peer) return;

		this.log('debug', 'Cleaning up peer', { peer: peerId });

		peer.connection.close();
		delete this.rtcpeers[peerId];
		delete this.signalingQueues[peerId];

		this.listeners("peer-disconnect").forEach((listener) => {
			(listener as (data: unknown) => void)({ id: peerId });
		});
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