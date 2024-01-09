import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers: RTCIceServer[];
}

type RTCPeer = {
	connection: RTCPeerConnection;
	mediaStream: MediaStream;
};

export class Socket extends RootSocket {
	private rtcpeers: Record<string, RTCPeer>;
	private localStream?: MediaStream;
	private iceEvents = ["offer", "answer", "candidate"];

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
		this.on("#init-rtc-offer", this.createOffer);
		this.on("#offer", this.createAnswer);
		this.on("#answer", this.addAnswer);
		this.on("#candidate", this.addIceCandidate);
	}

	getPeer(id: string) {
		return this.rtcpeers[id];
	}

	createPeerConnection = (payload: MessagePayload): RTCPeer => {
		const peerConnection = new RTCPeerConnection(this.servers);
		const { source } = payload;

		this.rtcpeers[source] = {
			connection: peerConnection,
			mediaStream: new MediaStream(),
		};

		const peer = this.rtcpeers[source];

		this.localStream?.getTracks().forEach((track) => {
			if (!peer.connection) return;
			if (!this.localStream) return;

			peer.connection.addTrack(track, this.localStream);
		});

		peer.connection.ontrack = (event) => {
			event.streams[0].getTracks().forEach((track) => {
				console.log(
					"adding track to peer media stream",
					peer.mediaStream,
				);
				peer.mediaStream.addTrack(track);
			});
		};

		peer.connection.onicecandidate = async (event) => {
			if (event.candidate) {
				const payload: MessagePayload<RTCIceCandidate> = {
					source: this.id,
					target: source,
					data: event.candidate,
				};

				this.emit("#candidate", payload);
			}
		};

		this.listeners("stream").forEach((listener) => {
			listener({
				streamerId: source,
				mediaStream: peer.mediaStream,
			});
		});

		return peer;
	};

	stream = async (stream: MediaStream) => {
		if (!this.connected) return;

		this.localStream = stream;
		//TODO: Check if peers have local stream already
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

	async getSessionStats(peerId) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;
		return await getRTCStats(peerConnection, {});
	}

	async getIceCandidateStats(peerId) {
		const peerConnection = this.getPeer(peerId)?.connection;
		if (!peerConnection) return null;
		return await getRTCIceCandidateStatsReport(peerConnection);
	}

	createOffer = async (payload: MessagePayload<null>) => {
		const peerConnection = this.createPeerConnection(payload)?.connection;
		if (!peerConnection) return;

		let offer = await peerConnection.createOffer();
		await peerConnection.setLocalDescription(offer);

		const _payload: MessagePayload<RTCSessionDescriptionInit> = {
			source: this.id,
			target: payload.source,
			data: offer,
		};

		this.emit("#offer", _payload);
	};

	async addIceCandidate(payload: MessagePayload<RTCIceCandidate>) {
		const peerConnection = this.getPeer(payload.source)?.connection;
		if (!peerConnection) return;

		await peerConnection
			.addIceCandidate(payload.data)
			.then(() => {})
			.catch((error) => {
				console.error("Error adding ICE candidate:", error);
			});
	}

	async addAnswer(payload: MessagePayload<RTCSessionDescriptionInit>) {
		const peer = this.getPeer(payload.source);
		if (!peer) return;

		if (!peer?.connection.currentRemoteDescription) {
			peer.connection.setRemoteDescription(payload.data);
		}
	}

	async createAnswer(payload: MessagePayload<RTCSessionDescriptionInit>) {
		const peer = this.createPeerConnection(payload);

		if (!peer?.connection) return;
		await peer?.connection.setRemoteDescription(payload.data);

		let answer = await peer.connection.createAnswer();
		await peer.connection.setLocalDescription(answer);

		const _payload: MessagePayload<RTCSessionDescriptionInit> = {
			source: this.id,
			target: payload.source,
			data: answer,
		};

		this.emit("#answer", _payload);
	}
}
