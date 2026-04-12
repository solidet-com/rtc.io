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
	isActive: boolean;
};

export class Socket extends RootSocket {
	private rtcpeers: Record<string, RTCPeer>;
	private streamEvents: Record<string, any>; // Events Payloads including RTCIOStream, stream.id:event-payload
	private signalingQueues: Record<string, Promise<void>>; // Per-peer serial queue

	private readonly servers = {
		iceServers: [
			{
				urls: [
					"stun:stun1.l.google.com:19302",
					"stun:stun2.l.google.com:19302",
				],
			},
		],
	};

	constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>) {
		super(io, nsp, opts);

		this.rtcpeers = {};
		this.streamEvents = {};
		this.signalingQueues = {};

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
		const prefix = `[rtc-io][${this.id?.slice(-6) ?? '------'}]`;
		console[level](`${prefix} ${msg}`, data ?? '');
	}

	emit(ev, ...args): this {
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
			this.streamEvents[stream.id] = {
				[ev]: args,
			};

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

	// ─── Bug #1 Fix: Defer stream replay for impolite peers ──────────────
	async handleCallServiceMessage(payload: MessagePayload) {
		const { source } = payload;

		let isNewPeer = false;
		let peer = this.getPeer(source);
		if (!peer) {
			// Create bare connection — do NOT replay streams yet.
			// Stream replay happens AFTER the initial offer/answer exchange
			// to prevent onnegotiationneeded from racing with setRemoteDescription.
			peer = this.createPeerConnection(payload, { polite: false });
			peer.connection.createDataChannel("connectionSetup");
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
				if (offerCollision) {
					// Polite peer: rollback our own offer, then apply the remote offer.
					// Only rollback if we're actually in have-local-offer;
					// if we're already stable (e.g. our offer finished while queued)
					// just apply the remote description directly.
					this.log('debug', 'Offer collision (polite) — rolling back', { peer: source });
					if (peer.connection.signalingState !== "stable") {
						await peer.connection.setLocalDescription({ type: "rollback" });
					}
					await peer.connection.setRemoteDescription(description);
				} else if (description.type === "answer") {
					// Guard: only apply an answer when we're actually expecting one
					if (peer.connection.signalingState === "have-local-offer") {
						await peer.connection.setRemoteDescription(description);
					} else {
						this.log('warn', `Dropping stale answer (state: ${peer.connection.signalingState})`, { peer: source });
						return;
					}
				} else {
					// Normal offer when we're stable
					await peer.connection.setRemoteDescription(description);
				}
			} catch (err: any) {
				if (err?.name === 'InvalidStateError') {
					this.log('warn', `setRemoteDescription InvalidStateError (state: ${peer.connection.signalingState}), dropping`, { peer: source });
					return;
				}
				throw err;
			}

			peer.connectionStatus.isSettingRemoteAnswerPending = false;

			if (description.type === "offer") {
				try {
					const answer = await peer.connection.createAnswer();

					// Re-check state: between createAnswer and now, another
					// message could have changed the state via the queue.
					if (peer.connection.signalingState === "have-remote-offer") {
						await peer.connection.setLocalDescription(answer);

						this.emit("#rtc-message", {
							source: this.id,
							target: peer.socketId,
							data: {
								description: peer.connection.localDescription,
							},
						});
						this.log('debug', 'Sent answer', { peer: source });
					} else {
						this.log('warn', `Skipping setLocalDescription(answer) — state became ${peer.connection.signalingState}`, { peer: source });
					}
				} catch (err: any) {
					if (err?.name === 'InvalidStateError') {
						this.log('warn', `createAnswer/setLocalDescription InvalidStateError (state: ${peer.connection.signalingState})`, { peer: source });
					} else {
						throw err;
					}
				}
			}

			// Bug #1: Now that signaling is stable, safe to add local tracks
			// without onnegotiationneeded racing with the incoming offer.
			if (isNewPeer) {
				this.replayStreamsToPeer(peer);
			}
		} else if (candidate) {
			try {
				await peer.connection.addIceCandidate(candidate);
			} catch (error) {
				if (!peer.connectionStatus.ignoreOffer) throw error;
			}
		} else if (events) {
			const rtcioStream = peer.streams[mid]; //id asil idden farkli.!

			this.log('debug', 'Received stream events', { mid, events });

			Object.keys(events).forEach((key) => {
				this.listeners(key).forEach((listener) => {
					const subEvents = events[key];
					subEvents.forEach((subEvent) => {
						listener(
							this.deserializeStreamEvent(subEvent, rtcioStream),
						);
					});
				});
			});
		} else if (mid) {
			const rtcioStream = peer.streams[mid];
			if (!rtcioStream)
				throw new Error(
					`Transceiver with mid ${mid} not found in peer ${source}`,
				);

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

	// ─── Bug #1: Replay local streams to a peer after signaling is stable ─
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

			// Broadcast existing streams to the new peer
			this.broadcastExistingStreams(peer);

			this.log('debug', `Initialized ${options.polite ? 'polite' : 'impolite'} peer`, { peer: payload.source });
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error(error);
		} finally {
			return this.getPeer(payload.source);
		}
	}

	private broadcastExistingStreams(newPeer: RTCPeer) {
		// Get all existing peers except the new one
		const existingPeers = Object.values(this.rtcpeers).filter(p => p.socketId !== newPeer.socketId);
		
		// For each existing peer, share their streams with the new peer
		existingPeers.forEach(existingPeer => {
			Object.values(existingPeer.streams).forEach(stream => {
				if (stream.mediaStream) {
					// Add the stream to streamEvents if it doesn't exist
					if (!this.streamEvents[stream.id]) {
						this.streamEvents[stream.id] = {};
					}
					this.addTransceiverToPeer(newPeer, stream);
				}
			});
		});
	}

	serializeStreamEvent(data) {
		if (data instanceof RTCIOStream) {
			return data.toJSON();
		}
		try {
			if (data && typeof data === "object") {
				for (const key in data) {
					data[key] = this.serializeStreamEvent(data[key]);
				}
			}
		} catch (err) {
			console.error(data);
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
			console.error(data);
		}

		return data;
	}

	// ─── Bug #4 & #5: Idle transceiver reuse + sendonly direction ─────────
	addTransceiverToPeer(peer: RTCPeer, rtcioStream: RTCIOStream) {
		let transceiver!: RTCRtpTransceiver;

		// Store the stream reference even if it has no tracks
		peer.streams[rtcioStream.mediaStream.id] = rtcioStream;
		
		rtcioStream.onTrackChanged((stream) => {
			const tracks = stream.getTracks();
			tracks.forEach(track => {
				const existingTransceiver = Array.from(peer.connection.getTransceivers()).find(
					t => t.sender.track && t.sender.track.kind === track.kind
				);
				
				if (existingTransceiver) {
					existingTransceiver.sender.replaceTrack(track);
				} else {
					// Bug #5: Use sendonly for outbound streams
					peer.connection.addTransceiver(track, {
						direction: "sendonly",
						streams: [rtcioStream.mediaStream],
					});
				}
			});
			// Browser fires onnegotiationneeded automatically after addTransceiver
		});

		const tracks = rtcioStream.mediaStream.getTracks();
		if (tracks.length === 0) {
			// Bug #5: sendonly for placeholder transceiver
			transceiver = peer.connection.addTransceiver('audio', {
				direction: "sendonly"
			});
			// Browser fires onnegotiationneeded automatically
			return;
		}

		tracks.forEach((track) => {
			//  if user has sent an audio or video stream
			if (track.kind === 'audio' || track.kind === 'video') {
				// Bug #4: Reuse existing idle transceiver (sender.track === null, same kind)
				// instead of always creating a new one — prevents transceiver accumulation on toggle
				const idle = peer.connection.getTransceivers().find(
					t => t.sender.track === null
						&& t.receiver.track?.kind === track.kind
						&& (t.direction === 'sendonly' || t.direction === 'sendrecv' || t.direction === 'inactive')
				);

				if (idle) {
					idle.sender.replaceTrack(track);
					idle.direction = "sendonly";
					this.log('debug', 'Reused idle transceiver', { kind: track.kind, peer: peer.socketId });
				} else {
					// Bug #5: sendonly for outbound streams in mesh P2P topology
					transceiver = peer.connection.addTransceiver(track, {
						direction: "sendonly",
						streams: [rtcioStream.mediaStream],
					});
				}

				peer.streams[rtcioStream.mediaStream.id] = rtcioStream;
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
			socketId: source,
			polite: options.polite,
			connectionStatus: {
				makingOffer: false,
				ignoreOffer: false,
				isSettingRemoteAnswerPending: false,
				isActive: true,
			},
		};

		//webcam transceiver,
		//screen share transceiver

		const peer = this.rtcpeers[source];

		this.log('debug', `Created peer connection`, { peer: source, polite: options.polite });

		// ─── Bug #3 & #6: Rewritten ontrack handler ──────────────────────
		// Uses stream.onaddtrack for late-arriving tracks instead of timers.
		// Handles empty streams array (Bug #6) by creating a synthetic stream.
		peer.connection.ontrack = ({ transceiver, track, streams }) => {
			let stream = streams[0];

			// Bug #6: Handle empty streams array — create synthetic MediaStream
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
			// this MediaStream (e.g., video arriving after audio). This is the
			// event-driven alternative to debouncing with timers.
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

		// ─── Bug #2: Proper ICE state machine — no premature deletion ────
		// 'disconnected' is transient: ICE will auto-transition to 'failed'
		// if recovery is not possible. No timers needed.
		peer.connection.oniceconnectionstatechange = () => {
			this.log('debug', `ICE state: ${peer.connection.iceConnectionState}`, { peer: source });
			switch (peer.connection.iceConnectionState) {
				case "disconnected":
					// Bug #2: Transient state — do nothing.
					// The ICE agent will self-transition to 'failed' if unrecoverable,
					// or recover to 'connected'/'completed' on its own.
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

		// Bug #2: connectionState aggregates ICE + DTLS — more reliable
		// than iceConnectionState alone. Use as primary state handler.
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

		peer.connection.onnegotiationneeded = async () => {
			// Skip if we're in the middle of handling a remote offer
			if (peer.connection.signalingState !== "stable") {
				this.log('debug', `onnegotiationneeded skipped (state: ${peer.connection.signalingState})`, { peer: source });
				return;
			}

			if (peer.connectionStatus.makingOffer) {
				this.log('debug', 'onnegotiationneeded skipped (already making offer)', { peer: source });
				return;
			}

			try {
				peer.connectionStatus.makingOffer = true;
				this.log('debug', 'onnegotiationneeded — creating offer', { peer: source });

				// Use the implicit offer creation path: setLocalDescription()
				// with no arguments lets the browser create the correct SDP
				// and avoids the race between createOffer() and state changes.
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
				if (error?.name === 'InvalidStateError') {
					this.log('warn', `onnegotiationneeded InvalidStateError (state: ${peer.connection.signalingState}), skipping`, { peer: source });
				} else {
					console.error(error);
				}
			} finally {
				peer.connectionStatus.makingOffer = false;
			}
		};

		return peer;
	};

	// ─── Bug #2 & #7: Centralized peer cleanup ───────────────────────────
	// Properly closes the connection, removes all references, and notifies
	// the application. Stale stream references are garbage-collected with
	// the peer object.
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

	private broadcastPeers = (cb: Function, ...args: any[]) => {
		if (!this.connected) return;

		Object.values(this.rtcpeers).forEach((peer) => {
			cb(peer, ...args);
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