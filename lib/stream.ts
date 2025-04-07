import { v4 as uuid } from "uuid";

export class RTCIOStream {
	public id: string;
	public mediaStream: MediaStream;

	constructor(mediaStream: MediaStream);
	constructor(id: string, mediaStream: MediaStream);
	constructor(
		idOrMediaStream: string | MediaStream,
		mediaStream?: MediaStream,
	) {
		console.log(idOrMediaStream, idOrMediaStream instanceof MediaStream);
		if (idOrMediaStream instanceof MediaStream) {
			this.id = uuid();
			this.mediaStream = idOrMediaStream!;
		} else {
			this.id = idOrMediaStream;
			this.mediaStream = mediaStream as MediaStream;
		}
	}

	replace(stream: MediaStream) {}

	toJSON() {
		return `[RTCIOStream] ${this.id}`;
	}
}
