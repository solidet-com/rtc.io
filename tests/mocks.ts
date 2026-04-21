let _seq = 0;
const nextId = () => String(++_seq);

// ─── MediaStreamTrack ─────────────────────────────────────────────────────────

export class MockMediaStreamTrack {
	readonly kind: string;
	readonly id: string;
	enabled = true;

	constructor(kind: 'audio' | 'video' = 'video') {
		this.kind = kind;
		this.id = `track-${nextId()}`;
	}

	stop() {}
	clone() { return new MockMediaStreamTrack(this.kind as 'audio' | 'video'); }
}

// ─── MediaStream ──────────────────────────────────────────────────────────────

export class MockMediaStream extends EventTarget {
	readonly id: string;
	private _tracks: MockMediaStreamTrack[];
	onaddtrack: ((e: { track: MockMediaStreamTrack }) => void) | null = null;

	constructor(tracks: MockMediaStreamTrack[] = []) {
		super();
		this.id = `stream-${nextId()}`;
		this._tracks = [...tracks];
	}

	getTracks()         { return [...this._tracks]; }
	getVideoTracks()    { return this._tracks.filter(t => t.kind === 'video'); }
	getAudioTracks()    { return this._tracks.filter(t => t.kind === 'audio'); }
	getTrackById(id: string) { return this._tracks.find(t => t.id === id) ?? null; }

	addTrack(track: MockMediaStreamTrack) {
		if (this._tracks.some(t => t.id === track.id)) return;
		this._tracks.push(track);
		this.onaddtrack?.({ track });
		this.dispatchEvent(Object.assign(new Event('addtrack'), { track }));
	}

	removeTrack(track: MockMediaStreamTrack) {
		const i = this._tracks.findIndex(t => t.id === track.id);
		if (i === -1) return;
		this._tracks.splice(i, 1);
		this.dispatchEvent(Object.assign(new Event('removetrack'), { track }));
	}
}

// ─── RTCRtpSender ─────────────────────────────────────────────────────────────

class MockSender {
	track: MockMediaStreamTrack | null;

	constructor(track: MockMediaStreamTrack | null) { this.track = track; }
	async replaceTrack(t: MockMediaStreamTrack | null) { this.track = t; }
	setStreams(..._s: MockMediaStream[]) {}
}

// ─── RTCRtpTransceiver ────────────────────────────────────────────────────────

export class MockTransceiver {
	mid: string | null;
	direction: string;
	sender: MockSender;
	receiver: { track: { kind: string; id: string } };

	constructor(trackOrKind: MockMediaStreamTrack | string, init?: { direction?: string }) {
		this.mid = `mid-${nextId()}`;
		this.direction = init?.direction ?? 'sendrecv';
		const isTrack = trackOrKind instanceof MockMediaStreamTrack;
		const kind    = isTrack ? (trackOrKind as MockMediaStreamTrack).kind : trackOrKind as string;
		this.sender   = new MockSender(isTrack ? trackOrKind as MockMediaStreamTrack : null);
		this.receiver = { track: { kind, id: `recv-${nextId()}` } };
	}
}

// ─── RTCPeerConnection ────────────────────────────────────────────────────────

export class MockRTCPeerConnection {
	localDescription:  { type: string; sdp: string } | null = null;
	remoteDescription: { type: string; sdp: string } | null = null;
	signalingState:            string = 'stable';
	iceConnectionState:        string = 'new';
	connectionState:           string = 'new';

	ontrack:                    ((e: any) => void) | null = null;
	onicecandidate:             ((e: any) => void) | null = null;
	onnegotiationneeded:        (() => void) | null = null;
	oniceconnectionstatechange: (() => void) | null = null;
	onconnectionstatechange:    (() => void) | null = null;

	private _transceivers: MockTransceiver[] = [];
	private _id = nextId();

	constructor(_config?: any) {}

	async setLocalDescription(desc?: { type?: string; sdp?: string }) {
		if (desc?.type === 'rollback') {
			this.signalingState = 'stable';
			this.localDescription = null;
			return;
		}
		// Implicit SDP: offer when stable, answer when have-remote-offer
		const type = desc?.type
			?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
		this.localDescription  = { type, sdp: desc?.sdp ?? `mock-${type}-${this._id}` };
		this.signalingState    = type === 'offer' ? 'have-local-offer' : 'stable';
	}

	async setRemoteDescription(desc: { type: string; sdp?: string }) {
		// Implicit rollback — modern browser behaviour
		if (desc.type === 'offer' && this.signalingState === 'have-local-offer') {
			this.signalingState   = 'stable';
			this.localDescription = null;
		}
		this.remoteDescription = { type: desc.type, sdp: desc.sdp ?? 'remote-mock-sdp' };
		this.signalingState    = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
	}

	addTransceiver(trackOrKind: MockMediaStreamTrack | string, init?: any): MockTransceiver {
		const t = new MockTransceiver(trackOrKind, init);
		this._transceivers.push(t);
		// Async, matching real browser behaviour
		Promise.resolve().then(() => this.onnegotiationneeded?.());
		return t;
	}

	getTransceivers()              { return [...this._transceivers]; }
	async addIceCandidate(_c: any) {}
	async getStats()               { return new Map(); }
	restartIce()                   {}

	createDataChannel(_label: string) {
		Promise.resolve().then(() => this.onnegotiationneeded?.());
		return { label: _label };
	}

	close() {
		this.connectionState = 'closed';
		this.signalingState  = 'closed';
	}

	// ── Test helpers ──────────────────────────────────────────────────────────

	/** Simulates the browser firing ontrack when a remote SDP is applied. */
	simulateIncomingTrack(track: MockMediaStreamTrack, stream: MockMediaStream) {
		const transceiver = new MockTransceiver(track.kind);
		this.ontrack?.({ transceiver, track, streams: [stream] });
	}
}
