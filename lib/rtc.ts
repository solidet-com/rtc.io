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
	private rtcpeers: Record<string, RTCPeerConnection[]>;
	private testpeer?: RTCPeerConnection;
	private localStream?: MediaStream;
	private rtcId: string;
	private iceEvents = ["offer", "answer", "candidate"];
	private userEvents = ["user-joined", "user-left"];
	public remoteStream: MediaStream;

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
		this.remoteStream = new MediaStream();
		this.rtcId = String(Math.floor(Math.random() * 10000));
	}

	createPeerConnection = async (uid: any, fromId: any) => {
		if (!this.localStream) return;

		this.testpeer = new RTCPeerConnection(this.servers);

		this.localStream.getTracks().forEach((track) => {
			if (!this.testpeer) return;
			if (!this.localStream) return;

			this.testpeer.addTrack(track, this.localStream);
		});

		this.testpeer.ontrack = (event) => {
			event.streams[0].getTracks().forEach((track) => {
				this.remoteStream.addTrack(track);
			});
		};

		this.testpeer.onicecandidate = async (event) => {
			if (event.candidate) {
				this.emit("candidate", {
					candidate: event.candidate,
					uid,
				});
			}
		};
		this.listeners("stream").forEach((listener) => {
			listener({
				streamerId: fromId,
				mediaStream: this.remoteStream,
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
		this.iceEvents.forEach((eventName) => {
			this.on(eventName, (data) => {
				this._onmediastream(eventName, data);
			});
		});
	};
	async getStats() {
		if (!this.testpeer) {
			return null;
		}

		const statsMap = new Map();

		return new Promise((resolve) => {
			this.testpeer!.getStats().then((stats) => {
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

	async getSessionStats() {
		if (!this.testpeer) return null;
		return await getRTCStats(this.testpeer, {});
	}

	async getIceCandidateStats() {
		if (!this.testpeer) return null;
		return await getRTCIceCandidateStatsReport(this.testpeer);
	}

	_login() {
		this.emit("login", {
			uid: this.rtcId,
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
				console.log("biri girdi");
				this.handleUserJoined(data.uid, data.from);
				break;

			case "user-left":
				console.log("biri çıktı");
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

		if (!this.testpeer) return;

		let offer = await this.testpeer.createOffer();
		await this.testpeer.setLocalDescription(offer);
		this.emit("offer", {
			offer: offer,
			uid,
			from: fromId,
		});
	};

	async handleMessageFromPeer(event, message, uid, from) {
		switch (event) {
			case "offer":
				console.log("offfer");
				this.createAnswer(uid, message.offer, from);
				break;

			case "answer":
				console.log("answer");

				this.addAnswer(message.answer);
				break;

			case "candidate":
				console.log("candidate");
				if (this.testpeer) {
					this.testpeer
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

	async addAnswer(answer: RTCSessionDescriptionInit) {
		console.log("before addAnswer");
		if (!this.testpeer) return;
		console.log("after addAnswer");
		if (!this.testpeer.currentRemoteDescription) {
			this.testpeer.setRemoteDescription(answer);
		}
		console.log("final addAnswer");
	}

	async createAnswer(uid, offer, from) {
		await this.createPeerConnection(uid, from)
			.then(() => {})
			.catch((error) => {
				console.error("Error creating peer connection:", error);
			});

		if (!this.testpeer) return;
		await this.testpeer.setRemoteDescription(offer);

		let answer = await this.testpeer.createAnswer();
		await this.testpeer.setLocalDescription(answer);

		this.emit("answer", {
			answer: answer,
			uid,
			from,
		});
	}

	handleUserLeft(uid) {
		// dispatchEvent("rtc-disconnect", MemberId);
		this.listeners("user-left").forEach((listener) => {
			listener(uid);
		});
	}


}
