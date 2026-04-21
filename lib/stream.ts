import { v4 as uuid } from "uuid";

export class RTCIOStream {
	public id: string;
	public mediaStream: MediaStream;
	private trackChangeCallbacks: Array<(stream: MediaStream) => void> = [];

	constructor(mediaStream: MediaStream);
	constructor(id: string, mediaStream: MediaStream);
	constructor(
		idOrMediaStream: string | MediaStream,
		mediaStream?: MediaStream,
	) {
		if (idOrMediaStream instanceof MediaStream) {
			this.id = uuid();
			this.mediaStream = idOrMediaStream!;
		} else {
			this.id = idOrMediaStream;
			this.mediaStream = mediaStream as MediaStream;
		}

		// track additions and removals  triggers renegotiation
		this.mediaStream.addEventListener('addtrack', this.onTrackChange);
		this.mediaStream.addEventListener('removetrack', this.onTrackChange);
	}

	private onTrackChange = () => {
		this.trackChangeCallbacks.forEach(callback => callback(this.mediaStream));
	}

	onTrackChanged(callback: (stream: MediaStream) => void) {
		this.trackChangeCallbacks.push(callback);
		return () => {
			this.trackChangeCallbacks = this.trackChangeCallbacks.filter(cb => cb !== callback);
		};
	}

	addTrack(track: MediaStreamTrack) {
		this.mediaStream.addTrack(track);
		return this;
	}

	removeTrack(track: MediaStreamTrack) {
		this.mediaStream.removeTrack(track);
		return this;
	}

	replace(stream: MediaStream) {
		//  tracks in the stream with new ones
		const oldTracks = [...this.mediaStream.getTracks()];
		oldTracks.forEach(track => this.mediaStream.removeTrack(track));
		
		stream.getTracks().forEach(track => this.mediaStream.addTrack(track));
	}

	toJSON() {
		return `[RTCIOStream] ${this.id}`;
	}
}
