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

		// MediaStream's `addtrack` / `removetrack` events only fire when the
		// platform mutates the stream (e.g. WebRTC adds a remote track) — they
		// do *not* fire for programmatic addTrack/removeTrack. We listen anyway
		// to catch the platform-driven case, and the wrapper methods below
		// dispatch onTrackChange explicitly for the user-driven case.
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
		this.onTrackChange();
		return this;
	}

	removeTrack(track: MediaStreamTrack) {
		this.mediaStream.removeTrack(track);
		this.onTrackChange();
		return this;
	}

	/**
	 * Swaps the existing track of the same kind (audio/video) for a new one.
	 * Returns the displaced track so the caller can `.stop()` it. Use this
	 * when the user picks a different mic/cam mid-call — the library hot-swaps
	 * via `RTCRtpSender.replaceTrack` on each peer, with no renegotiation.
	 */
	replaceTrack(newTrack: MediaStreamTrack): MediaStreamTrack | null {
		const old = this.mediaStream.getTracks().find(t => t.kind === newTrack.kind) ?? null;
		if (old) this.mediaStream.removeTrack(old);
		this.mediaStream.addTrack(newTrack);
		this.onTrackChange();
		return old;
	}

	replace(stream: MediaStream) {
		const oldTracks = [...this.mediaStream.getTracks()];
		oldTracks.forEach(track => this.mediaStream.removeTrack(track));
		stream.getTracks().forEach(track => this.mediaStream.addTrack(track));
		this.onTrackChange();
	}

	toJSON() {
		return `[RTCIOStream] ${this.id}`;
	}
}
