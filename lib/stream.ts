class RTCIOStream {
	private id: string;
	private mediaStream: MediaStream;

	constructor(mediaStream: MediaStream) {
		this.mediaStream = mediaStream;
	}

	replace(stream: MediaStream) {}
}
