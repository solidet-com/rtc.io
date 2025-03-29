import {
	SocketOptions as RootSocketOptions,
	Socket as RootSocket,
} from "socket.io-client";
import { Manager } from "./manager";
import { getRTCStats, getRTCIceCandidateStatsReport } from "./stats/stats.js";
import { MessagePayload } from "./payload";

export interface SocketOptions extends Partial<RootSocketOptions> {
	iceServers: RTCIceServer[];
}

type RTCPeer = {
	connection: RTCPeerConnection;
	socketId: string;
	polite: boolean;
	connectionStatus: connectionStatus;
	streams: Record<string, MediaStream>;
};

type connectionStatus = {
	makingOffer: boolean;
	ignoreOffer: boolean;
	isSettingRemoteAnswerPending: boolean;
	isActive: boolean;
};

export class Socket extends RootSocket {
	private rtcpeers: Record<string, RTCPeer>;
	private localStreams: Record<string, MediaStream>;

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
		this.localStreams = {};

		this.on("#init-rtc-offer", this.initializeConnection);
		this.on("#rtc-message", this.handleCallServiceMessage);
		/*
		this.on("#offer", this.createAnswer);
		this.on("#answer", this.addAnswer);
		this.on("#candidate", this.addIceCandidate);
        */
	}

	emit(ev, ...args): this {
		if (this.hasMediaStream(args)) {
			console.log("this.emit", ev, args);
			//TODO: implement media-stream emit
			return this;
		} else {
			return super.emit(ev, ...args);
		}
	}

	private hasMediaStream(obj: any) {
		if (Array.isArray(obj)) {
			return obj.some((item) => this.hasMediaStream(item));
		} else if (obj instanceof MediaStream) {
			return true;
		}
		for (const key in obj) {
			if (typeof obj[key] === "object") {
				if (this.hasMediaStream(obj[key])) {
					return true;
				}
			}
		}
		return false;
	}

	getPeer(id: string) {
		return this.rtcpeers[id];
	}
	async handleCallServiceMessage(payload: MessagePayload) {
		const { source } = payload;

		let peer = this.getPeer(source);
		if (!peer) peer = this.initializeConnection(payload, { polite: false });

		console.log("== peer ==", peer);
		const { description, candidate } = payload.data;
		if (description) {
			const readyForOffer =
				!peer.connectionStatus.makingOffer &&
				(peer.connection.signalingState === "stable" ||
					peer.connectionStatus.isSettingRemoteAnswerPending);

			const offerCollision =
				description.type === "offer" && !readyForOffer;

			peer.connectionStatus.ignoreOffer = !peer.polite && offerCollision;

			if (peer.connectionStatus.ignoreOffer) return;

			peer.connectionStatus.isSettingRemoteAnswerPending =
				description.type === "answer";

			if (offerCollision) {
				await Promise.all([
					peer.connection.setLocalDescription({
						type: "rollback",
					}),
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
					data: {
						description: peer.connection.localDescription,
					},
				});
			}
		} else if (candidate) {
			try {
				console.log("adding ice candidate", candidate);
				console.log(typeof candidate);
				await peer.connection.addIceCandidate(candidate);
			} catch (error) {
				if (!peer.connectionStatus.ignoreOffer) throw error;
			}
		}
	}
	/**
	 * Initializes the peer connection.
	 */
	initializeConnection(
		payload: MessagePayload,
		options: { polite: boolean } = { polite: true },
	) {
		try {
			const peer = this.createPeerConnection(payload, options);
			for (const streamKey in this.localStreams) {
				const stream = this.localStreams[streamKey];
				this.addTransceiverPeerConnection(peer.connection, stream);
			}
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error(error);
		} finally {
			return this.getPeer(payload.source);
		}
	}

	/**
	 * Attaches local media transceivers to peer connection.
	 */
	addTransceiversToPeerConnection(
		peerConnection: RTCPeerConnection,
		streams: Record<string, MediaStream>,
	) {
		for (const streamKey in streams) {
			const stream = streams[streamKey];
			this.addTransceiverPeerConnection(peerConnection, stream);
		}
	}

	/**
	 * Attaches local media transceiver to peer connection.
	 */
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

	/**
	 * Stop local media tracks of peer connection.
	 */
	stopLocalStreamTracks(localStream: MediaStream) {
		localStream.getTracks().forEach((track) => track.stop());
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

		peer.connection.ontrack = ({ transceiver, streams: [stream] }) => {
			if (transceiver.mid) {
				peer.streams[transceiver.mid] = stream;
				this.listeners("stream").forEach((listener) => {
					listener({
						id: source,
						stream: stream,
					});
				});
			}
		};

		peer.connection.oniceconnectionstatechange = () => {
			switch (peer.connection.iceConnectionState) {
				// case "connected":

				// 	break;
				case "disconnected":
					this.listeners("peer-disconnect").forEach((listener) => {
						listener({
							id: source,
						});
					});
					break;
				case "failed":
					if (peer.connection.restartIce) {
						peer.connection.restartIce();
					} else {
						//restartice
					}

					break;
				case "closed":
					console.log("ice connection closed");
					break;
				default:
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
			if (peer.connection.signalingState === "have-remote-offer") return;

			if (peer.connectionStatus.makingOffer) {
				return;
			}

			try {
				peer.connectionStatus.makingOffer = true;

				const offer = await peer.connection.createOffer();
				//@ts-ignore
				if (peer.connection.signalingState !== "have-remote-offer") {
					await peer.connection.setLocalDescription(offer);

					this.emit("#rtc-message", {
						target: peer.socketId,
						source: this.id,
						data: {
							description: peer.connection.localDescription,
						},
					});
				}
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error(error);
			} finally {
				peer.connectionStatus.makingOffer = false;
			}
		};

		return peer;
	};

	stream = (stream: MediaStream) => {
		if (!this.connected) return;

		//TODO: stop local stream tracks if stream already exists

		this.localStreams[stream.id] = stream;

		Object.values(this.rtcpeers).forEach((peer) => {
			this._stream(peer);
		});
	};

	private _stream = (peer: RTCPeer) => {
		for (const streamKey in this.localStreams) {
			const stream = this.localStreams[streamKey];
			this.addTransceiverPeerConnection(peer.connection, stream);
		}
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

	private getQueryParam(name: string | undefined = "room") {
		const urlParams = new URLSearchParams(window.location.search);
		return urlParams.get(name) || "";
	}
}