import { v4 as uuid } from "uuid";

export default class RTCIOStream {
	readonly id: string;
	readonly name: string;
	mediaStream: MediaStream;

	videoTransceivers: Record<string, RTCRtpTransceiver> = {};
	audioTransceivers: Record<string, RTCRtpTransceiver> = {};

	constructor(name: string, mediaStream: MediaStream);
	constructor(mediaStream: MediaStream);
	constructor(nameOrStream: string | MediaStream, mediaStream?: MediaStream) {
		if (typeof nameOrStream === "string") {
			this.id = uuid();
			this.name = nameOrStream;
			this.mediaStream = mediaStream!;
		} else {
			this.id = uuid();
			this.name = this.id;
			this.mediaStream = nameOrStream;
		}
	}

	_handleStream(peerConnection: RTCPeerConnection, socketId: string) {
		// Guard: transceivers are already wired for this peer (e.g. emit called twice)
		if (this.videoTransceivers[socketId] || this.audioTransceivers[socketId]) return;

		const videoTrack = this.mediaStream.getVideoTracks()[0];
		const audioTrack = this.mediaStream.getAudioTracks()[0];

		if (videoTrack) {
			this.videoTransceivers[socketId] = peerConnection.addTransceiver(
				videoTrack,
				{ direction: "sendonly", streams: [this.mediaStream] },
			);
		}

		if (audioTrack) {
			this.audioTransceivers[socketId] = peerConnection.addTransceiver(
				audioTrack,
				{ direction: "sendonly", streams: [this.mediaStream] },
			);
		}
	}

	pause() {
		Object.values(this.videoTransceivers).forEach(
			(t) => (t.direction = "inactive"),
		);
		Object.values(this.audioTransceivers).forEach(
			(t) => (t.direction = "inactive"),
		);
	}

	resume() {
		Object.values(this.videoTransceivers).forEach(
			(t) => (t.direction = "sendonly"),
		);
		Object.values(this.audioTransceivers).forEach(
			(t) => (t.direction = "sendonly"),
		);
	}

	mute() {
		Object.values(this.audioTransceivers).forEach(
			(t) => (t.direction = "inactive"),
		);
	}

	unmute() {
		Object.values(this.audioTransceivers).forEach(
			(t) => (t.direction = "sendonly"),
		);
	}

	stop() {
		this.mediaStream.getTracks().forEach((track) => track.stop());
		Object.values(this.videoTransceivers).forEach((t) =>
			t.sender.replaceTrack(null),
		);
		Object.values(this.audioTransceivers).forEach((t) =>
			t.sender.replaceTrack(null),
		);
		this.videoTransceivers = {};
		this.audioTransceivers = {};
	}

	replace(newStream: MediaStream) {
		const newVideo = newStream.getVideoTracks()[0] ?? null;
		const newAudio = newStream.getAudioTracks()[0] ?? null;
		Object.values(this.videoTransceivers).forEach((t) =>
			t.sender.replaceTrack(newVideo),
		);
		Object.values(this.audioTransceivers).forEach((t) =>
			t.sender.replaceTrack(newAudio),
		);
		this.mediaStream = newStream;
	}
}
