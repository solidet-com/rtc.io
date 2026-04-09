import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";
import { MessagePayload } from "./payload";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers?: RTCIceServer[];
}

type RTCPeer = {
	connection: RTCPeerConnection;
	socketId: string;
	polite: boolean;
	connectionStatus: ConnectionStatus;
	streams: Record<string, MediaStream>;
	emittedStreamIds: Set<string>;
};

type ConnectionStatus = {
	makingOffer: boolean;
	ignoreOffer: boolean;
	isSettingRemoteAnswerPending: boolean;
};

export class Socket extends RootSocket {
	private rtcpeers: Record<string, RTCPeer>;
	private localStreams: Record<string, MediaStream>; // keyed by name
	private readonly servers: RTCConfiguration;

	// Correlate stream.id → name when #stream-meta arrives before ontrack
	private streamNameMap: Record<string, { peerId: string; name: string }> = {};
	// Hold stream when ontrack fires before #stream-meta arrives
	private pendingTracks: Record<
		string,
		{ peerId: string; stream: MediaStream }
	> = {};

	constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>) {
		super(io, nsp, opts);

		this.servers = {
			iceServers: opts?.iceServers ?? [
				{
					urls: [
						"stun:stun1.l.google.com:19302",
						"stun:stun2.l.google.com:19302",
					],
				},
			],
		};

		this.rtcpeers = {};
		this.localStreams = {};

		this.on("#init-rtc-offer", this.initializeConnection);
		this.on("#rtc-message", this.handleCallServiceMessage);
		this.on("#stream-meta", this.handleStreamMeta);
	}

	getPeer(id: string) {
		return this.rtcpeers[id];
	}

	async handleCallServiceMessage(payload: MessagePayload) {
		const { source } = payload;

		const peer =
			this.getPeer(source) ??
			this.initializeConnection(payload, { polite: false });
		if (!peer) return;

		const { description, candidate } = payload.data;

		if (description) {
			const readyForOffer =
				!peer.connectionStatus.makingOffer &&
				(peer.connection.signalingState === "stable" ||
					peer.connectionStatus.isSettingRemoteAnswerPending);

			const offerCollision = description.type === "offer" && !readyForOffer;

			peer.connectionStatus.ignoreOffer = !peer.polite && offerCollision;

			if (peer.connectionStatus.ignoreOffer) return;

			peer.connectionStatus.isSettingRemoteAnswerPending =
				description.type === "answer";

			if (offerCollision) {
				await Promise.all([
					peer.connection.setLocalDescription({ type: "rollback" }),
					peer.connection.setRemoteDescription(description),
				]);
			} else {
				await peer.connection.setRemoteDescription(description);
			}

			peer.connectionStatus.isSettingRemoteAnswerPending = false;

			if (description.type === "offer") {
				const answer = await peer.connection.createAnswer();
				await peer.connection.setLocalDescription(answer);
				this.emit("#rtc-message", {
					source: this.id,
					target: peer.socketId,
					data: { description: peer.connection.localDescription },
				});
			}
		} else if (candidate) {
			try {
				await peer.connection.addIceCandidate(candidate);
			} catch (error) {
				if (!peer.connectionStatus.ignoreOffer) throw error;
			}
		}
	}

	handleStreamMeta = (
		payload: MessagePayload<{ streamId: string; name: string }>,
	) => {
		const {
			source,
			data: { streamId, name },
		} = payload;

		const pending = this.pendingTracks[streamId];
		if (pending) {
			delete this.pendingTracks[streamId];
			this.listeners(name).forEach((listener) => {
				listener({ id: source, stream: pending.stream });
			});
		} else {
			this.streamNameMap[streamId] = { peerId: source, name };
		}
	};

	initializeConnection(
		payload: MessagePayload,
		options: { polite: boolean } = { polite: true },
	): RTCPeer | undefined {
		try {
			const peer = this.createPeerConnection(payload, options);
			for (const name in this.localStreams) {
				const mediaStream = this.localStreams[name];
				this.addTransceiverPeerConnection(peer.connection, mediaStream);
				this.sendStreamMeta(peer.socketId, name, mediaStream);
			}
			return peer;
		} catch (error) {
			console.error(error);
			return undefined;
		}
	}

	addTransceiverPeerConnection(
		peerConnection: RTCPeerConnection,
		stream: MediaStream,
	) {
		stream.getTracks().forEach((track) => {
			peerConnection.addTransceiver(track, {
				direction: "sendrecv",
				streams: [stream],
			});
		});
	}

	stopLocalStreamTracks(localStream: MediaStream) {
		localStream.getTracks().forEach((track) => track.stop());
	}

	createPeerConnection(
		payload: MessagePayload,
		options: { polite: boolean },
	): RTCPeer {
		const peerConnection = new RTCPeerConnection(this.servers);
		const { source } = payload;

		this.rtcpeers[source] = {
			connection: peerConnection,
			streams: {},
			socketId: source,
			polite: options.polite,
			emittedStreamIds: new Set(),
			connectionStatus: {
				makingOffer: false,
				ignoreOffer: false,
				isSettingRemoteAnswerPending: false,
			},
		};

		const peer = this.rtcpeers[source];

		peer.connection.ontrack = ({ transceiver, streams: [stream] }) => {
			if (!stream) return;

			peer.streams[transceiver.mid ?? transceiver.receiver.track.id] = stream;

			// ontrack fires once per track; deduplicate to emit once per stream
			if (peer.emittedStreamIds.has(stream.id)) return;
			peer.emittedStreamIds.add(stream.id);

			const meta = this.streamNameMap[stream.id];
			if (meta) {
				delete this.streamNameMap[stream.id];
				this.listeners(meta.name).forEach((listener) => {
					listener({ id: source, stream });
				});
			} else {
				// #stream-meta hasn't arrived yet — hold until it does
				this.pendingTracks[stream.id] = { peerId: source, stream };
			}
		};

		peer.connection.oniceconnectionstatechange = () => {
			switch (peer.connection.iceConnectionState) {
				case "disconnected":
					delete this.rtcpeers[source];
					this.listeners("peer-disconnect").forEach((listener) => {
						listener({ id: source });
					});
					break;
				case "failed":
					peer.connection.restartIce?.();
					break;
				case "closed":
					delete this.rtcpeers[source];
					break;
				default:
					break;
			}
		};

		peer.connection.onicecandidate = (event) => {
			if (event.candidate) {
				this.emit("#rtc-message", {
					source: this.id!,
					target: source,
					data: { candidate: event.candidate },
				});
			}
		};

		peer.connection.onnegotiationneeded = async () => {
			if (peer.connection.signalingState === "have-remote-offer") return;
			if (peer.connectionStatus.makingOffer) return;
			try {
				peer.connectionStatus.makingOffer = true;
				const offer = await peer.connection.createOffer();
				await peer.connection.setLocalDescription(offer);
				this.emit("#rtc-message", {
					target: peer.socketId,
					source: this.id,
					data: { description: peer.connection.localDescription },
				});
			} catch (error) {
				console.error(error);
			} finally {
				peer.connectionStatus.makingOffer = false;
			}
		};

		return peer;
	}

	private sendStreamMeta(targetId: string, name: string, stream: MediaStream) {
		this.emit("#stream-meta", {
			source: this.id,
			target: targetId,
			data: { streamId: stream.id, name },
		});
	}

	stream = (name: string, mediaStream: MediaStream) => {
		this.localStreams[name] = mediaStream;
		if (!this.connected) return;

		Object.values(this.rtcpeers).forEach((peer) => {
			this.addTransceiverPeerConnection(peer.connection, mediaStream);
			this.sendStreamMeta(peer.socketId, name, mediaStream);
		});
	};

	async getStats(peerId: string) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;

		const statsMap = new Map<string, any[]>();
		const stats = await peerConnection.getStats();
		stats.forEach((report) => {
			if (!statsMap.has(report.type)) statsMap.set(report.type, []);
			statsMap.get(report.type)!.push({ report, description: report.type });
		});
		return statsMap;
	}

	async getSessionStats(peerId: string) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;
		return getRTCStats(peerConnection, {});
	}

	async getIceCandidateStats(peerId: string) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;
		return getRTCIceCandidateStatsReport(peerConnection);
	}
}
