import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers: RTCIceServer[];
}

export class Socket extends RootSocket {
	private rtcpeers: Record<
		string,
		{
			connection: RTCPeerConnection;
			mediaStream: MediaStream;
			handshaked?: boolean;
		}
	>;
	private localStream?: MediaStream;
	public rtcId?: string;
	private iceEvents = ["offer", "answer", "candidate"];
	private userEvents = ["user-joined", "user-left"];

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
	}

	createPeerConnection = async (uid: any, fromId: any) => {
		const peerConnection = new RTCPeerConnection(this.servers);

		this.rtcpeers[fromId] = {
			connection: peerConnection,
			mediaStream: new MediaStream(),
		};

		const peer = this.rtcpeers[fromId];

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
				this.emit("candidate", {
					candidate: event.candidate,
					uid,
				});
			}
		};

		peer.connection.onicegatheringstatechange = (event) => {
			console.log("icegatheringstatechange", peer.connection.iceGatheringState);
			switch (peer.connection.iceGatheringState) {
				case "new":
					/* gathering is either just starting or has been reset */
					break;
				case "gathering":
					/* gathering has begun or is ongoing */
					break;
				case "complete":
					peer.handshaked = true;		
					break;
			}
		};

		this.listeners("stream").forEach((listener) => {
			listener({
				streamerId: fromId,
				mediaStream: peer.mediaStream,
			});
		});
	};

	stream = async (stream: MediaStream) => {
		if (!this.connected) return;

		this.localStream = stream;

		this._login();
		this.userEvents.forEach((eventName) => {
			this.on(eventName, (data) => {
				this._onuseraction(eventName, data);
			});
		});

		this.on("login", (data) => {
			this.rtcId = data;
		});
		this.iceEvents.forEach((eventName) => {
			this.on(eventName, (data) => {
				this._onmediastream(eventName, data);
			});
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

	_login() {
		this.emit("login", {
			room: "/",
		});
	}

	emit<Ev extends string>(ev: Ev, ...args: any[]): this {
		return super.emit(ev, ...args);
	}

	private _onmediastream = (event: string, data: any) => {
		this.handleMessageFromPeer(event, data, data.uid, data.from);
	};

	private _onuseraction = (eventName: string, data: any) => {
		switch (eventName) {
			case "user-joined":
				console.log("biri girdi", data);
				this.handleUserJoined(data.uid, data.from);
				break;

			case "user-left":
				console.log("biri çıktı", data);
				this.handleUserLeft(data.uid);
				break;

			default:
				console.warn("Unhandled event:", eventName);
		}
	};

	handleUserJoined = async (uid: any, fromId) => {
		console.log("biri girdi");
		this.createOffer(uid, fromId);
	};

	createOffer = async (uid, fromId) => {
		await this.createPeerConnection(uid, fromId);
		const peerConnection = this.getPeer(fromId)?.connection;
		if (!peerConnection) return;

		let offer = await peerConnection.createOffer();
		await peerConnection.setLocalDescription(offer);
		this.emit("offer", {
			offer: offer,
			uid,
			from: fromId,
		});
	};

	async handleMessageFromPeer(event, message, uid, from) {
		const peer = this.getPeer(from);
		const peerConnection = peer?.connection;

		switch (event) {
			case "offer":
				// if (peer?.handshaked) return;
				this.createAnswer(uid, message.offer, from);
				break;

			case "answer":
				// if (peer?.handshaked) return;
				this.addAnswer(message.answer, from);
				break;

			case "candidate":
				if (peerConnection) {
					peerConnection
						.addIceCandidate(message.candidate)
						.then(() => {})
						.catch((error) => {
							console.error("Error adding ICE candidate:", error);
						});
				}
				break;

			default:
				console.warn("Unhandled event:", event);
		}
	}

	async addAnswer(answer: RTCSessionDescriptionInit, from: string) {
		const peer = this.getPeer(from);
		if (!peer) return;

		if (!peer?.connection.currentRemoteDescription) {
			peer.connection.setRemoteDescription(answer);
		}
	}

	async createAnswer(uid, offer, from) {
		const peer = this.getPeer(from);
		if (peer?.handshaked) {
			console.log("peer already exists");
			return;
		}

		await this.createPeerConnection(uid, from)
			.then(() => {})
			.catch((error) => {
				console.error("Error creating peer connection:", error);
			});

		const peerConnection = this.rtcpeers[from]?.connection;
		if (!peerConnection) return;
		await peerConnection.setRemoteDescription(offer);

		let answer = await peerConnection.createAnswer();
		await peerConnection.setLocalDescription(answer);

		this.emit("answer", {
			answer: answer,
			uid,
		});
	}

	getPeer(uid) {
		return this.rtcpeers[uid];
	}

	handleUserLeft(uid) {
		// dispatchEvent("rtc-disconnect", MemberId);
		this.listeners("user-left2").forEach((listener) => {
			listener(uid);
		});
	}
}
