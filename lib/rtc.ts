import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers: RTCIceServer[];
}

export class Socket extends RootSocket {
	private rtcpeers: Record<string, RTCPeerConnection[]>;
	private testpeer?: RTCPeerConnection;
	private localStream?: MediaStream;
	private rtcId: string;
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

	createPeerConnection = async (MemberId: any, fromId: any) => {
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
				this.emit("message", {
					type: "candidate",
					category: "MessageFromPeer",
					candidate: event.candidate,
					MemberId,
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

		this.on("message", this._onmediastream);
	};

	_login() {
		this.emit("message", {
			category: "Login",
			type: "",
			uid: this.rtcId,
			room: "/",
		});
	}

	emit<Ev extends string>(ev: Ev, ...args: any[]): this {
		return super.emit(ev, ...args);
	}

	private _onmediastream = (data: any) => {
		if (data.category === "MemberJoined") {
			this.handleUserJoined(data.uid, data.from);
		}

		if (data.category === "MemberLeft") {
			this.handleUserLeft(data.uid);
		}

		if (data.category === "MessageFromPeer") {
			this.handleMessageFromPeer(data, data.MemberId, data.from);
		}
	};

	handleUserJoined = async (MemberId: any, fromId) => {
		this.createOffer(MemberId, fromId);
	};

	createOffer = async (MemberId, fromId) => {
		await this.createPeerConnection(MemberId, fromId);

		if (!this.testpeer) return;

		let offer = await this.testpeer.createOffer();
		await this.testpeer.setLocalDescription(offer);
		this.emit("message", {
			category: "MessageFromPeer",
			type: "offer",
			offer: offer,
			MemberId: MemberId,
		});
	};

	async handleMessageFromPeer(message, MemberId, from) {
		if (message.type == "offer") {
			this.createAnswer(MemberId, message.offer, from);
		}

		if (message.type == "answer") {
			this.addAnswer(message.answer);
		}

		if (message.type == "candidate") {
			if (this.testpeer) {
				this.testpeer
					.addIceCandidate(message.candidate)
					.then(() => {})
					.catch((error) => {
						console.error("Error adding ICE candidate:", error);
					});
			}
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

	async createAnswer(MemberId, offer, from) {
		await this.createPeerConnection(MemberId, from)
			.then(() => {})
			.catch((error) => {
				console.error("Error creating peer connection:", error);
			});

		if (!this.testpeer) return;
		await this.testpeer.setRemoteDescription(offer);

		let answer = await this.testpeer.createAnswer();
		await this.testpeer.setLocalDescription(answer);

		this.emit("message", {
			type: "answer",
			category: "MessageFromPeer",
			answer: answer,
			MemberId: MemberId,
		});
	}

	handleUserLeft(MemberId) {
		// dispatchEvent("rtc-disconnect", MemberId);
	}
}
